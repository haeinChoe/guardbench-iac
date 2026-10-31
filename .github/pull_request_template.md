<!--
초안 리뷰에는 Draft PR을 사용해 주세요.
Closes #는 Issue를 종료하고 Refs #는 관련 Issue를 연결합니다.
Issue가 없는 예외 작업은 이유를 아래에 적어주세요.
-->

## 관련 Issue

Closes # / Refs # / 해당 없음 — 사유:

## 결과

<!-- 해결한 문제와 리뷰어가 알아야 할 결과를 먼저 씁니다. -->

-

## 변경 범위와 Non-Goals

<!-- 변경한 resource, module, IAM, network 또는 workflow와 제외한 인접 영역을 적습니다. -->

-

## Terraform 및 AWS 영향

| 항목 | 요약 |
| --- | --- |
| Plan 예상치(add/change/destroy) | |
| Terraform state 또는 resource 교체 | |
| IAM, network 또는 보안 | |
| AWS 비용과 Region | |
| 데이터, 백업 또는 rollback | |

실제 apply가 필요하다면 승인 근거와 적용 결과:

-

## 검증

| 명령 또는 확인 | 결과 |
| --- | --- |
| terraform fmt -check | PASS / FAIL / 미실행 |
| terraform validate | PASS / FAIL / 미실행 |
| terraform plan | 변경 요약과 예상치 않은 변경 여부 |

미검증 항목과 이유:

-

## 구현 판단과 리뷰 포인트

<!-- 선택한 Terraform/IAM 설계, 대안, 운영 영향과 집중해서 봐야 할 부분을 적습니다. -->

-

## 작성자 확인

- [ ] Issue 범위와 Non-Goals에 맞고 Issue가 없다면 예외 사유를 위에 적었습니다.
- [ ] 독립적으로 검토 가능한 변경 단위로 나누었거나 함께 묶은 이유를 설명했습니다.
- [ ] Terraform state, resource 교체/삭제와 plan 결과를 검토했습니다.
- [ ] IAM, network, 보안과 AWS 비용 영향을 기록했습니다.
- [ ] 실제 AWS apply, 파괴적 작업과 State 변경은 별도 승인 없이 수행하지 않았습니다.
- [ ] 자격 증명, Secret, terraform.tfstate와 운영 데이터가 포함되지 않았습니다.
- [ ] 전체 diff와 미검증 항목을 확인했습니다.
