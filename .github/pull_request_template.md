<!--
초안 리뷰에는 Draft PR을 사용해 주세요.
PR은 dev로 보냅니다. main은 릴리스 때만 변경합니다.
Closes #는 Issue를 종료하고 Refs #는 관련 Issue를 연결합니다.
Issue가 없는 예외 작업은 이유를 아래에 적어주세요.
해당 없는 항목은 지우지 말고 "해당 없음"과 이유를 적습니다.
-->

## 관련 Issue

Closes # / Refs # / 해당 없음 — 사유:

## 결과

<!-- 해결한 문제와 리뷰어가 알아야 할 결과를 먼저 씁니다. -->

-

## 변경과 Non-Goals

영향 root:

- [ ] terraform/shared
- [ ] terraform/dev
- [ ] terraform/performance-base
- [ ] terraform/performance-experiment (presets 포함)
- [ ] workflow·scripts (.github/workflows, scripts, tests, buildspec)
- [ ] 문서만

<!-- 변경한 resource, module, IAM, network, workflow 또는 script와 제외한 인접 영역을 적습니다. -->

-

## 인프라 영향

<!-- 영향이 없으면 "없음"과 근거(AWS 호출·plan·apply 여부)를 적습니다. -->

| 항목 | 요약 |
| --- | --- |
| Plan 예상치(add/change/destroy) | 계정이 없으면 "미실행 — 사유" |
| Terraform state 또는 resource 교체 | |
| IAM 정책 크기 | managed policy 6,144자(공백 제외) 한도 대비 변경 후 크기와 여유. IAM 변경이 없으면 "없음" |
| Permissions boundary | 실험 IAM role의 boundary 부착과 boundary 정책 변경 여부. 해당 없으면 "없음" |
| 네트워크 또는 보안 | |
| AWS 비용과 Region | |
| 데이터, 백업 또는 rollback | |

실제 apply가 필요하다면 승인 근거와 적용 결과:

-

## 검증

해당 없는 행은 "해당 없음"으로 적습니다.

| 명령 또는 확인 | 결과 |
| --- | --- |
| `terraform fmt -check -recursive` | PASS / FAIL / 미실행 |
| 영향 root별 `terraform init -backend=false && terraform validate` | root별 PASS / FAIL / 해당 없음 |
| `terraform plan` | 변경 요약과 예상치 않은 변경 여부. 계정이 없으면 "미실행 — 사유" |
| `npm run typecheck`, `npm test` (scripts 변경 시) | PASS / FAIL / 해당 없음 |
| `actionlint` (workflow 변경 시) | PASS / FAIL / 해당 없음 |
| `npm run test:floci` (실험 층·workflow·scripts·buildspec 변경 시) | PASS / FAIL / 해당 없음 |

미검증 항목과 이유:

-

## 구현 판단과 리뷰 포인트

<!-- 선택한 Terraform/IAM 설계, 대안, 실험 파이프라인 영향과 집중해서 봐야 할 부분을 적습니다. -->

-

## 작성자 확인

- [ ] Issue 범위와 Non-Goals에 맞고 Issue가 없다면 예외 사유를 위에 적었습니다.
- [ ] PR 대상 브랜치가 dev이고, 영향 root 선택이 실제 변경 파일과 일치합니다.
- [ ] 독립적으로 검토 가능한 변경 단위로 나누었거나 함께 묶은 이유를 설명했습니다.
- [ ] 해당하는 검증을 실행했거나 미실행 사유(예: AWS 계정이 없어 plan 불가)를 위에 적었습니다.
- [ ] IAM을 바꿨다면 managed policy 크기(6,144자 한도)와 실험 IAM role의 permissions boundary를 확인했습니다.
- [ ] Terraform state, resource 교체/삭제, 네트워크·보안과 AWS 비용 영향을 기록했습니다.
- [ ] 실제 AWS apply, 파괴적 작업과 State 변경은 별도 승인 없이 수행하지 않았습니다.
- [ ] 자격 증명, Secret, terraform.tfstate와 운영 데이터가 포함되지 않았습니다.
- [ ] 전체 diff와 미검증 항목을 확인했습니다.
