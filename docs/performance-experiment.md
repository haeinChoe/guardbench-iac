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
4. CodeBuild 실행(`scripts/performance/codebuild.ts start/wait`): buildspec 환경 변수를 override로 전달하고 완료까지 기다리며 build 로그를 출력합니다. 타임아웃이나 취소면 build를 중지합니다.
5. Runner 결과 내려받기(`scripts/performance/s3results.ts`), 인프라 증거 수집(`scripts/performance/collect.ts`)
6. 결과 결합(`scripts/performance/combine.ts`)과 Step Summary, 결과 S3 보존
7. `terraform destroy`(apply를 시도했다면 항상, 실패·취소 포함), 삭제 확인(`scripts/performance/verify_destroyed.ts`)
8. 마지막 단계가 apply·최종 판정·destroy·삭제 확인 중 하나라도 통과하지 못했으면 job을 실패시킵니다.

자격 증명은 두 번 받습니다. 첫 세션은 apply와 Runner build 대기 전체를 덮도록 10시간(job timeout과 같음)으로 받고, 정리 단계(build 중지, 결과 내려받기, 수집, 기록, destroy, 삭제 확인) 앞에서 2시간짜리 새 세션으로 갱신합니다. 갱신이 실패해도 destroy는 기존 자격 증명으로 계속 시도합니다.

한 번에 실험 하나만 실행합니다(concurrency group 하나, 대기 중인 실행은 취소하지 않음). 실행을 취소하면 CodeBuild 중지와 destroy 단계가 실행됩니다. GitHub의 취소 후 정리 시간 안에 destroy가 끝나지 않으면 남은 자원을 확인하고 `terraform destroy`를 다시 실행해야 합니다.

SageMaker 대수는 endpoint config의 `InitialInstanceCount`로 확인합니다. 이 IaC에는 SageMaker autoscaling이 없어서 InService endpoint의 현재 대수가 설정값과 같기 때문입니다. autoscaling을 추가하면 이 검사를 `DescribeEndpoint`의 현재 인스턴스 수(`ProductionVariants[].CurrentInstanceCount`) 검사로 바꿔야 합니다.

## 판정

- 앱 수준 판정은 Runner 종료 코드입니다. `0` PASS, `1` 측정 FAIL, `2` 실행 오류. `runner-exit-code`가 없거나 읽을 수 없거나 0·1·2가 아니면 `2`로 처리합니다. 종료 코드 0·1인데 `result.json`이 없으면 오류(2)입니다.
- 인프라 수준 판정은 실행 구간 뒤 성능 SQS가 비워지고(최대 5분 대기) DLQ가 비어 있으며 증거를 모두 읽을 수 있을 때 PASS입니다. 큐가 비지 않거나 DLQ에 메시지가 있으면 FAIL, 증거를 읽지 못하면 ERROR입니다. ECS·RDS·SageMaker 자원 사용률은 기록하며 판정하지 않습니다. 사용률 기준은 아직 정해지지 않았습니다.
- 최종 판정은 둘이 모두 PASS일 때만 PASS입니다. 하나라도 ERROR면 ERROR, 아니면 하나라도 FAIL이면 FAIL입니다. 실행 전 확인에 실패하면 Runner를 시작하지 않고 ERROR(`stage: preflight`)입니다.
- 튜플 (W, C, T): W는 snapshot의 Worker 동시성, C와 T는 Runner `result.json`의 `tuple.concurrent_test_runs`와 `tuple.test_case_count`입니다.

## 결과 위치

결과 S3 버킷의 `performance/results/<preset>/<run id>/` 아래에 보존합니다(30일 후 만료). `<run id>`는 `<github run id>-<attempt>`입니다.

| 경로 | 내용 |
| --- | --- |
| `runner/` | CodeBuild가 올린 Runner 산출물(`result.json`, `report.md`, `failure.json`, `runner-exit-code` 등) |
| `experiment/` | snapshot, 실행 전 확인, build 요약, 인프라 증거, ECS 로그 표본, 최종 판정(`final.json`), Step Summary |

같은 파일은 workflow artifact `performance-experiment-<run id>-<attempt>`로도 올라갑니다.

## Floci 파이프라인 테스트

`tests/floci`는 workflow와 같은 순서로 같은 CLI를 Floci(`floci/floci:2.4.0`) 위에서 실행합니다. 실행: `npm ci` 뒤 `npm run test:floci` (Docker와 Terraform 필요). PR CI의 `floci-pipeline` job이 같은 명령을 실행합니다.

검증하는 경로는 Runner PASS(0), 측정 FAIL(1), 실행 오류(2), 실행 전 확인 실패입니다. 각 경로에서 Runner 결과와 `runner-exit-code`(실행 전 확인 실패는 Runner를 시작하지 않음), 최종 판정, 결과 S3 기록을 확인하고, destroy 뒤 state와 실험 층 자원(ECS service·task definition, SageMaker endpoint·config·model, 로그 그룹, IAM role, 보안 그룹, 컨테이너)이 남지 않았는지 테스트가 독립적으로 확인합니다.

