# 성능 실험 실행 안내

> Status: DRAFT
> Owner: Infrastructure
> Origin: GitHub Issue #17
> 근거: [ADR 0001](decisions/0001-performance-experiment-platform.md) "단일 진입점", Backend ADR 0017 "결과와 판정"

성능 실험 하나는 [`Performance Experiment`](../.github/workflows/performance-experiment.yml) workflow 한 번으로 apply부터 destroy까지 끝납니다.

## 실행 전 준비

GitHub environment `performance-experiment`에 다음을 설정합니다. 필수 reviewer를 지정해, 승인된 실행이 apply 승인이 되도록 합니다. deployment branch는 `dev`로 제한합니다.

| 종류 | 이름 | 의미 |
| --- | --- | --- |
| variable | `PERFORMANCE_EXPERIMENT_ROLE_ARN` | `performance-base`의 `performance_experiment_github_actions_role_arn` output |
| variable | `DEMO_AI_IMAGE_TAG` | 검증된 Demo AI 이미지 tag (Git SHA) |
| variable | `DEMO_AI_BEDROCK_MODEL_ID` | Demo AI가 호출하는 Bedrock model 또는 inference profile ID |
| variable | `DEMO_AI_BEDROCK_RESOURCE_ARNS` | 허용할 Bedrock ARN 목록(JSON 배열 문자열) |
| variable (선택) | `DEMO_AI_TARGET_MODEL` | Demo AI의 model 식별자. 기본값 `demo-model` |

실험 OIDC role 신뢰 조건(`job_workflow_ref`, `repository_id`)은 [Terraform runbook](../terraform/README.md)을 따릅니다. workflow 경로를 바꾸면 `performance_experiment_workflow_path`도 함께 바꿉니다.

## 입력

| 입력 | 의미 |
| --- | --- |
| `preset` | `terraform/performance-experiment/presets/<id>.tfvars`의 `<id>`. 구성 ID가 되며 `-var infrastructure_id=<id>`로 전달합니다. |
| `backend_commit` | CodeBuild가 checkout할 Backend commit (40자리 소문자 hex) |
| `scenario_path` | Backend commit 안의 시나리오 파일 경로 |
| `dataset_path` | Backend commit 안의 데이터셋 파일 경로 |
| `app_image_tag` | Performance API·Worker에 배포할 Backend 이미지 tag (Git SHA) |

IaC revision은 실행한 commit SHA(`github.sha`)를 `-var infrastructure_revision=`으로 전달합니다. workflow는 `dev` branch에서만 실행됩니다.

## 순서

1. 입력 검증, `terraform init`, `terraform apply`
2. `infrastructure_snapshot` output을 파일로 저장
3. 실행 전 확인(`scripts/performance/preflight.ts`): ECS service(상태, desired·running·pending, rollout 완료, task definition, cpu·memory, Worker 동시성), RDS 등급·상태, SageMaker endpoint(`DescribeEndpoint`로 InService와 endpoint config 이름, `DescribeEndpointConfig`로 variant 이름·instance 종류·`InitialInstanceCount`), 성능 SQS·DLQ가 비어 있음. 불일치·조회 실패·미완료 rollout이면 부하를 시작하지 않습니다.
4. CodeBuild 실행(`scripts/performance/codebuild.ts start/wait`): buildspec 환경 변수를 override로 전달하고 완료까지 기다리며 build 로그를 출력합니다. 대기 중 `BatchGetBuilds`가 일시 오류(throttling, 5xx, 네트워크·timeout, SDK가 재시도 가능으로 표시한 오류)로 실패하면 poll 간격만큼 쉬고 다시 조회하며, 연속 5회까지 허용하고 성공하면 횟수를 0으로 되돌립니다. 권한·입력 오류(AccessDenied 계열, ValidationException, InvalidInputException)와 build 없음은 바로 실패합니다. 재시도 중에도 전체 대기 시간 제한을 지킵니다. 타임아웃이나 취소면 build를 중지합니다.
5. Runner 결과 내려받기(`scripts/performance/s3results.ts`), 인프라 증거 수집(`scripts/performance/collect.ts`): 큐 드레인(최대 5분) 뒤 build 종료 후 3분(`--metrics-settle-seconds`, 기본 180)이 될 때까지 기다린 다음 그 시각까지의 지표를 조회합니다.
6. 결과 결합(`scripts/performance/combine.ts`)과 Step Summary, 결과 S3 보존
7. `terraform destroy`(apply를 시도했다면 항상, 실패·취소 포함), 삭제 확인(`scripts/performance/verify_destroyed.ts`)
8. 마지막 단계(`scripts/performance/gate.ts`)가 apply·최종 판정·destroy·삭제 확인 중 하나라도 통과하지 못했으면 job을 실패시킵니다. `final.json`이 없거나 읽을 수 없는 경우와 건너뛴 단계, 취소된 단계도 통과로 보지 않습니다.

