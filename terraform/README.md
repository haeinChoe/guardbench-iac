# GuardBench Terraform Runbook

이 디렉터리는 [ADR 0001](../docs/decisions/0001-performance-experiment-platform.md)에 따라 네 개의 독립 Terraform root로 구성됩니다. 각 root는 동일한 S3 remote state bucket(`guardbench-terraform-state`, `ap-northeast-2`, S3 native locking)에서 독립 state 키를 사용합니다.

## Root 구성 및 의존 관계

| Root | State Key | 참조하는 상위 Root | 소유 리소스 |
| --- | --- | --- | --- |
| [`shared/`](shared/) | `shared/terraform.tfstate` | 없음 | VPC, Public/Private Subnets, IGW, NAT Gateway, VPC Endpoints, ECR (`app`, `demo_ai`), ECS Cluster, ALB Access Logs S3, GitHub OIDC Provider 및 공통 배포 Role |
| [`dev/`](dev/) | `dev/terraform.tfstate` | `shared` | Dev API·Worker ECS Service/Task Definition, Auto Scaling, Dev RDS, Dev SQS/DLQ, Public ALB, CloudFront+S3 Frontend, SSM DB Access Host, Dev SageMaker Classifier, Dev 관측성(CloudWatch/SNS) |
| [`performance-base/`](performance-base/) | `performance-base/terraform.tfstate` | `shared` | Performance RDS, Performance SQS/DLQ, Performance Internal ALB 및 Target Groups, Performance Results S3 |
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

- 성능 테스트 기간 동안 Dev RDS·SQS와 격리된 Performance 전용 PostgreSQL(`guardbench_perf`), Performance SQS/DLQ(`visibility_timeout_seconds = 90`), Internal Performance ALB(`/v1/chat/completions` 경로는 Demo AI target group으로 분기), 결과 보관 S3 버킷(완료 결과 30일 만료)을 소유합니다.
- Performance RDS의 instance class, storage, backup retention 변수는 명시적 입력으로 고정합니다.

### `performance-experiment`

- 구성 preset(`presets/<id>.tfvars`, 검증용 [`presets/validation.tfvars`](performance-experiment/presets/validation.tfvars))으로 `infrastructure_id`, API(`performance_api_cpu`·`performance_api_memory`·`performance_api_desired_count`)와 Worker(`performance_worker_cpu`·`performance_worker_memory`·`performance_worker_desired_count`·`performance_worker_work_items_concurrency`), 성능 전용 SageMaker(`performance_sagemaker_instance_type`·`performance_sagemaker_instance_count`), 기대 RDS 등급(`expected_performance_rds_instance_class`)을 지정합니다.
- Performance API·Worker Task Definition은 Terraform이 직접 소유하며 `app_image_tag`로 테스트할 Backend commit SHA 이미지를 지정합니다. API·Worker·Demo AI Service는 `wait_for_steady_state = true`로 rollout 완료까지 대기합니다.
- dev와 분리된 성능 전용 SageMaker classifier endpoint(`guardbench-<env>-performance-qwen3-4b-endpoint`)와 Synthetic Demo AI Application Target ECS Service(`demo_ai_desired_count`, `demo_ai_target_model`, 지정된 `demo_ai_bedrock_resource_arns`에 대한 `bedrock:InvokeModel` 허용)를 생성·관리합니다.
- Performance API·Worker 컨테이너에는 Internal Performance ALB 호스트명(`allowed-private-hostnames`)과 Performance RDS/SQS·전용 SageMaker endpoint 연결 정보가 주입됩니다.
- `infrastructure_snapshot` output으로 구성 ID, `infrastructure_revision`(40자리 소문자 hex commit SHA), 기대 capacity, 실제 AWS 자원 식별자, `api_url`, `target` 연결 정보(`type`, `url`, `model`, `revision`)를 내보냅니다. 기반 층 RDS 등급과 실제 상태 대조는 실험 진입점이 수행합니다.

## 보안 및 Secret 관리 원칙

- RDS 마스터 비밀번호는 AWS Secrets Manager(`manage_master_user_password = true`)로 관리하며 Terraform output이나 Task Definition 평문 환경변수에 노출하지 않습니다.
- `dev` root는 baseline Task Definition을 생성하고 Backend GitHub Actions가 application revision을 배포합니다. `performance-experiment` root는 `app_image_tag` 변수로 Task Definition을 직접 소유·적용합니다.
