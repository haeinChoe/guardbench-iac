# GuardBench Infrastructure

> **Portfolio fork**  
> 이 저장소는 팀 프로젝트 `GuardBench/guardbench-iac`를 개인 포트폴리오용으로 fork한 저장소입니다.  
> 서비스의 설계·구현은 팀의 공동 결과물이며, 이 README는 현재 Terraform root 구성과 [ADR 0001](docs/decisions/0001-performance-experiment-platform.md)을 기준으로 GuardBench MVP의 AWS 인프라 구조와 경계를 설명합니다.

GuardBench IaC는 **Frontend, Backend API/Worker, 비동기 메시징, 데이터베이스, AI 평가 경로와 성능 실험 환경을 네 개의 독립 Terraform root로 선언한 AWS 인프라 저장소**입니다.

---

## 전체 구조

```text
shared (상시)
 ├─ VPC, Public/Private Subnets, IGW, NAT Gateway, VPC Endpoints
 ├─ ECR (app, demo_ai), ECS Cluster, Shared ALB Access Logs Bucket
 └─ GitHub Actions OIDC Provider 및 공통 배포 Role

dev (상시, shared 참조)
 ├─ CloudFront + S3 Frontend
 ├─ Public ALB → Dev API ECS Service (WORKER_ENABLED=false)
 ├─ Dev Worker ECS Service (WORKER_ENABLED=true) + Auto Scaling
 ├─ Dev RDS, Dev SQS/DLQ, SSM DB Access Host
 └─ Dev SageMaker Classifier Endpoint, CloudWatch/SNS 관측성

performance-base (상시, shared 참조)
 ├─ Performance RDS (격리 DB), SQS/DLQ
 ├─ Performance Internal ALB + Target Groups
 ├─ CodeBuild Performance Runner (`codebuild/performance-runner.buildspec.yml`)
 └─ Performance Results S3 Bucket · 실험 전용 GitHub OIDC Role

performance-experiment (shared · performance-base 참조)
 ├─ Performance API / Worker ECS Service 및 Task Definition
 ├─ Performance 전용 SageMaker Classifier Endpoint
 ├─ Synthetic Demo AI ECS Service (Application Target)
 └─ presets/validation.tfvars · infrastructure_snapshot Output
```

---

## 인프라 설계 핵심

### 1. API와 Worker를 분리

Dev Backend는 ECS에서 역할을 나눕니다.

```text
ALB
 ↓
guardbench-dev-app
WORKER_ENABLED=false

SQS
 ↓
guardbench-dev-worker
WORKER_ENABLED=true
```

API Service는 HTTP 요청 처리에 집중하고 Worker는 SQS work item을 소비합니다.

Worker는 Application Auto Scaling 대상으로 관리되며, `terraform/dev`의 기본 dev capacity는 다음과 같습니다.

```hcl
backend_service_desired_counts = {
  app    = 1
  worker = 2
}

dev_worker_min_capacity = 2
dev_worker_max_capacity = 4
```

Worker scale-out은 queue depth와 oldest message age를 기준으로 동작하도록 구성되어 있습니다.

### 2. 비동기 실행 인프라를 독립 리소스로 관리

Dev(`terraform/dev`)와 Performance(`terraform/performance-base`)는 각각 독립된 source queue와 DLQ를 가집니다.

주요 queue 역할:

- run resolve
- work items
- run finalize

SQS `maxReceiveCount`는 Provider retry budget이 아니라 반복적으로 처리되지 않는 메시지를 DLQ로 격리하는 redrive 기준입니다.

또한 visibility timeout과 Backend claim lease는 서로 다른 개념으로 관리합니다.

### 3. Private Backend와 외부 호출 경로

Backend ECS task는 private subnet에서 실행됩니다.

외부 HTTPS가 필요한 경우 NAT Gateway를 사용하고, AWS 서비스 중 private connectivity가 가능한 경로는 VPC Endpoint를 사용합니다.

`terraform/shared`는 다음 Interface/Gateway VPC Endpoint를 선언합니다.

