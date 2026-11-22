# GuardBench Terraform Runbook

이 디렉터리는 [ADR 0001](../docs/decisions/0001-performance-experiment-platform.md)에 따라 네 개의 독립 Terraform root로 구성됩니다. 각 root는 동일한 S3 remote state bucket(`guardbench-terraform-state`, `ap-northeast-2`, S3 native locking)에서 독립 state 키를 사용합니다.

## Root 구성 및 의존 관계

| Root | State Key | 참조하는 상위 Root | 소유 리소스 |
| --- | --- | --- | --- |
| [`shared/`](shared/) | `shared/terraform.tfstate` | 없음 | VPC, Public/Private Subnets, IGW, NAT Gateway, VPC Endpoints, ECR (`app`, `demo_ai`), ECS Cluster, ALB Access Logs S3, GitHub OIDC Provider 및 공통 배포 Role |
| [`dev/`](dev/) | `dev/terraform.tfstate` | `shared` | Dev API·Worker ECS Service/Task Definition, Auto Scaling, Dev RDS, Dev SQS/DLQ, Public ALB, CloudFront+S3 Frontend, SSM DB Access Host, Dev SageMaker Classifier, Dev 관측성(CloudWatch/SNS) |
| [`performance-base/`](performance-base/) | `performance-base/terraform.tfstate` | `shared` | Performance RDS, Performance SQS/DLQ, Performance Internal ALB 및 Target Groups, CodeBuild Runner, Performance Results S3, 실험 전용 OIDC Role, 실험 role permissions boundary |
| [`performance-experiment/`](performance-experiment/) | `performance-experiment/terraform.tfstate` | `shared`, `performance-base` | Performance API·Worker ECS Service/Task Definition, Performance 전용 SageMaker Classifier Endpoint, Synthetic Demo AI ECS Service |

Cross-root Security Group 규칙은 해당 규칙을 소유한 하위 root(`dev`, `performance-experiment`)에서 standalone `aws_security_group_rule` 리소스로 선언하여 상위 root의 Security Group ID에 연결합니다.

## 실행 순서

`terraform_remote_state` 의존 관계에 따라 다음 순서로 초기화 및 적용합니다.

```text
terraform/shared
   ├──▶ terraform/dev
   └──▶ terraform/performance-base
           └──▶ terraform/performance-experiment
```

1. **사전 확인**
   - Terraform 1.10 이상과 `ap-northeast-2` AWS credential을 준비합니다.
   - 각 root 디렉터리의 `terraform.tfvars.example`을 복사해 `terraform.tfvars`를 작성합니다.
2. **형식 및 정적 검증 (루트 또는 각 root)**

```bash
# 저장소 루트에서 전체 HCL 포맷 확인
terraform fmt -check -recursive

# 각 root에서 backend 없이 문법·참조 검증
for root in shared dev performance-base performance-experiment; do
  (
    cd "terraform/$root"
    terraform init -backend=false -input=false
    terraform validate
  )
done
```

3. **단계별 Plan & Apply**
   - `shared` → `dev` / `performance-base` → `performance-experiment` 순서로 각 root 디렉터리에서 실행합니다.
   - 적용 전 `terraform plan -out=tfplan`으로 의도하지 않은 삭제·교체가 없는지 확인한 뒤에만 `terraform apply tfplan`을 실행합니다.

```bash
cd terraform/<root>
terraform init -input=false
terraform plan -out=tfplan
terraform apply tfplan
```

## Root별 주요 운영 경계

### `shared`

- 계정 공통 네트워크(VPC `10.1.0.0/16`, 2 AZ public/private subnets, NAT Gateway, PrivateLink VPC Endpoints)와 공통 ECS Cluster, ECR repository(`app`, `demo_ai`), ALB Access Logs S3 버킷, GitHub OIDC Provider를 관리합니다.
- 계정에 이미 `token.actions.githubusercontent.com` OIDC Provider가 존재하면 `github_oidc_provider_arn` 변수로 기존 ARN을 지정해 중복 생성을 피합니다.
- `frontend_github_actions_deploy` 및 `backend_github_actions_deploy` IAM Role 신뢰 정책을 소유하며, 실제 리소스 ARN에 대한 권한 정책은 `dev` root가 연결합니다.