### 시간 계약

| 구간 | 분 |
| --- | --- |
| job timeout | 600 |
| 　Runner build 대기 (`--timeout-seconds 29100`) | 485 |
| 　나머지 | 115 |
| 　　준비 (checkout, Node, `npm ci`, Terraform, 자격 증명, init, snapshot, 실행 전 확인, build 시작) | 8 |
| 　　`terraform apply` (step timeout) | 45 |
| 　　큐 드레인 | 최대 5 |
| 　　지표 settle | 3 |
| 　　결과 내려받기, 결합, 기록, 업로드 | 4 |
| 　　`terraform destroy` (step timeout, 2회 시도 포함) | 40 |
| 　　삭제 확인 (step timeout) | 5 |
| 　　여유 | 5 |

- CodeBuild project timeout은 최대 480분(`performance_codebuild_timeout_minutes`의 상한)이라 대기 485분보다 짧습니다. build는 CodeBuild 쪽에서 끝나거나 timeout된 뒤에 대기가 끝납니다.
- 첫 자격 증명은 36000초(600분)이고 configure 단계부터 셉니다. configure는 job이 시작되고 준비 단계 일부가 끝난 뒤 실행되므로 이 세션은 job timeout보다 몇 분 늦게 만료됩니다. job timeout으로 취소된 뒤 이어지는 정리(destroy 최대 40분)는 이 세션이 끝난 뒤까지 걸릴 수 있어서, 정리 단계(build 중지, 결과 내려받기, 수집, 기록, destroy, 삭제 확인) 앞에서 2시간짜리 새 세션으로 갱신합니다. 갱신이 실패해도 destroy는 기존 자격 증명으로 계속 시도합니다.
- 이 숫자는 workflow 파일 상단 주석과 `tests/performance/workflow-contract.test.ts`가 같은 값으로 고정합니다.

한 번에 실험 하나만 실행합니다(concurrency group 하나). 새 실행은 진행 중인 실행을 취소하지 않고 기다립니다. 같은 group에서 기다리는(pending) 실행은 최신 1개만 남고, 그보다 먼저 기다리던 실행은 취소됩니다. 실행을 취소하면 CodeBuild 중지와 destroy 단계가 실행됩니다. GitHub의 취소 후 정리 시간 안에 destroy가 끝나지 않으면 남은 자원을 확인하고 `terraform destroy`를 다시 실행해야 합니다.

SageMaker 대수는 endpoint config의 `InitialInstanceCount`로 확인합니다. 이 IaC에는 SageMaker autoscaling이 없어서 InService endpoint의 현재 대수가 설정값과 같기 때문입니다. autoscaling을 추가하면 이 검사를 `DescribeEndpoint`의 현재 인스턴스 수(`ProductionVariants[].CurrentInstanceCount`) 검사로 바꿔야 합니다.

## 판정

- 앱 수준 판정은 Runner 종료 코드입니다. `0` PASS, `1` 측정 FAIL, `2` 실행 오류. `runner-exit-code`가 없거나 읽을 수 없거나 0·1·2가 아니면 `2`로 처리합니다. 종료 코드 0·1인데 `result.json`이 없으면 오류(2)입니다.
- 종료 코드 0은 CodeBuild build가 `SUCCEEDED`일 때만 PASS로 인정합니다. build 상태가 `SUCCEEDED`가 아니거나, 대기가 시간 초과로 끝났거나, build 요약이 없어 상태를 확인할 수 없으면 Runner를 오류(2)로 처리하고 이유를 남깁니다. 종료 코드 1(측정 FAIL)은 build가 `FAILED`로 끝나는 것이 정상이므로 build 상태를 확인하지 않습니다.
- 인프라 수준 판정은 실행 구간 뒤 성능 SQS가 비워지고(최대 5분 대기) DLQ가 비어 있으며 증거를 모두 읽을 수 있을 때 PASS입니다. 큐가 비지 않거나 DLQ에 메시지가 있으면 FAIL, 증거를 읽지 못하면 ERROR입니다. ECS·RDS·SageMaker 자원 사용률은 기록하며 판정하지 않습니다. 사용률 기준은 아직 정해지지 않았습니다. CloudWatch는 지표를 게시하기까지 지연이 있어 build 종료 후 3분 뒤까지의 지표만 조회하므로, 그보다 늦게 게시되는 datapoint는 빠질 수 있습니다.
- 최종 판정은 둘이 모두 PASS일 때만 PASS입니다. 하나라도 ERROR면 ERROR, 아니면 하나라도 FAIL이면 FAIL입니다. 실행 전 확인에 실패하면 Runner를 시작하지 않고 ERROR(`stage: preflight`)입니다.
- 튜플 (W, C, T): W는 snapshot의 Worker 동시성, C와 T는 Runner `result.json`의 `tuple.concurrent_test_runs`와 `tuple.test_case_count`입니다.