- ECS, RDS, SageMaker API, SageMaker Runtime
- SQS, Amazon Bedrock, Bedrock Runtime
- SSM, SSM Messages, EC2 Messages
- Secrets Manager, CloudWatch Logs, CloudWatch Monitoring
- ECR (`ecr.api`, `ecr.dkr`), S3 (Gateway)

### 4. Frontend는 S3 + CloudFront

정적 Frontend는 S3에 저장하고 CloudFront를 통해 제공합니다.

Frontend GitHub Actions는 OIDC로 AWS role을 사용해 배포합니다.

```text
GitHub Actions
   │ OIDC
   ▼
AWS IAM Role
   │
   ├─ S3 sync
   └─ CloudFront invalidation
```

장기 AWS credential을 GitHub repository secret에 직접 저장하는 방식보다 OIDC 기반 임시 자격 증명을 사용합니다.

### 5. Terraform과 Application 배포 책임을 분리

Dev 환경에서는 Terraform이 infrastructure configuration과 baseline Task Definition을 관리하고, Backend application image 배포 자체는 Backend GitHub Actions가 담당합니다.

```text
dev:
  Terraform → infrastructure / baseline task definition
  Backend GitHub Actions → immutable application image → new task definition revision → ECS service deployment

performance-experiment:
  Terraform → experiment preset + app_image_tag 기반 task definition / service rollout → infrastructure_snapshot output
```

성능 실험 층(`terraform/performance-experiment`)에서는 실험마다 Terraform이 API·Worker Task Definition과 Service rollout(`wait_for_steady_state = true`)을 직접 소유하며, Application image에는 `latest` 대신 commit SHA 기반 immutable tag를 사용합니다.

### 6. Terraform Root 분리 및 Dev/Performance 격리

단일 state 충돌과 환경 간 영향 범위를 줄이기 위해 Terraform 구성을 수명주기와 소유권에 따라 4개 root로 분리합니다.

- **`terraform/shared`**: 네트워크, VPC Endpoint, ECR, ECS Cluster, 공통 ALB Access Logs, GitHub OIDC Provider 및 공통 IAM
- **`terraform/dev`**: Dev API/Worker ECS, Auto Scaling, Dev RDS, Dev SQS/DLQ, Public ALB, CloudFront+S3, SSM DB Access Host, Dev SageMaker, Dev 관측성
- **`terraform/performance-base`**: Performance RDS, Performance SQS/DLQ, Performance Internal ALB, CodeBuild Runner 프로젝트, 성능 결과 S3, 실험 전용 GitHub OIDC Role과 실험 role용 permissions boundary (진입점 job은 `performance-experiment` GitHub environment를 사용해야 하며, 해당 environment의 deployment branch를 `dev`로 제한. 토큰은 진입점 workflow 파일의 `refs/heads/dev` 기준 `job_workflow_ref`와 `repository_id`도 만족해야 함)
- **`terraform/performance-experiment`**: Performance API/Worker ECS Service·Task Definition, Performance 전용 SageMaker Endpoint, Synthetic Demo AI ECS Service

각 root는 S3 backend에 `<root>/terraform.tfstate` 키로 독립 state를 저장하며, 하위 root는 상위 root의 output을 `terraform_remote_state`로 읽습니다.

---

## 주요 AWS 리소스

| Root | 주요 리소스 |
| --- | --- |
| `terraform/shared` | VPC, Public/Private Subnet, NAT Gateway, VPC Endpoints, ECR (`app`, `demo_ai`), ECS Cluster, ALB Access Logs S3, GitHub OIDC Provider |
| `terraform/dev` | Public ALB, CloudFront, Frontend S3, Dev ECS Services/Task Definitions, Application Auto Scaling, Dev RDS, SSM Access Host, Dev SQS/DLQ, SageMaker Endpoint, CloudWatch/SNS |
| `terraform/performance-base` | Performance RDS, Performance SQS/DLQ, Performance Internal ALB, CodeBuild Runner, Performance Results S3, 실험 전용 OIDC Role, 실험 role permissions boundary |
| `terraform/performance-experiment` | Performance API/Worker ECS Services/Task Definitions, Performance SageMaker Endpoint, Demo AI ECS Service |

---

## 저장소 구조

