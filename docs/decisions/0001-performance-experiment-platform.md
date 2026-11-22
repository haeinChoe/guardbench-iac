# 0001. 성능 실험 환경: Terraform root 분리, 실험 층 수명주기, CodeBuild 단일 진입점

> Status: APPROVED
> Owner: Infrastructure
> Last reviewed: 2026-11-22
> Canonical source: GitHub
> Origin: GitHub Issue #12

- ADR Status: ACCEPTED
- Decision date: 2026-11-22
- Related Issue: #12; Backend 측 경계 haeinChoe/guardbench-backend#37 (Backend ADR 0017)

## Context

지금은 성능 실험 한 번을 돌리려면 사람이 여러 단계를 이어 붙여야 한다. Runner 이미지를 발행하고, Terraform을 apply하고,
SSM bootstrap으로 EC2 Runner를 띄우고, 결과를 S3로 옮긴 뒤, 별도 분석 workflow를 실행한다.
Terraform root가 하나여서 성능 자원을 바꾸는 apply의 비교 대상에 dev 자원도 들어가고,
state 잠금도 하나를 같이 쓴다. SageMaker endpoint 하나를 dev와 performance가 함께 쓴다.
Performance ECS service는 task definition 변경을 무시하는데, 새 revision을 배포하는 경로가 없다.

Backend ADR 0017은 Backend가 인프라를 알지 않도록 경계를 정했다. 그래서 인프라 구성,
성능 환경의 생성·삭제, Runner 실행, 용량 확인, 인프라 지표·로그, 결과 보존, 실행 진입점은
이 저장소가 소유한다. 현재 실제로 생성된 인프라는 없다.

## Decision

### Terraform root 분리

root마다 state를 따로 두고 따로 apply한다. state는 기존 원격 state bucket에 root별 key로 저장한다.
root 사이에 필요한 값은 위쪽 root의 output을 `terraform_remote_state`로 읽는다.

| root | 담는 것 | 수명 |
| --- | --- | --- |
| `terraform/shared` | VPC, VPC endpoint, ECR, ECS cluster, GitHub OIDC provider와 공통 IAM | 상시 |
| `terraform/dev` | dev API·Worker·RDS·SQS·ALB, Frontend, dev용 SageMaker endpoint | 상시 |
| `terraform/performance-base` | 성능 RDS, 성능 SQS·DLQ, 성능 internal ALB, CodeBuild 프로젝트, 결과 S3, 실험 전용 OIDC role | 상시 (RDS는 미사용 시 정지 가능) |
| `terraform/performance-experiment` | 성능 API·Worker ECS service와 task definition, 성능 전용 SageMaker endpoint, Demo AI Target | 실험마다 생성·삭제 |

### 실험 층

- 인프라 구성은 `terraform/performance-experiment/presets/<id>.tfvars` 파일 하나다. 파일 이름이 구성 ID다.
- 구성에 들어가는 값:
  - API·Worker의 cpu, memory, desired count (API와 Worker는 서로 다른 변수)
  - Worker 동시성
  - SageMaker instance 종류·대수
  - 성능 RDS 등급
- RDS 등급은 기반 층 자원이다. 그래서 진입점이 구성 값과 실제 등급이 같은지 확인하고, 다르면 실행을 거부한다.
- 실험 층은 Terraform이 task definition까지 소유한다.
  - 테스트할 Backend 이미지(commit SHA tag)는 변수로 받는다.
  - service는 rollout 완료까지 기다린다(`wait_for_steady_state`).
  - 실험 층은 실험마다 새로 만들어지므로, dev처럼 Backend Actions가 revision을 배포하는 구조를 두지 않는다.
- 실험 층 output은 인프라 snapshot이다.
  - 구성 ID, 구성 revision(이 저장소의 commit SHA), 위 기대 capacity
  - 실제 자원 식별자, API URL, Target 연결 정보

### 단일 진입점

이 저장소의 Actions workflow 하나가 실험 하나를 처음부터 끝까지 지휘한다.

