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
  description = "Terraform-managed Performance API ECS task definition family"
  value       = aws_ecs_task_definition.performance_app.family
}

output "performance_ecs_task_definition_arn" {
  description = "Terraform-managed Performance API ECS task definition ARN"
  value       = aws_ecs_task_definition.performance_app.arn
}

output "performance_worker_ecs_task_definition_family" {
  description = "Terraform-managed Performance Worker ECS task definition family"
  value       = aws_ecs_task_definition.performance_worker.family
}

output "performance_worker_ecs_task_definition_arn" {
  description = "Terraform-managed Performance Worker ECS task definition ARN"
  value       = aws_ecs_task_definition.performance_worker.arn
}

output "performance_worker_work_items_concurrency" {
  description = "WorkItems concurrency configured for the Performance Worker task definition"
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
# Performance SageMaker Outputs
# ============================================
output "performance_sagemaker_model_name" {
  description = "SageMaker model name for the dedicated performance classifier"
  value       = aws_sagemaker_model.performance_classifier.name
}

output "performance_sagemaker_endpoint_config_name" {
  description = "SageMaker endpoint configuration name for the dedicated performance classifier"
  value       = aws_sagemaker_endpoint_configuration.performance_classifier.name
}

output "performance_sagemaker_endpoint_name" {
  description = "SageMaker endpoint name for the dedicated performance classifier"
  value       = aws_sagemaker_endpoint.performance_classifier.name
}

output "performance_sagemaker_endpoint_arn" {
  description = "SageMaker endpoint ARN for the dedicated performance classifier"
  value       = aws_sagemaker_endpoint.performance_classifier.arn
}

output "performance_sagemaker_variant_name" {
  description = "Production variant name for the dedicated performance classifier endpoint"
  value       = local.performance_sagemaker_variant_name
}

# ============================================
# Security Group / Demo AI / Connection Outputs
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

output "performance_api_url" {
  description = "Private internal ALB base URL for the Performance Backend API"
  value       = data.terraform_remote_state.performance_base.outputs.performance_api_url
}

output "performance_target_url" {
  description = "Private internal Demo AI chat completions endpoint URL"
  value       = data.terraform_remote_state.performance_base.outputs.performance_target_url
}

output "performance_target_model" {
  description = "OpenAI-compatible model value for the Demo AI target"
  value       = var.demo_ai_target_model
}

output "performance_target_revision" {
  description = "Immutable Demo AI image tag for performance-test traceability"
  value       = var.demo_ai_image_tag
}

# ============================================
# Canonical Experiment Snapshot Output
# ============================================
output "infrastructure_snapshot" {
  description = "Infrastructure configuration, expected capacity, resource identifiers, and endpoint connection snapshot consumed by the experiment entrypoint"
  value = {
    schema_version = 1
    id             = var.infrastructure_id
    revision       = var.infrastructure_revision
    app_image_tag  = var.app_image_tag
    expected = {
      ecs = {
        api = {
          cluster_identifier = data.terraform_remote_state.shared.outputs.ecs_cluster_name
          service_identifier = aws_ecs_service.performance_app.name
          task_cpu           = tostring(var.performance_api_cpu)
          task_memory        = tostring(var.performance_api_memory)
          desired_count      = var.performance_api_desired_count
        }
        worker = {
          cluster_identifier     = data.terraform_remote_state.shared.outputs.ecs_cluster_name
          service_identifier     = aws_ecs_service.performance_worker.name
          task_cpu               = tostring(var.performance_worker_cpu)
          task_memory            = tostring(var.performance_worker_memory)
          desired_count          = var.performance_worker_desired_count
          work_items_concurrency = var.performance_worker_work_items_concurrency
        }
      }
      rds = {
        db_instance_identifier = data.terraform_remote_state.performance_base.outputs.performance_rds_identifier
        db_instance_class      = var.expected_performance_rds_instance_class
      }
      sagemaker = {
        endpoint_name           = aws_sagemaker_endpoint.performance_classifier.name
        production_variant_name = local.performance_sagemaker_variant_name
        instance_type           = var.performance_sagemaker_instance_type
        desired_instance_count  = var.performance_sagemaker_instance_count
      }
    }
    resources = {
      ecs = {
        cluster_name = data.terraform_remote_state.shared.outputs.ecs_cluster_name
        cluster_arn  = data.terraform_remote_state.shared.outputs.ecs_cluster_arn
        api = {
          service_name        = aws_ecs_service.performance_app.name
          task_definition_arn = aws_ecs_task_definition.performance_app.arn
          log_group_name      = aws_cloudwatch_log_group.performance_app.name
        }
        worker = {
          service_name        = aws_ecs_service.performance_worker.name
          task_definition_arn = aws_ecs_task_definition.performance_worker.arn
          log_group_name      = aws_cloudwatch_log_group.performance_app.name
        }
        demo_ai = {
          service_name        = aws_ecs_service.demo_ai.name
          task_definition_arn = aws_ecs_task_definition.demo_ai.arn
          log_group_name      = aws_cloudwatch_log_group.demo_ai.name
        }
      }
      rds = {
        db_instance_identifier = data.terraform_remote_state.performance_base.outputs.performance_rds_identifier
      }
      sagemaker = {
        model_name              = aws_sagemaker_model.performance_classifier.name
        endpoint_config_name    = aws_sagemaker_endpoint_configuration.performance_classifier.name
        endpoint_name           = aws_sagemaker_endpoint.performance_classifier.name
        endpoint_arn            = aws_sagemaker_endpoint.performance_classifier.arn
        production_variant_name = local.performance_sagemaker_variant_name
      }
      sqs = {
        source_queue_urls  = data.terraform_remote_state.performance_base.outputs.performance_sqs_queue_urls
        source_queue_names = data.terraform_remote_state.performance_base.outputs.performance_sqs_queue_names
        dlq_urls           = data.terraform_remote_state.performance_base.outputs.performance_sqs_dead_letter_queue_urls
        dlq_names          = data.terraform_remote_state.performance_base.outputs.performance_sqs_dead_letter_queue_names
      }
    }
    api_url = data.terraform_remote_state.performance_base.outputs.performance_api_url
    target = {
      type     = "HTTP_ENDPOINT"
      url      = data.terraform_remote_state.performance_base.outputs.performance_target_url
      model    = var.demo_ai_target_model
      revision = var.demo_ai_image_tag
    }
  }
}