### `dev`

- `guardbench-dev-app` API Service(`WORKER_ENABLED=false`)와 `guardbench-dev-worker` Worker Service(`WORKER_ENABLED=true`, Application Auto Scaling 2~4 task, `GUARDBENCH_WORKER_WORK_ITEMS_CONCURRENCY=8`)를 관리합니다.
- Task Definition의 최초 baseline은 Terraform이 생성하며, 이후 application revision 배포는 Backend GitHub Actions가 수행합니다(`lifecycle { ignore_changes = [task_definition] }`).
- Dev RDS와 Dev SQS/DLQ(`visibility_timeout_seconds = 90`, `maxReceiveCount = 5`)는 `performance-base`와 완전히 분리됩니다.
- Private RDS 접근용 SSM host(`db_access_host_enabled`)는 public IP·SSH inbound 없이 Session Manager port forwarding(`aws ssm start-session --document-name AWS-StartPortForwardingSessionToRemoteHost`)만 허용합니다.
- `sagemaker_classifier_endpoint_enabled = false`로 설정하면 과금 대상 SageMaker real-time endpoint만 제거하고 model/config/IAM 권한은 유지합니다.

### `performance-base`

- 성능 테스트 기간 동안 Dev RDS·SQS와 격리된 Performance 전용 PostgreSQL(`guardbench_perf`), Performance SQS/DLQ(`visibility_timeout_seconds = 90`), Internal Performance ALB(`/v1/chat/completions` 경로는 Demo AI target group으로 분기), 결과 보관 S3 버킷(AES256 암호화, public access 차단, `performance/results/` 30일 만료 lifecycle)을 소유합니다.
- Performance RDS의 instance class, storage, backup retention 변수는 명시적 입력으로 고정합니다.
- **CodeBuild Performance Runner**:
  - `shared`의 private subnet과 전용 Security Group(`performance_codebuild_runner_security_group_id`)에 배치하며, 내부 Performance ALB(API·Demo AI 경로)와 VPC Endpoint·S3 Gateway 및 HTTPS egress(Backend checkout, `k6` release, Python 패키지 설치)만 허용합니다.
  - Terraform `aws_codebuild_project.performance_runner`는 `NO_SOURCE`와 `file("../../codebuild/performance-runner.buildspec.yml")`로 [buildspec](../codebuild/performance-runner.buildspec.yml)을 프로젝트 정의에 직접 포함합니다. compute type(`performance_codebuild_compute_type`)과 timeout(`performance_codebuild_timeout_minutes`)은 변수로 관리합니다.
  - buildspec의 build 단계는 입력 검증, 공개 Backend 저장소(`haeinChoe/guardbench-backend`)의 40자리 commit SHA(`BACKEND_COMMIT`) checkout, `performance/k6/VERSION`의 `k6` 설치, Python 의존성 설치를 먼저 수행한 뒤 ADR 0017 CLI 인자(`--api-url`, `--target-url`, `--target-model`, 선택적 `--target-revision`, `--scenario`, `--dataset`, `--result-dir`)로 Runner를 실행합니다. Runner 실행 전 단계가 실패하면 `runner-exit-code`는 `2`입니다.
  - post_build 단계는 항상 실행되어 종료 코드(`0` PASS / `1` FAIL / `2` 오류)를 결과 디렉터리의 `runner-exit-code` 파일과 함께 `RESULT_S3_PREFIX`에 업로드하고, build는 동일한 종료 코드로 끝납니다.
