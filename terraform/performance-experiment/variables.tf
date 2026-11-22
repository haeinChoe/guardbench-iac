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

variable "performance_base_state_key" {
  description = "Remote state key for the performance-base root"
  type        = string
  default     = "performance-base/terraform.tfstate"
}

# ============================================
# Performance Backend ECS 설정
# ============================================
variable "api_container_port" {
  description = "Port exposed by the Performance API container"
  type        = number
  default     = 8080
}

variable "performance_api_cpu" {
  description = "CPU units for the independent Performance Backend task (1 vCPU = 1024)"
  type        = number
  default     = 512

  validation {
    condition     = var.performance_api_cpu > 0 && var.performance_api_cpu == floor(var.performance_api_cpu)
    error_message = "performance_api_cpu must be a positive whole number."
  }
}

variable "performance_api_memory" {
  description = "Memory (MiB) for the independent Performance Backend task"
  type        = number
  default     = 1024

  validation {
    condition     = var.performance_api_memory > 0 && var.performance_api_memory == floor(var.performance_api_memory)
    error_message = "performance_api_memory must be a positive whole number."
  }
}

variable "performance_app_enabled" {
  description = "Run Performance Backend ECS tasks"
  type        = bool
  default     = false
}

variable "performance_api_desired_count" {
  description = "Desired task count for the Performance API ECS service"
  type        = number
  default     = 1

  validation {
    condition     = var.performance_api_desired_count >= 0 && var.performance_api_desired_count == floor(var.performance_api_desired_count)
    error_message = "performance_api_desired_count must be a non-negative whole number."
  }
}

variable "performance_worker_desired_count" {
  description = "Desired task count for the Performance Worker ECS service"
  type        = number
  default     = 4

  validation {
    condition     = var.performance_worker_desired_count >= 0 && var.performance_worker_desired_count == floor(var.performance_worker_desired_count)
    error_message = "performance_worker_desired_count must be a non-negative whole number."
  }
}

variable "performance_worker_work_items_concurrency" {
  description = "WorkItems worker concurrency for the Performance Backend"
  type        = number
  default     = 1

  validation {
    condition     = var.performance_worker_work_items_concurrency >= 1 && var.performance_worker_work_items_concurrency == floor(var.performance_worker_work_items_concurrency)
    error_message = "performance_worker_work_items_concurrency must be a positive whole number."
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

variable "sagemaker_classifier_endpoint_name" {
  description = "SageMaker classifier endpoint name passed to Performance Backend tasks"
  type        = string
  default     = "guardbench-qwen3-4b-endpoint"
}

variable "sagemaker_classifier_system_prompt" {
  description = "Approved fixed system prompt for the SageMaker response behavior classifier; empty leaves the backend classifier safely unconfigured"
  type        = string
  default     = ""
}

variable "sagemaker_classifier_user_prompt_template" {
  description = "Optional approved user prompt template for the SageMaker classifier; empty uses the backend default"
  type        = string
  default     = ""
}

variable "performance_sagemaker_instance_type" {
  description = "SageMaker ML instance type for the dedicated performance classifier endpoint"
  type        = string
  default     = "ml.g5.xlarge"

  validation {
    condition     = can(regex("^ml\\.[a-z0-9]+\\.[a-z0-9]+$", var.performance_sagemaker_instance_type))
    error_message = "performance_sagemaker_instance_type must be a valid SageMaker ML instance type (for example ml.g5.xlarge)."
  }
}

variable "performance_sagemaker_instance_count" {
  description = "Initial instance count for the dedicated performance classifier endpoint"
  type        = number
  default     = 1

  validation {
    condition     = var.performance_sagemaker_instance_count >= 1 && var.performance_sagemaker_instance_count == floor(var.performance_sagemaker_instance_count)
    error_message = "performance_sagemaker_instance_count must be a positive whole number."
  }
}

# ============================================
# Demo AI Target 설정
# ============================================
variable "demo_ai_image_tag" {
  description = "Immutable Git SHA tag for the verified Demo AI image"
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{7,64}$", var.demo_ai_image_tag))
    error_message = "demo_ai_image_tag must be a verified Git commit SHA; mutable tags such as latest are not allowed."
  }
}

variable "demo_ai_bedrock_model_id" {
  description = "Bedrock model ID passed to the Demo AI container as BEDROCK_MODEL_ID"
  type        = string

  validation {
    condition     = trimspace(var.demo_ai_bedrock_model_id) != ""
    error_message = "demo_ai_bedrock_model_id must be a non-empty approved Bedrock model ID or inference profile ID."
  }
}

variable "demo_ai_bedrock_resource_arns" {
  description = "Exact Bedrock foundation-model and/or inference-profile ARNs allowed for Demo AI InvokeModel"
  type        = list(string)

  validation {
    condition = length(var.demo_ai_bedrock_resource_arns) > 0 && alltrue([
      for resource_arn in var.demo_ai_bedrock_resource_arns : can(regex(
        "^arn:(aws|aws-us-gov|aws-cn):bedrock:[a-z0-9-]+:[0-9]{0,12}:(foundation-model|inference-profile)/.+$",
        resource_arn,
      ))
    ])
    error_message = "demo_ai_bedrock_resource_arns must contain at least one exact Bedrock foundation-model or inference-profile ARN."
  }
}

variable "demo_ai_cpu" {
  description = "CPU units for the fixed Demo AI Fargate fixture"
  type        = number
  default     = 512
}

variable "demo_ai_memory" {
  description = "Memory (MiB) for the fixed Demo AI Fargate fixture"
  type        = number
  default     = 1024
}

variable "demo_ai_desired_count" {
  description = "Number of Demo AI Fargate fixture tasks"
  type        = number
  default     = 1

  validation {
    condition     = var.demo_ai_desired_count >= 0
    error_message = "demo_ai_desired_count must be zero or greater."
  }
}

variable "demo_ai_enabled" {
  description = "Keep Demo AI tasks running for integrated performance tests"
  type        = bool
  default     = false
}
