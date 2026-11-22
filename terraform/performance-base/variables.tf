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
