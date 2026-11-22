# ============================================
# CloudFront / S3 Outputs
# ============================================
output "frontend_url" {
  description = "Frontend URL (CloudFront default domain)"
  value       = "https://${aws_cloudfront_distribution.frontend.domain_name}"
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID (for cache invalidation)"
  value       = aws_cloudfront_distribution.frontend.id
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name"
  value       = aws_cloudfront_distribution.frontend.domain_name
}

output "s3_frontend_bucket" {
  description = "S3 bucket name for frontend static files"
  value       = aws_s3_bucket.frontend.id
}

output "s3_frontend_bucket_arn" {
  description = "S3 frontend bucket ARN"
  value       = aws_s3_bucket.frontend.arn
}

# ============================================
# ALB Outputs
# ============================================
output "api_url" {
  description = "Backend API URL (ALB DNS)"
  value       = "http://${aws_lb.main.dns_name}"
}

output "alb_dns_name" {
  description = "ALB DNS name"
  value       = aws_lb.main.dns_name
}

output "alb_arn" {
  description = "ALB ARN"
  value       = aws_lb.main.arn
}

# ============================================
# ECS Outputs
# ============================================
output "ecs_service_name" {
  description = "Development application ECS service name"
  value       = aws_ecs_service.app.name
}

output "ecs_task_definition_arn" {
  description = "Development application Terraform-managed baseline task definition ARN"
  value       = aws_ecs_task_definition.app.arn
}

output "ecs_worker_service_name" {
  description = "Development Worker ECS service name"
  value       = aws_ecs_service.worker.name
}

output "ecs_worker_task_definition_family" {
  description = "Development Worker ECS task definition family"
  value       = aws_ecs_task_definition.worker.family
}

output "ecs_worker_task_definition_arn" {
  description = "Terraform-managed baseline task definition ARN for the development Worker"
  value       = aws_ecs_task_definition.worker.arn
}

output "dev_worker_min_capacity" {
  description = "Minimum development Worker ECS task count"
  value       = var.dev_worker_min_capacity
}

output "dev_worker_max_capacity" {
  description = "Maximum development Worker ECS task count"
  value       = var.dev_worker_max_capacity
}

output "dev_worker_work_items_concurrency" {
  description = "WorkItems concurrency configured for each development Worker task"
  value       = var.dev_worker_work_items_concurrency
}

# ============================================
# RDS / Access Host Outputs
# ============================================
output "rds_endpoint" {
  description = "Private PostgreSQL endpoint for the development app service"
  value       = aws_db_instance.app.address
}

output "rds_master_secret_arn" {
  description = "Secrets Manager ARN for the development RDS credentials"
  value       = aws_db_instance.app.master_user_secret[0].secret_arn
}

output "db_access_host_instance_id" {
  description = "Private SSM-managed EC2 instance ID for RDS port forwarding"
  value       = var.db_access_host_enabled ? aws_instance.db_access[0].id : null
}

output "db_access_host_private_ip" {
  description = "Private IP of the SSM-managed RDS access host"
  value       = var.db_access_host_enabled ? aws_instance.db_access[0].private_ip : null
}

# ============================================
# SQS / SageMaker / Observability Outputs
# ============================================
output "sqs_queue_urls" {
  description = "Development source queue URLs injected into the app task definition"
  value       = { for name, queue in aws_sqs_queue.source : name => queue.url }
}

output "sqs_queue_names" {
  description = "Development source queue names"
  value       = { for name, queue in aws_sqs_queue.source : name => queue.name }
}

output "sqs_dead_letter_queue_urls" {
  description = "Development dead-letter queue URLs"
  value       = { for name, queue in aws_sqs_queue.dead_letter : name => queue.url }
}

output "sqs_dead_letter_queue_names" {
  description = "Development dead-letter queue names"
  value       = { for name, queue in aws_sqs_queue.dead_letter : name => queue.name }
}

output "sagemaker_classifier_endpoint_name" {
  description = "Exact SageMaker endpoint name injected into the dev backend task definition"
  value       = local.sagemaker_classifier_endpoint_name
}

output "sagemaker_classifier_endpoint_arn" {
  description = "Exact endpoint ARN permitted to the dev backend ECS task role"
  value       = local.sagemaker_classifier_endpoint_arn
}

output "ops_sns_topic_arn" {
  description = "Development alarm topic; email subscriptions require confirmation"
  value       = aws_sns_topic.ops.arn
}

# ============================================
# Security Group Outputs
# ============================================
output "alb_security_group_id" {
  description = "ALB security group ID"
  value       = aws_security_group.alb.id
}

output "api_security_group_id" {
  description = "API service security group ID"
  value       = aws_security_group.api.id
}

output "worker_security_group_id" {
  description = "Worker security group ID"
  value       = aws_security_group.worker.id
}

output "rds_security_group_id" {
  description = "RDS PostgreSQL security group ID"
  value       = aws_security_group.rds.id
}

output "db_access_security_group_id" {
  description = "Security group ID for the private SSM RDS access host"
  value       = aws_security_group.db_access.id
}