## 결과 위치

결과 S3 버킷의 `performance/results/<preset>/<run id>/` 아래에 보존합니다(30일 후 만료). `<run id>`는 `<github run id>-<attempt>`입니다.

| 경로 | 내용 |
| --- | --- |
| `runner/` | CodeBuild가 올린 Runner 산출물(`result.json`, `report.md`, `failure.json`, `runner-exit-code` 등) |
| `experiment/` | snapshot, 실행 전 확인, build 요약, 인프라 증거, ECS 로그 표본, 최종 판정(`final.json`), Step Summary |

같은 파일은 workflow artifact `performance-experiment-<run id>-<attempt>`로도 올라갑니다. artifact는 7일 보관하고, 원본은 결과 S3에 30일 남습니다.

## 첫 실제 apply 전 확인

Floci 테스트가 재현하지 않는 항목입니다. 첫 실제 실행 전후에 확인합니다.

- `performance-base`를 먼저 apply해 실험 OIDC role의 `max_session_duration` 36000이 반영되어야 합니다. 반영되지 않으면 첫 자격 증명 단계가 실패합니다.
- job timeout으로 취소될 때 `always()` 정리 단계(build 중지, 기록, destroy, 삭제 확인)가 얼마나 실행되는지 확인합니다.
- ECS 로그 표본(`ecs-logs.json`)에 요청 본문이나 secret이 들어가지 않는지 확인합니다. 이 파일은 결과 S3와 workflow artifact에 올라갑니다.
- IAM 권한 충분성, GitHub OIDC 신뢰, 보안 그룹·네트워크 격리, 성능 수치, CodeBuild 로그 읽기(`GetLogEvents`)를 확인합니다.

## Floci 파이프라인 테스트

`tests/floci`는 workflow 파일의 step과 `if` 조건을 그대로 읽어(`tests/performance/workflow.ts`) 같은 순서·같은 조건으로 같은 CLI를 Floci(`floci/floci:2.4.0`) 위에서 실행합니다. step이 실패하면 workflow처럼 뒤의 `always()` 단계(destroy, 삭제 확인, 마지막 판정)가 이어서 실행되고, 마지막 판정도 `gate.ts`가 합니다. 실행 중 예외가 나면 처음 난 오류를 던지고, 이어서 난 오류(예: destroy 실패)는 그 메시지 뒤에 덧붙이며 `logs/errors.log`에 모두 남깁니다. workflow의 조건 자체는 `tests/performance/workflow-contract.test.ts`가 고정합니다. 실행: `npm ci` 뒤 `npm run test:floci` (Docker와 Terraform 필요). PR CI의 `floci-pipeline` job이 같은 명령을 실행합니다.

검증하는 경로는 Runner PASS(0), 측정 FAIL(1), 실행 오류(2), 실행 전 확인 실패입니다. 각 경로에서 Runner 결과와 `runner-exit-code`(실행 전 확인 실패는 Runner를 시작하지 않음), 최종 판정, 결과 S3 기록을 확인하고, destroy 뒤 state와 실험 층 자원(ECS service·task definition, SageMaker endpoint·config·model, 로그 그룹, IAM role, 보안 그룹, 컨테이너)이 남지 않았는지 테스트가 독립적으로 확인합니다.

### 택한 방식

