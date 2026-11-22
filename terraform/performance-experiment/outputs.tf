# ============================================
# Performance ECS Outputs
# ============================================
output "performance_ecs_cluster_name" {
  description = "ECS cluster name for the Performance Backend deployment"
  value       = data.terraform_remote_state.shared.outputs.ecs_cluster_name
}

output "performance_ecs_service_name" {
  description = "Dedicated Performance API ECS service name"
  value       = aws_ecs_service.performance_app.name
}

output "performance_worker_ecs_service_name" {
  description = "Dedicated Performance Worker ECS service name"
  value       = aws_ecs_service.performance_worker.name
}

output "performance_ecs_container_name" {
  description = "Container name used by the Performance Backend task definition"
  value       = "app"
}

output "performance_ecs_task_definition_family" {
  description = "Dedicated Performance API ECS task definition family"
  value       = aws_ecs_task_definition.performance_app.family
}

output "performance_ecs_task_definition_arn" {
  description = "Terraform-managed baseline task definition ARN for Performance API"
  value       = aws_ecs_task_definition.performance_app.arn
}

output "performance_worker_ecs_task_definition_family" {
  description = "Dedicated Performance Worker ECS task definition family"
  value       = aws_ecs_task_definition.performance_worker.family
}

output "performance_worker_ecs_task_definition_arn" {
  description = "Terraform-managed baseline task definition ARN for Performance Worker"
  value       = aws_ecs_task_definition.performance_worker.arn
}

output "performance_worker_work_items_concurrency" {
  description = "WorkItems concurrency configured for the Performance Backend Task Definition"
  value       = var.performance_worker_work_items_concurrency
}

output "performance_api_desired_count" {
  description = "Explicit Performance API ECS desired task count input"
  value       = var.performance_api_desired_count
}

output "performance_worker_desired_count" {
  description = "Explicit Performance Worker ECS desired task count input"
  value       = var.performance_worker_desired_count
}

# ============================================
# Security Group / Demo AI Outputs
# ============================================
output "performance_api_security_group_id" {
  description = "Security group ID for the Performance API ECS service"
  value       = aws_security_group.performance_api.id
}

output "performance_worker_security_group_id" {
  description = "Security group ID for the Performance Worker ECS service"
  value       = aws_security_group.performance_worker.id
}

output "demo_ai_ecs_service_name" {
  description = "Dedicated Demo AI ECS service name"
  value       = aws_ecs_service.demo_ai.name
}

output "demo_ai_log_group_name" {
  description = "CloudWatch Log Group for Demo AI task metadata"
  value       = aws_cloudwatch_log_group.demo_ai.name
}

output "demo_ai_security_group_id" {
  description = "Security group ID for the Demo AI ECS service"
  value       = aws_security_group.demo_ai.id
}

output "performance_target_url" {
  description = "Private internal Demo AI chat completions endpoint URL"
  value       = data.terraform_remote_state.performance_base.outputs.performance_target_url
}

output "performance_target_model" {
  description = "OpenAI-compatible model value for the Demo AI target"
  value       = "demo-model"
}

output "performance_target_revision" {
  description = "Immutable Demo AI image tag for performance-test traceability"
  value       = var.demo_ai_image_tag
}