- **실험 전용 GitHub OIDC Role**(`performance_experiment_github_actions_role_arn`):
  - `haeinChoe/guardbench-iac`의 `performance-experiment` GitHub environment(`sub`: `repo:haeinChoe/guardbench-iac:environment:performance-experiment`)만 신뢰합니다. 추가로 다음 조건을 모두 만족하는 토큰만 허용합니다.
    - `job_workflow_ref` = `haeinChoe/guardbench-iac/<performance_experiment_workflow_path>@<performance_experiment_workflow_ref>` (기본 `.github/workflows/performance-experiment.yml`, `refs/heads/dev`)
    - `repository_id` = `performance_experiment_github_repository_id` (기본 `1387017401`)
  - 진입점 workflow job은 `environment: performance-experiment`를 사용해야 하며, GitHub repository 설정에서 `performance-experiment` environment의 deployment branch를 `dev`로 제한해야 합니다.
  - role의 최대 세션은 10시간(36000초)입니다. workflow는 apply와 Runner build 대기를 덮는 첫 세션을 10시간으로 받고, 정리 단계 앞에서 2시간짜리 세션으로 갱신합니다.
  - 실험 IAM role은 permissions boundary(`experiment_permissions_boundary_arn`, 정책 `<project>-<environment>-perf-experiment-boundary`)를 가진 경우에만 만들거나 권한을 붙일 수 있습니다. `iam:CreateRole`, `iam:PutRolePolicy`, `iam:AttachRolePolicy`, `iam:PutRolePermissionsBoundary`는 `iam:PermissionsBoundary`가 이 boundary ARN일 때만 허용하고, `iam:DeleteRolePermissionsBoundary`와 boundary 정책 자체의 변경·삭제(`iam:CreatePolicyVersion`, `iam:SetDefaultPolicyVersion`, `iam:DeletePolicy`, `iam:DeletePolicyVersion`)는 명시적으로 Deny합니다.
  - boundary는 실험 role이 가질 수 있는 최대 권한(ECR pull, 실험 로그 그룹 쓰기, Performance RDS secret 읽기, 성능 SageMaker endpoint 호출, 성능 SQS 사용, ECS Exec 채널, Demo AI의 Bedrock 호출, SageMaker 실행 role의 모델 artifact 읽기·endpoint 로그 쓰기)입니다. `performance-experiment` root의 모든 IAM role은 `permissions_boundary`로 이 값을 받아야 합니다.
  - `performance-experiment` state 읽기·쓰기와 실험 층 자원(ECS·SageMaker·IAM PassRole 범위 제한·Logs·실험용 SG/규칙) apply/destroy, Runner CodeBuild 시작·중지·조회, 결과 S3, 성능 CloudWatch 지표·로그·SQS·RDS 조회만 허용하며 dev 자원 ARN은 포함하지 않습니다.
  - 권한은 customer managed policy 두 개(`<project>-<environment>-perf-experiment-gha-state-lifecycle`, `<project>-<environment>-perf-experiment-gha-logs-network-run`)로 나누어 role에 붙입니다. 하나로 합친 문서가 role 인라인 정책 한도(공백 제외 10,240자, 합친 문서 약 10,687자)를 넘기 때문입니다. 두 정책의 크기는 각각 5,743자와 4,944자로 managed policy 한도(6,144자) 안입니다. 권한을 추가할 때 이 크기를 다시 확인합니다.

### `performance-experiment`

