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
3. 실행 전 확인(`scripts.performance.preflight`): ECS service(상태, desired·running·pending, rollout 완료, task definition, cpu·memory, Worker 동시성), RDS 등급·상태, SageMaker endpoint(상태, variant, 대수, instance 종류), 성능 SQS·DLQ가 비어 있음. 불일치·조회 실패·미완료 rollout이면 부하를 시작하지 않습니다.
4. CodeBuild 실행(`scripts.performance.codebuild start/wait`): buildspec 환경 변수를 override로 전달하고 완료까지 기다리며 build 로그를 출력합니다. 타임아웃이나 취소면 build를 중지합니다.
5. Runner 결과 내려받기(`scripts.performance.s3results`), 인프라 증거 수집(`scripts.performance.collect`)
6. 결과 결합(`scripts.performance.combine`)과 Step Summary, 결과 S3 보존
7. `terraform destroy`(apply를 시도했다면 항상, 실패·취소 포함), 삭제 확인(`scripts.performance.verify_destroyed`)
8. 마지막 단계가 apply·최종 판정·destroy·삭제 확인 중 하나라도 통과하지 못했으면 job을 실패시킵니다.

한 번에 실험 하나만 실행합니다(concurrency group 하나, 대기 중인 실행은 취소하지 않음). 실행을 취소하면 CodeBuild 중지와 destroy 단계가 실행됩니다. GitHub의 취소 후 정리 시간 안에 destroy가 끝나지 않으면 남은 자원을 확인하고 `terraform destroy`를 다시 실행해야 합니다.

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
