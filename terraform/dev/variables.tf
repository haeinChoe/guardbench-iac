variable "project" {
  description = "Project name used for resource naming"
  type        = string
  default     = "guardbench"
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "ap-northeast-2"
}

variable "remote_state_bucket" {
  description = "S3 bucket storing Terraform remote state files"
  type        = string
  default     = "guardbench-terraform-state"
}

variable "remote_state_region" {
  description = "AWS region for the Terraform remote state bucket"
  type        = string
  default     = "ap-northeast-2"
}

variable "shared_state_key" {
  description = "Remote state key for the shared infrastructure root"
  type        = string
  default     = "shared/terraform.tfstate"
}

# ============================================
# Dev Backend ECS 설정
# ============================================
variable "api_container_port" {
  description = "Port exposed by the API container"
  type        = number
  default     = 8080
}

variable "api_cpu" {
  description = "CPU units for dev API and Worker tasks (1 vCPU = 1024)"
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "Memory (MiB) for dev API and Worker tasks"
  type        = number
  default     = 1024
}

variable "backend_service_desired_counts" {
  description = "Desired task counts keyed by development backend ECS service role"
  type        = map(number)
  default     = {}

  validation {
    condition = alltrue([
      for desired_count in values(var.backend_service_desired_counts) :
      desired_count >= 0 && desired_count == floor(desired_count)
    ])
    error_message = "backend_service_desired_counts values must be non-negative whole numbers."
  }
}

variable "dev_worker_min_capacity" {
  description = "Minimum development Worker ECS task count"
  type        = number
  default     = 2

  validation {
    condition     = var.dev_worker_min_capacity >= 1 && var.dev_worker_min_capacity == floor(var.dev_worker_min_capacity)
    error_message = "dev_worker_min_capacity must be a positive whole number."
  }
}

variable "dev_worker_max_capacity" {
  description = "Maximum development Worker ECS task count"
  type        = number
  default     = 4

  validation {
    condition     = var.dev_worker_max_capacity >= 1 && var.dev_worker_max_capacity == floor(var.dev_worker_max_capacity) && var.dev_worker_max_capacity <= 4
    error_message = "dev_worker_max_capacity must be a whole number from 1 through 4."
  }
}

variable "dev_worker_work_items_concurrency" {
  description = "WorkItems concurrency per development Worker ECS task"
  type        = number
  default     = 8

  validation {
    condition     = var.dev_worker_work_items_concurrency >= 1 && var.dev_worker_work_items_concurrency == floor(var.dev_worker_work_items_concurrency) && var.dev_worker_work_items_concurrency <= 8
    error_message = "dev_worker_work_items_concurrency must be a whole number from 1 through 8."
  }
}

check "dev_worker_capacity_contract" {
  assert {
    condition     = var.dev_worker_min_capacity <= var.dev_worker_max_capacity && local.backend_service_desired_counts["worker"] >= var.dev_worker_min_capacity && local.backend_service_desired_counts["worker"] <= var.dev_worker_max_capacity
    error_message = "The development Worker desired count must stay between its configured min and max capacity."
  }
}

variable "app_image_tag" {
  description = "Immutable ECR tag for the verified backend commit"
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{7,64}$", var.app_image_tag))
    error_message = "app_image_tag must be a verified Git commit SHA."
  }
}

# ============================================
# Dev RDS / Access Host 설정
# ============================================
variable "db_port" {
  description = "RDS PostgreSQL port"
  type        = number
  default     = 5432
}

variable "dev_db_instance_class" {
  description = "Instance class for the development RDS"
  type        = string
  default     = "db.t4g.micro"
}

variable "dev_db_allocated_storage" {
  description = "Allocated storage in GiB for the development RDS"
  type        = number
  default     = 20
}

variable "dev_db_max_allocated_storage" {
  description = "Maximum autoscaled storage in GiB for the development RDS"
  type        = number
  default     = 100
}

variable "dev_db_backup_retention_period" {
  description = "Backup retention period in days for the development RDS"
  type        = number
  default     = 1
}

variable "db_access_host_enabled" {
  description = "Create the private SSM-managed host used for RDS port forwarding"
  type        = bool
  default     = true
}

variable "db_access_host_instance_type" {
  description = "EC2 instance type for the private RDS access host"
  type        = string
  default     = "t3.micro"
}

# ============================================
# Frontend / SageMaker / Observability 설정
# ============================================
variable "spa_index_document" {
  description = "Index document for S3 static hosting"
  type        = string
  default     = "index.html"
}

variable "sagemaker_classifier_system_prompt" {
  description = "Approved fixed system prompt for the SageMaker response behavior classifier; empty leaves the backend classifier safely unconfigured"
  type        = string
  default     = ""
}

variable "sagemaker_classifier_endpoint_enabled" {
  description = "Create the billable ml.g5.xlarge SageMaker real-time endpoint; model, endpoint configuration, IAM, and PrivateLink remain managed when false"
  type        = bool
  default     = false
}

variable "sagemaker_classifier_user_prompt_template" {
  description = "Optional approved user prompt template for the SageMaker classifier; empty uses the backend default"
  type        = string
  default     = ""
}

variable "alarm_email" {
  description = "Optional email address that confirms the dev SNS topic subscription"
  type        = string
  default     = null
  nullable    = true
}