- 구성 preset(`presets/<id>.tfvars`, 검증용 [`presets/validation.tfvars`](performance-experiment/presets/validation.tfvars))으로 API(`performance_api_cpu`·`performance_api_memory`·`performance_api_desired_count`)와 Worker(`performance_worker_cpu`·`performance_worker_memory`·`performance_worker_desired_count`·`performance_worker_work_items_concurrency`), 성능 전용 SageMaker(`performance_sagemaker_instance_type`·`performance_sagemaker_instance_count`), 기대 RDS 등급(`expected_performance_rds_instance_class`, 필수 입력)을 지정합니다. 구성 ID(`infrastructure_id`)는 preset 파일 이름이며 진입점이 `-var`로 전달합니다.
- Performance API·Worker Task Definition은 Terraform이 직접 소유하며 `app_image_tag`로 테스트할 Backend commit SHA 이미지를 지정합니다. API·Worker·Demo AI Service는 `wait_for_steady_state = true`로 rollout 완료까지 대기합니다.
- dev와 분리된 성능 전용 SageMaker classifier endpoint(`guardbench-<env>-performance-qwen3-4b-endpoint`)와 Synthetic Demo AI Application Target ECS Service(`demo_ai_desired_count`, `demo_ai_target_model`, 지정된 `demo_ai_bedrock_resource_arns`에 대한 `bedrock:InvokeModel` 허용)를 생성·관리합니다.
- Performance API·Worker 컨테이너에는 Internal Performance ALB 호스트명(`allowed-private-hostnames`)과 Performance RDS/SQS·전용 SageMaker endpoint 연결 정보가 주입됩니다.
- SageMaker model 이름은 접두사(`<project>-<environment>-perf-qwen3-4b-`)와 model 정의 해시 12자리로 만듭니다(`aws_sagemaker_model`은 `name_prefix`를 지원하지 않음). 정의가 바뀌면 이름이 달라져 새 model을 먼저 만든 뒤 이전 model을 삭제합니다. 이 root가 만드는 IAM role 5개(API·Worker task, exec, SageMaker 실행, Demo AI exec·task)는 모두 `performance-base`의 `experiment_permissions_boundary_arn`을 `permissions_boundary`로 가집니다.
- `infrastructure_snapshot` output으로 구성 ID, `infrastructure_revision`(40자리 소문자 hex commit SHA), 기대 capacity, 실제 AWS 자원 식별자, Runner 실행 대상(`resources.runner`: CodeBuild 프로젝트 이름, 결과 S3 버킷), `api_url`, `target` 연결 정보(`type`, `url`, `model`, `revision`)를 내보냅니다. 기반 층 RDS 등급과 실제 상태 대조는 실험 진입점이 수행합니다.
- Backend·Demo AI 이미지 저장소(`app_image_repository_url`, `demo_ai_image_repository_url`)와 SageMaker 서빙 컨테이너 이미지(`performance_sagemaker_container_image`)는 기본값(`null`)에서 기존 출처(shared ECR, 고정 DJL 이미지)를 씁니다. 로컬에서 받을 수 없는 이미지를 대체 이미지로 바꿔 파이프라인을 시험할 때만 지정합니다.

## 성능 실험 진입점과 Floci 파이프라인 테스트

- 실험 하나의 실행은 [`Performance Experiment` workflow](../.github/workflows/performance-experiment.yml)가 지휘합니다. 입력·순서·판정·결과 위치는 [성능 실험 실행 안내](../docs/performance-experiment.md)를 따릅니다.
- `scripts/performance/`의 CLI는 workflow와 테스트가 같은 코드를 씁니다. AWS 접속 정보는 boto3 기본 동작(환경 변수 `AWS_ENDPOINT_URL` 등)으로만 정해지며 코드에 에뮬레이터 분기는 없습니다. 단위 테스트: `python3 -m unittest discover -s tests/performance -t .`
- Floci 파이프라인 테스트(`tests/floci`)는 apply → 실행 전 확인 → CodeBuild buildspec 실행 → 수집·결합 → destroy를 Floci(`floci/floci:2.4.0`) 위에서 실행합니다. Docker와 Terraform이 필요합니다: `FLOCI_PIPELINE=1 python3 -m unittest tests.floci.test_pipeline -v`.
  - 더미 자격 증명과 loopback endpoint만 쓰고 `~/.aws`는 읽지 않습니다. 실제 원격 backend로 `terraform init`을 하지 않습니다.
  - Terraform의 backend·provider endpoint·`terraform_remote_state` 전환은 테스트가 임시 복사본에 쓰는 `override.tf`로만 합니다. root 코드에는 에뮬레이터 분기가 없습니다.
  - 이 테스트는 단계 순서와 결과 수집을 확인합니다. IAM 권한 충분성, GitHub OIDC 신뢰, 보안 그룹·네트워크 격리, 성능 수치는 재현하지 않으므로 첫 실제 apply에서 확인합니다.

## 보안 및 Secret 관리 원칙

- RDS 마스터 비밀번호는 AWS Secrets Manager(`manage_master_user_password = true`)로 관리하며 Terraform output이나 Task Definition 평문 환경변수에 노출하지 않습니다.
- `dev` root는 baseline Task Definition을 생성하고 Backend GitHub Actions가 application revision을 배포합니다. `performance-experiment` root는 `app_image_tag` 변수로 Task Definition을 직접 소유·적용합니다.