### 택한 방식

- `shared`와 `performance-base`는 실제 root를 Floci에 그대로 apply합니다. NAT, VPC endpoint, ELB, RDS, CodeBuild 프로젝트까지 Floci가 받아주므로 fixture state로 대체하지 않았습니다.
- Terraform의 backend(Floci S3, `use_lockfile`), provider endpoint, `terraform_remote_state`는 임시 복사본에 쓰는 `override.tf`로만 전환합니다. root 코드와 workflow에 Floci 분기는 없습니다. 스크립트는 `AWS_ENDPOINT_URL`(loopback IP 주소라서 SDK가 path-style S3 URL을 쓰며 `<bucket>.localhost` 이름 해석에 기대지 않습니다)과 더미 자격 증명만으로 Floci에 닿습니다.
- 받을 수 없는 이미지는 변수로 stub 이미지를 지정합니다(`app_image_repository_url`, `demo_ai_image_repository_url`, `performance_sagemaker_container_image`, `performance_codebuild_image`). 하나의 stub 이미지가 Backend API·Demo AI 대역(`/health`, 테스트 스위트 생성, 채팅 응답)을 모두 제공하고, SageMaker가 시작하는 `serve` 명령도 포함합니다.
- Runner는 Backend 저장소 fixture(40자리 commit SHA, 시나리오별 `PASS`/`FAIL`/`ERROR`)를 CodeBuild 이미지에 넣고 `BACKEND_REPO_URL` override로 가리킵니다. 이 Runner는 ADR 0017 CLI와 결과 파일 형식을 따르는 대역이며 실제 Runner가 아닙니다. 실제 Runner는 Backend 저장소의 mock E2E가 검증합니다. k6는 buildspec이 GitHub에서 내려받으므로 네트워크가 필요합니다.

### 결정

- **Floci ELB v2 전달:** CodeBuild 컨테이너와 같은 방식(Floci DNS)으로 ALB 주소를 호출하면 요청이 ECS stub 컨테이너로 전달됩니다(`/health`, `/v1/chat/completions` 모두 200). 호스트에서는 ALB 이름도 컨테이너 IP도 닿지 않지만 Runner는 컨테이너 안에서 실행됩니다. 그래서 Runner 대상 URL을 ECS 컨테이너 직접 주소로 바꾸지 않고 스냅샷의 `api_url`과 `target.url`을 그대로 씁니다.
- **SageMaker 확인:** Floci의 `DescribeEndpoint`는 `ProductionVariants`를 돌려주지 않습니다. 실행 전 확인은 `DescribeEndpoint`로 InService와 endpoint config 이름을, `DescribeEndpointConfig`로 variant 이름·instance 종류·`InitialInstanceCount`를 확인합니다. 환경별 분기는 없습니다. 이 IaC에는 SageMaker autoscaling이 없어서 InService endpoint의 현재 대수가 설정값과 같습니다. autoscaling을 추가하면 이 검사를 `DescribeEndpoint`의 현재 인스턴스 수(`ProductionVariants[].CurrentInstanceCount`) 검사로 바꿔야 합니다.
- **buildspec 셸:** Floci CodeBuild는 `env.shell: bash`를 무시하고 `sh`(dash)로 명령을 실행합니다. 실제 CodeBuild는 `bash`를 씁니다. buildspec의 build·post_build 스크립트는 파일로 쓴 뒤 `bash`로 명시 실행해서 어느 셸에서도 같게 동작합니다.
- **CodeBuild 로그:** Floci는 build 로그 스트림은 만들지만 CloudWatch Logs에 이벤트를 쓰지 않습니다. 테스트는 로그가 비어 있어도 실패로 보지 않습니다. 실제 AWS에서는 `BatchGetBuilds`가 알려주는 로그 그룹·스트림(`/codebuild/<project>`)을 `scripts/performance/codebuild.ts wait`가 `GetLogEvents`로 읽어 출력합니다. 실험 OIDC role은 이 로그 그룹의 `GetLogEvents`·`FilterLogEvents`를 허용합니다. 이 경로는 단위 테스트(로그 출력, 로그 없음에도 wait 지속)로만 확인했고 실제 AWS에서 읽는 동작은 첫 실제 apply에서 확인합니다.

### 한계

IAM 권한 충분성, GitHub OIDC 신뢰, 보안 그룹·네트워크 격리, 성능 수치는 Floci가 재현하지 않습니다. 첫 실제 apply에서 확인합니다. Floci의 CloudWatch 지표는 비어 있어, 지표 수집은 "읽기 성공, 데이터 없음"까지만 확인합니다.
