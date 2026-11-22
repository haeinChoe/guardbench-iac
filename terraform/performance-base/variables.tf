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

variable "api_container_port" {
  description = "Port exposed by the Performance API container"
  type        = number
  default     = 8080
}

variable "db_port" {
  description = "RDS PostgreSQL port"
  type        = number
  default     = 5432
}

variable "performance_db_instance_class" {
  description = "Instance class for the isolated, fixed Performance RDS dependency"
  type        = string
}

variable "performance_db_allocated_storage" {
  description = "Configured allocated storage in GiB for the isolated Performance RDS"
  type        = number
}

variable "performance_db_max_allocated_storage" {
  description = "Configured maximum allocated storage in GiB for the isolated Performance RDS"
  type        = number

  validation {
    condition     = var.performance_db_max_allocated_storage >= var.performance_db_allocated_storage
    error_message = "performance_db_max_allocated_storage must be greater than or equal to performance_db_allocated_storage."
  }
}

variable "performance_db_backup_retention_period" {
  description = "Configured backup retention period in days for the isolated Performance RDS"
  type        = number
}

# ============================================
# CodeBuild Performance Runner 설정
# ============================================
variable "performance_codebuild_compute_type" {
  description = "CodeBuild compute type for executing k6 and the Python performance runner"
  type        = string
  default     = "BUILD_GENERAL1_MEDIUM"

  validation {
    condition     = can(regex("^BUILD_GENERAL1_[A-Z0-9]+$", var.performance_codebuild_compute_type))
    error_message = "performance_codebuild_compute_type must be a valid CodeBuild BUILD_GENERAL1 compute type."
  }
}

variable "performance_codebuild_image" {
  description = "CodeBuild managed container image with Python 3.11 runtime support"
  type        = string
  default     = "aws/codebuild/standard:7.0"

  validation {
    condition     = trimspace(var.performance_codebuild_image) != ""
    error_message = "performance_codebuild_image must not be empty."
  }
}

variable "performance_codebuild_timeout_minutes" {
  description = "CodeBuild execution timeout in minutes (adjust later when SOAK profile duration is finalized)"
  type        = number
  default     = 60

  validation {
    condition = (
      var.performance_codebuild_timeout_minutes >= 5 &&
      var.performance_codebuild_timeout_minutes <= 480 &&
      var.performance_codebuild_timeout_minutes == floor(var.performance_codebuild_timeout_minutes)
    )
    error_message = "performance_codebuild_timeout_minutes must be a whole number from 5 through 480."
  }
}

variable "backend_repository_url" {
  description = "Public Git repository URL checked out by CodeBuild at BACKEND_COMMIT"
  type        = string
  default     = "https://github.com/haeinChoe/guardbench-backend.git"

  validation {
    condition     = can(regex("^https://github\\.com/[^/]+/[^/]+\\.git$", var.backend_repository_url))
    error_message = "backend_repository_url must be an HTTPS GitHub repository URL ending in .git."
  }
}

# ============================================
# Performance Experiment OIDC Role 설정
# ============================================
variable "performance_base_state_key" {
  description = "Remote state key for the performance-base root"
  type        = string
  default     = "performance-base/terraform.tfstate"
}

variable "performance_experiment_state_key" {
  description = "Remote state key for the performance-experiment root"
  type        = string
  default     = "performance-experiment/terraform.tfstate"
}

variable "performance_experiment_github_repository" {
  description = "GitHub repository allowed to assume the performance experiment OIDC role"
  type        = string
  default     = "haeinChoe/guardbench-iac"
}

variable "performance_experiment_github_environment" {
  description = "GitHub environment name trusted via GitHub OIDC environment sub claim"
  type        = string
  default     = "performance-experiment"
}
