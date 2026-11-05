# GuardBench Infrastructure

> **Portfolio fork**  
> 이 저장소는 팀 프로젝트 `GuardBench/guardbench-iac`를 개인 포트폴리오용으로 fork한 저장소입니다.  
> 서비스의 설계·구현은 팀의 공동 결과물이며, 이 README는 현재 `main`의 Terraform 구성을 기준으로 GuardBench MVP의 AWS 인프라 구조와 운영 경계를 설명합니다.

GuardBench IaC는 **Frontend, Backend API/Worker, 비동기 메시징, 데이터베이스, AI 평가 경로와 성능 테스트 환경을 Terraform으로 선언한 AWS 인프라 저장소**입니다.

---

## 전체 구조

```text
Internet
   │
   ├─ CloudFront
   │    └─ S3 Frontend
   │
   └─ ALB
        └─ ECS API Service
              │
              ├─ PostgreSQL (RDS)
              ├─ SQS
              └─ AI / external provider
                    │
                    └─ NAT Gateway / VPC Endpoints

SQS
 └─ ECS Worker Service
      ├─ PostgreSQL
      ├─ SageMaker Runtime
      └─ CloudWatch

Performance environment
 ├─ dedicated API / Worker services
 ├─ isolated RDS
 ├─ isolated SQS / DLQ
 └─ optional EC2 performance runner
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

Worker는 Application Auto Scaling 대상으로 관리되며, 현재 Terraform의 기본 dev capacity는 다음과 같습니다.

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

Dev와 Performance는 각각 독립된 source queue와 DLQ를 가집니다.

주요 queue 역할:

- run resolve
- work items
- run finalize

SQS `maxReceiveCount`는 Provider retry budget이 아니라 반복적으로 처리되지 않는 메시지를 DLQ로 격리하는 redrive 기준입니다.

또한 visibility timeout과 Backend claim lease는 서로 다른 개념으로 관리합니다.

### 3. Private Backend와 외부 호출 경로

Backend ECS task는 private subnet에서 실행됩니다.

외부 HTTPS가 필요한 경우 NAT Gateway를 사용하고, AWS 서비스 중 private connectivity가 가능한 경로는 VPC Endpoint를 사용합니다.

현재 Terraform은 다음과 같은 endpoint를 선언합니다.

- SQS
- Amazon Bedrock
- SageMaker Runtime
- SSM
- CloudWatch Logs
- ECR
- S3

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

Terraform은 infrastructure configuration과 base Task Definition을 관리합니다.

Backend application image 배포 자체는 Backend GitHub Actions가 담당합니다.

```text
Terraform
→ infrastructure / base task definition

Backend GitHub Actions
→ immutable application image
→ new task definition revision
→ ECS service deployment
```

Application image에는 `latest` 대신 commit SHA 기반 immutable tag를 사용합니다.

### 6. Dev와 Performance 환경을 분리

Performance 환경은 Dev 부하와 데이터에 영향을 주지 않도록 별도 리소스를 사용합니다.

- dedicated Performance API Service
- dedicated Performance Worker Service
- isolated Performance RDS
- isolated Performance SQS / DLQ
- optional performance runner EC2

ECS cluster는 공유하지만 application service, queue, database는 역할별로 분리합니다.

---

## 주요 AWS 리소스

| 영역 | 주요 리소스 |
| --- | --- |
| Network | VPC, Public/Private Subnet, NAT Gateway |
| Frontend | S3, CloudFront |
| API | ALB, ECS Service |
| Worker | ECS Service, Application Auto Scaling |
| Messaging | SQS, DLQ |
| Database | Amazon RDS for PostgreSQL |
| Container | Amazon ECR |
| AI | SageMaker Runtime, Bedrock VPC Endpoint |
| Secrets | AWS Secrets Manager |
| Observability | CloudWatch, SNS |
| Operations | AWS Systems Manager |
| CI/CD Auth | IAM OIDC roles |
| Performance | dedicated ECS/RDS/SQS, optional EC2 runner |

---

## 저장소 구조

```text
guardbench-iac/
├─ bootstrap/
└─ terraform/
   ├─ main.tf
   ├─ variables.tf
   ├─ outputs.tf
   └─ README.md
```

상세 운영 절차와 import/apply 주의사항은 [Terraform runbook](terraform/README.md)을 기준으로 합니다.

---

## Terraform 실행

### 요구사항

- Terraform 1.10+
- AWS credentials
- Region: `ap-northeast-2`

```bash
cd terraform
terraform init -input=false
terraform fmt -check
terraform validate
terraform plan -out=tfplan
```

기존 AWS 리소스와 remote state를 비교한 뒤, 의도하지 않은 삭제·교체가 없는지 확인하고 적용합니다.

```bash
terraform apply tfplan
```

이미 존재하는 리소스를 Terraform 관리 대상으로 편입할 때는 apply 전에 import가 필요할 수 있습니다.

상세 절차:

→ [terraform/README.md](terraform/README.md)

---

## 운영상 중요한 경계

### Terraform apply는 Backend 배포가 아님

```text
terraform apply
≠
new backend application release
```

IaC 변경과 application release를 분리하여, 인프라 변경이 의도하지 않은 image 교체로 이어지지 않도록 합니다.

### Dev와 Performance 데이터베이스는 분리

Performance RDS는 부하 테스트 재현성을 위한 고정 의존 인프라입니다.

Dev RDS와 같은 데이터베이스를 공유하지 않습니다.

### 자격 증명은 plaintext output으로 노출하지 않음

RDS credential은 Secrets Manager를 통해 관리하며 Terraform output이나 ECS Task Definition에 plaintext로 직접 기록하지 않습니다.

---

## 주요 Output

Terraform은 다음과 같은 값을 제공합니다.

- Frontend CloudFront URL
- ALB API URL
- ECS Service / Task Definition 정보
- ECR repository URL
- Dev / Performance RDS endpoint
- Dev / Performance SQS queue 정보
- GitHub Actions OIDC role ARN
- Performance Runner 정보
- SageMaker classifier endpoint 정보

실제 전체 목록은 [terraform/outputs.tf](terraform/outputs.tf)를 참고합니다.

---

## Repository 관계

- **Portfolio fork:** `haeinChoe/guardbench-iac`
- **Original team repository:** `GuardBench/guardbench-iac`

이 저장소의 `main`은 GuardBench MVP 포트폴리오 기준선으로 사용합니다.