- **입력:** 인프라 구성, Backend commit, 시나리오 경로, 데이터셋 경로, Backend 이미지 tag
- **순서:**
  1. 실험 층 apply
  2. 실행 전 확인: 실험 층 output과 실제 AWS 상태를 대조하고, 성능 SQS·DLQ가 비어 있는지 확인. 불일치·조회 실패·미완료 rollout이면 부하를 시작하지 않는다.
  3. CodeBuild 실행
     - 소스는 지정한 Backend commit이다.
     - buildspec은 이 저장소가 소유한다.
     - Backend가 선언한 k6 버전을 설치한다.
     - Backend ADR 0017의 Runner CLI를 호출한다.
  4. 실행 구간의 CloudWatch 지표, ECS 로그, queue drain·DLQ를 수집하고 인프라 수준 판정을 한다.
  5. Runner 결과와 인프라 snapshot을 결합해 (W,C,T) 튜플과 최종 판정을 만든다.
     - 결과 S3에 보존하고 Step Summary에 표시한다.
     - 실패하면 확보한 자료를 보존한다.
  6. 실험 층 destroy. 실패·취소 시에도 반드시 실행하며, CodeBuild가 실행 중이면 중지한다.
- 한 번에 실험 하나만 실행한다(workflow concurrency 1).
- 실험 workflow의 AWS 권한은 실험 전용 OIDC role로 제한한다. 이 role은 실험 층 자원, CodeBuild 실행, 결과 S3, 성능 지표·로그 조회만 할 수 있다.

### 제거하는 것

다음은 진입점과 CodeBuild로 대체한다.
- EC2 Runner와 SSM bootstrap 문서
- Runner 이미지 ECR 발행 경로
- Backend 저장소용 성능 분석 read role

### 전환

- 현재 생성된 인프라가 없으므로 state를 옮기지 않고 새 root로 다시 작성한다.
- 첫 apply 전에 기존 state가 비어 있는지 읽기 전용으로 확인한다.
- 모든 apply는 결정권자의 명시 승인 후에 한다.

## Alternatives

1. **root 하나를 유지하고 스위치 변수로 성능 자원을 켜고 끈다.**
   - 변경이 가장 작다.
   - 하지만 실험 apply의 비교 대상에 dev가 들어가고, 권한과 state 잠금을 dev와 공유하므로 선택하지 않는다.
2. **Terraform workspace로 state를 나눈다.**
   - 같은 코드를 복제하는 환경에 맞는 기능이다.
   - 성격이 다른 층을 나누는 목적에는 맞지 않아 선택하지 않는다.
3. **ECS Fargate 일회성 task로 Runner를 실행한다.**
   - 기존 이미지 경로를 재사용할 수 있다.
   - 하지만 Runner를 고칠 때마다 이미지를 다시 발행해야 하고, 완료 대기와 로그 연결을 직접 만들어야 해서 선택하지 않는다.
   - CodeBuild는 소스 revision으로 바로 실행되고, Actions 연동으로 완료 대기와 로그를 제공한다.
4. **성능 환경 전체를 실험마다 생성·삭제한다.**
   - 가장 깨끗하다.
   - 하지만 RDS와 네트워크 생성 시간이 실험마다 더해져서, 기반 층과 실험 층으로 나눈다.

## Consequences

**장점**
- 인프라 구성 = preset 파일 하나이고, apply 한 번이 실제 환경이 된다.
- 기대값을 apply한 쪽이 snapshot으로 내보내므로 값의 사본이 없다.
- 비용이 큰 ECS 크기와 GPU endpoint는 실험하는 동안에만 존재한다.
- dev는 실험 apply의 비교 대상과 권한 범위에서 빠진다.

**비용과 위험**
- 성능 전용 SageMaker endpoint 때문에 실험 중에는 endpoint 비용이 dev와 별도로 든다.
- 실험마다 endpoint와 service 기동을 기다려야 한다. 시간은 아직 측정하지 않았다.
- CodeBuild는 최대 실행 시간 제한이 있어, SOAK 실행 시간을 정할 때 확인해야 한다.
- destroy가 실패하면 비용이 계속 발생하므로, 진입점이 destroy 결과를 확인하고 실패를 드러내야 한다.

**되돌리기:** 기존 단일 root는 새 root 검증 후 제거한다. 이 결정을 되돌리려면 새 ADR로 대체한다.

## Validation

- root별 `terraform fmt -check`와 `terraform validate`가 통과한다.
- 실험 층 plan이 dev root와 기반 층 자원을 포함하지 않는다.
- 진입점 workflow가 성공·측정 FAIL·실행 오류·취소 모두에서 destroy를 실행하고 결과를 확인한다.
- 실제 dev 계정에서 구성 하나로 apply → 확인 → 실행 → 결과 → destroy를 한 번 통과한다. 이 단계는 apply 승인 후에 한다.