```text
guardbench-iac/
├─ .github/
│  └─ workflows/
│     ├─ performance-experiment.yml        # 성능 실험 단일 진입점
│     └─ performance-experiment-ci.yml     # 진입점 PR 검증(단위 테스트, actionlint, Floci 파이프라인 테스트)
├─ bootstrap/
│  └─ setup-remote-state.ps1
├─ codebuild/
│  └─ performance-runner.buildspec.yml
├─ docs/
│  ├─ performance-experiment.md
│  └─ decisions/
│     └─ 0001-performance-experiment-platform.md
├─ scripts/
│  └─ performance/                         # 진입점 단계별 TypeScript CLI (실행 전 확인, CodeBuild, 수집, 결합, 삭제 확인)
├─ tests/
│  ├─ performance/                         # scripts 단위 테스트(node:test)
│  └─ floci/                               # Floci 파이프라인 테스트
├─ package.json                            # scripts 의존성(AWS SDK v3)과 실행 명령
├─ tsconfig.json                           # tsc --noEmit 타입 검사
└─ terraform/
   ├─ README.md
   ├─ shared/
   ├─ dev/
   ├─ performance-base/
   └─ performance-experiment/
      └─ presets/
         └─ validation.tfvars
```

상세 실행 절차, state 연결, import/apply 주의사항은 [Terraform runbook](terraform/README.md)을 기준으로 합니다.

성능 실험 실행 방법은 [성능 실험 실행 안내](docs/performance-experiment.md)를 따릅니다. 아키텍처 결정은 [docs/decisions](docs/decisions/)에 기록합니다. 성능 실험 플랫폼 결정은 [ADR 0001](docs/decisions/0001-performance-experiment-platform.md)을 따릅니다.

---

## Terraform 실행

### 요구사항

- Terraform 1.10+ (S3 native `use_lockfile` 지원)
- AWS credentials (`ap-northeast-2`)

### 실행 순서

하위 root가 상위 root의 `terraform_remote_state` output을 참조하므로 반드시 아래 순서로 적용합니다.

```text
1. terraform/shared
2. terraform/dev 또는 terraform/performance-base
3. terraform/performance-experiment
```

각 root 디렉터리에서 다음 절차로 검증·적용합니다.

```bash
cd terraform/<root>
terraform init -input=false
terraform fmt -check
terraform validate
terraform plan -out=tfplan
```

기존 AWS 리소스와 remote state를 비교한 뒤, 의도하지 않은 삭제·교체가 없는지 확인하고 적용합니다.

```bash
terraform apply tfplan
```

상세 절차 및 root별 구성: → [terraform/README.md](terraform/README.md)

---

## 주요 Output

각 root는 자신의 `outputs.tf`에 책임 범위의 값만 노출하며 하위 root는 `terraform_remote_state`로 이를 소비합니다.

| Root | 주요 Output | 정의 파일 |
| --- | --- | --- |
| `terraform/shared` | VPC/Subnet IDs, VPC Endpoint SG/IDs, ECR URLs, ECS Cluster, ALB Access Logs Bucket, OIDC Provider/Role | [terraform/shared/outputs.tf](terraform/shared/outputs.tf) |
| `terraform/dev` | Frontend CloudFront URL, Public ALB API URL, Dev ECS/Worker, Dev RDS/SQS, SSM Access Host, SageMaker Endpoint, Ops SNS | [terraform/dev/outputs.tf](terraform/dev/outputs.tf) |
| `terraform/performance-base` | Performance RDS Endpoint/Secret, Performance SQS/DLQ, Internal ALB URL/Target Groups, Performance Results Bucket, CodeBuild Project/SG, Experiment OIDC Role | [terraform/performance-base/outputs.tf](terraform/performance-base/outputs.tf) |
| `terraform/performance-experiment` | `infrastructure_snapshot`, Performance API/Worker ECS·Task Definitions, Performance SageMaker Endpoint, Demo AI Service, Target 연결 정보 | [terraform/performance-experiment/outputs.tf](terraform/performance-experiment/outputs.tf) |

---

## Repository 관계

- **Portfolio fork:** `haeinChoe/guardbench-iac`
- **Original team repository:** `GuardBench/guardbench-iac`

이 저장소의 `main`은 GuardBench MVP 포트폴리오 기준선으로 사용합니다.