- 이미지는 digest로 고정합니다(`floci/floci:2.4.0@sha256:5ee85db6…`, `python:3.11-slim@sha256:07d48240…`). CodeBuild 대체 이미지의 `awscli`는 1.46.3으로 고정합니다. 이 이미지는 AWS CLI v1(pip)이고 실제 CodeBuild 이미지는 v2지만, buildspec은 `aws s3 cp`만 써서 영향이 없습니다.
- 정리와 남은 자원 검사는 이 실행의 Floci로 한정합니다. Floci는 `FLOCI_DOCKER_RESOURCE_NAMESPACE`를 받으면 만드는 모든 컨테이너와 볼륨(ECS, SageMaker, RDS, ECR, CodeBuild)에 `floci_namespace=<namespace>` label을 붙입니다. harness는 실행마다 새 namespace를 주고 이 label이 붙은 것만 지웁니다. 다른 Floci나 같은 호스트의 다른 컨테이너는 건드리지 않습니다.
- `performance-base` apply 뒤 state에서 실험 OIDC managed policy 두 개와 permissions boundary의 렌더링된 JSON을 읽어 공백을 뺀 길이가 6144자(managed policy 한도) 이하인지 확인합니다.
- `shared`와 `performance-base`는 실제 root를 Floci에 그대로 apply합니다. NAT, VPC endpoint, ELB, RDS, CodeBuild 프로젝트까지 Floci가 받아주므로 fixture state로 대체하지 않았습니다.
- Terraform의 backend(Floci S3, `use_lockfile`), provider endpoint, `terraform_remote_state`는 임시 복사본에 쓰는 `override.tf`로만 전환합니다. root 코드와 workflow에 Floci 분기는 없습니다. Terraform 실행에는 `AWS_ENDPOINT_URL`도 넣습니다. AWS provider는 이 환경 변수를 override가 나열하지 않은 서비스에도 적용합니다(provider 5.100.0 문서, `terraform init`이 `~> 5.0`에서 설치하는 버전). 이 변수를 무시하는 provider가 설치되면 목록 밖 서비스는 실제 AWS endpoint로 가고 더미 자격 증명으로 거부되어 테스트가 실패합니다. 스크립트는 `AWS_ENDPOINT_URL`(loopback IP 주소라서 SDK가 path-style S3 URL을 쓰며 `<bucket>.localhost` 이름 해석에 기대지 않습니다)과 더미 자격 증명만으로 Floci에 닿습니다.
- 받을 수 없는 이미지는 변수로 stub 이미지를 지정합니다(`app_image_repository_url`, `demo_ai_image_repository_url`, `performance_sagemaker_container_image`, `performance_codebuild_image`). 하나의 stub 이미지가 Backend API·Demo AI 대역(`/health`, 테스트 스위트 생성, 채팅 응답)을 모두 제공하고, SageMaker가 시작하는 `serve` 명령도 포함합니다.
- Runner는 Backend 저장소 fixture(40자리 commit SHA, 시나리오별 `PASS`/`FAIL`/`ERROR`)를 CodeBuild 이미지에 넣고 `BACKEND_REPO_URL` override로 가리킵니다. 이 Runner는 ADR 0017 CLI와 결과 파일 형식을 따르는 대역이며 실제 Runner가 아닙니다. 실제 Runner는 Backend 저장소의 mock E2E가 검증합니다. k6는 buildspec이 GitHub에서 내려받으므로 네트워크가 필요합니다.

### 결정

- **Floci ELB v2 전달:** CodeBuild 컨테이너와 같은 방식(Floci DNS)으로 ALB 주소를 호출하면 요청이 ECS stub 컨테이너로 전달됩니다(`/health`, `/v1/chat/completions` 모두 200). 호스트에서는 ALB 이름도 컨테이너 IP도 닿지 않지만 Runner는 컨테이너 안에서 실행됩니다. 그래서 Runner 대상 URL을 ECS 컨테이너 직접 주소로 바꾸지 않고 스냅샷의 `api_url`과 `target.url`을 그대로 씁니다.
- **SageMaker 확인:** Floci의 `DescribeEndpoint`는 `ProductionVariants`를 돌려주지 않습니다. 실행 전 확인은 `DescribeEndpoint`로 InService와 endpoint config 이름을, `DescribeEndpointConfig`로 variant 이름·instance 종류·`InitialInstanceCount`를 확인합니다. 환경별 분기는 없습니다. 이 IaC에는 SageMaker autoscaling이 없어서 InService endpoint의 현재 대수가 설정값과 같습니다. autoscaling을 추가하면 이 검사를 `DescribeEndpoint`의 현재 인스턴스 수(`ProductionVariants[].CurrentInstanceCount`) 검사로 바꿔야 합니다.
- **buildspec 셸:** Floci CodeBuild는 `env.shell: bash`를 무시하고 `sh`(dash)로 명령을 실행합니다. 실제 CodeBuild는 `bash`를 씁니다. buildspec의 build·post_build 스크립트는 파일로 쓴 뒤 `bash`로 명시 실행해서 어느 셸에서도 같게 동작합니다.
- **CodeBuild 로그:** Floci는 build 로그 스트림은 만들지만 CloudWatch Logs에 이벤트를 쓰지 않습니다. 테스트는 로그가 비어 있어도 실패로 보지 않습니다. 실제 AWS에서는 `BatchGetBuilds`가 알려주는 로그 그룹·스트림(`/codebuild/<project>`)을 `scripts/performance/codebuild.ts wait`가 `GetLogEvents`로 읽어 출력합니다. 실험 OIDC role은 이 로그 그룹의 `GetLogEvents`·`FilterLogEvents`를 허용합니다. 이 경로는 단위 테스트(로그 출력, 로그 없음에도 wait 지속)로만 확인했고 실제 AWS에서 읽는 동작은 첫 실제 apply에서 확인합니다.

### 한계

IAM 권한 충분성, GitHub OIDC 신뢰, 보안 그룹·네트워크 격리, 성능 수치는 Floci가 재현하지 않습니다. 첫 실제 apply에서 확인합니다. Floci의 CloudWatch 지표는 비어 있어, 지표 수집은 "읽기 성공, 데이터 없음"까지만 확인합니다.
