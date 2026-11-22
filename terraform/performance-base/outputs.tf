# ============================================
# Performance RDS Outputs
# ============================================
output "db_port" {
  description = "PostgreSQL port for the performance-test RDS"
  value       = var.db_port
}

output "performance_rds_endpoint" {
  description = "Private PostgreSQL endpoint for the performance-test RDS"
  value       = aws_db_instance.performance.address
}

output "performance_rds_identifier" {
  description = "Identifier for the performance-test RDS"
  value       = aws_db_instance.performance.identifier
}

output "performance_rds_instance_class" {
  description = "Configured instance class for the performance-test RDS"
  value       = aws_db_instance.performance.instance_class
}

output "performance_rds_master_secret_arn" {
  description = "Secrets Manager ARN for the isolated performance RDS credentials"
  value       = aws_db_instance.performance.master_user_secret[0].secret_arn
}

output "performance_rds_security_group_id" {
  description = "Security group ID for the performance-test RDS"
  value       = aws_security_group.performance_rds.id
}

# ============================================
# Performance SQS Outputs
# ============================================
output "performance_sqs_queue_urls" {
  description = "Performance source queue URLs"
  value       = { for name, queue in aws_sqs_queue.performance_source : name => queue.url }
}

output "performance_sqs_queue_names" {
  description = "Performance source queue names"
  value       = { for name, queue in aws_sqs_queue.performance_source : name => queue.name }
}

output "performance_sqs_queue_arns" {
  description = "Performance source queue ARNs"
  value       = { for name, queue in aws_sqs_queue.performance_source : name => queue.arn }
}

output "performance_sqs_dead_letter_queue_urls" {
  description = "Performance dead-letter queue URLs"
  value       = { for name, queue in aws_sqs_queue.performance_dead_letter : name => queue.url }
}

output "performance_sqs_dead_letter_queue_names" {
  description = "Performance dead-letter queue names"
  value       = { for name, queue in aws_sqs_queue.performance_dead_letter : name => queue.name }
}

output "performance_sqs_dead_letter_queue_arns" {
  description = "Performance dead-letter queue ARNs"
  value       = { for name, queue in aws_sqs_queue.performance_dead_letter : name => queue.arn }
}

# ============================================
# Performance Internal ALB & Results S3 Outputs
# ============================================
output "performance_api_url" {
  description = "Private internal ALB base URL for the Performance Backend API"
  value       = "http://${aws_lb.performance_api.dns_name}"
}

output "performance_api_alb_dns_name" {
  description = "Internal Performance ALB DNS name"
  value       = aws_lb.performance_api.dns_name
}

output "performance_api_alb_arn" {
  description = "Internal Performance ALB ARN"
  value       = aws_lb.performance_api.arn
}

output "performance_api_alb_security_group_id" {
  description = "Security group ID for the internal Performance ALB"
  value       = aws_security_group.performance_api_alb.id
}

output "performance_api_target_group_arn" {
  description = "Target group ARN for the Performance Backend API"
  value       = aws_lb_target_group.performance_api.arn
}

output "performance_demo_ai_target_group_arn" {
  description = "Target group ARN for the synthetic Demo AI target"
  value       = aws_lb_target_group.performance_demo_ai.arn
}

output "performance_api_listener_arn" {
  description = "HTTP listener ARN for the internal Performance ALB"
  value       = aws_lb_listener.performance_api.arn
}

output "performance_target_url" {
  description = "Private internal Demo AI chat completions endpoint URL"
  value       = "http://${aws_lb.performance_api.dns_name}/v1/chat/completions"
}

output "performance_results_bucket_name" {
  description = "Private S3 bucket name for performance results"
  value       = aws_s3_bucket.performance_results.id
}

output "performance_results_bucket_arn" {
  description = "Private S3 bucket ARN for performance results"
  value       = aws_s3_bucket.performance_results.arn
}

# ============================================
# CodeBuild Performance Runner Outputs
# ============================================
output "performance_codebuild_project_name" {
  description = "CodeBuild project name running GuardBench performance scenarios"
  value       = aws_codebuild_project.performance_runner.name
}

output "performance_codebuild_project_arn" {
  description = "CodeBuild project ARN running GuardBench performance scenarios"
  value       = aws_codebuild_project.performance_runner.arn
}

output "performance_codebuild_log_group_name" {
  description = "CloudWatch Log Group storing CodeBuild performance Runner logs"
  value       = aws_cloudwatch_log_group.performance_codebuild_runner.name
}

output "performance_codebuild_runner_role_arn" {
  description = "IAM service role ARN assumed by the performance CodeBuild project"
  value       = aws_iam_role.performance_codebuild_runner.arn
}

output "performance_codebuild_runner_security_group_id" {
  description = "Security group ID attached to the private VPC performance CodeBuild Runner"
  value       = aws_security_group.performance_codebuild_runner.id
}

# ============================================
# Performance Experiment OIDC Role Outputs
# ============================================
output "performance_experiment_github_actions_role_arn" {
  description = "IAM Role ARN assumed by the performance experiment entrypoint workflow via GitHub OIDC"
  value       = aws_iam_role.performance_experiment_github_actions.arn
}

output "performance_experiment_github_actions_role_name" {
  description = "IAM Role name assumed by the performance experiment entrypoint workflow via GitHub OIDC"
  value       = aws_iam_role.performance_experiment_github_actions.name
}
