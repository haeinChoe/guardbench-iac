locals {
  sagemaker_classifier_endpoint_arn = trimspace(var.sagemaker_classifier_endpoint_name) != "" ? "arn:${data.aws_partition.current.partition}:sagemaker:${var.aws_region}:${data.aws_caller_identity.current.account_id}:endpoint/${var.sagemaker_classifier_endpoint_name}" : ""

  backend_container_base = {
    name      = "app"
    image     = "${data.terraform_remote_state.shared.outputs.ecr_repository_url}:${var.app_image_tag}"
    essential = true

    portMappings = [{
      containerPort = var.api_container_port
      protocol      = "tcp"
    }]
  }

  backend_common_environment = [
    { name = "SERVER_PORT", value = tostring(var.api_container_port) },
    { name = "SPRING_DOCKER_COMPOSE_ENABLED", value = "false" },
    { name = "AWS_REGION", value = var.aws_region },
    { name = "SAGEMAKER_CLASSIFIER_ENDPOINT_NAME", value = var.sagemaker_classifier_endpoint_name },
    { name = "SAGEMAKER_CLASSIFIER_SYSTEM_PROMPT", value = replace(var.sagemaker_classifier_system_prompt, "\r\n", "\n") },
    { name = "SAGEMAKER_CLASSIFIER_USER_PROMPT_TEMPLATE", value = replace(var.sagemaker_classifier_user_prompt_template, "\r\n", "\n") },
    { name = "SPRING_TASK_SCHEDULING_POOL_SIZE", value = "4" },
  ]

  performance_api_container = merge(local.backend_container_base, {
    environment = concat(local.backend_common_environment, [
      { name = "SQS_ENABLED", value = "true" },
      { name = "WORKER_ENABLED", value = "false" },
      { name = "GUARDBENCH_WORKER_WORK_ITEMS_CONCURRENCY", value = tostring(var.performance_worker_work_items_concurrency) },
      { name = "SPRING_DATASOURCE_URL", value = "jdbc:postgresql://${data.terraform_remote_state.performance_base.outputs.performance_rds_endpoint}:${data.terraform_remote_state.performance_base.outputs.db_port}/guardbench_perf?sslmode=require" },
      { name = "GUARDBENCH_SQS_QUEUE_URLS_RESOLVE", value = data.terraform_remote_state.performance_base.outputs.performance_sqs_queue_urls["gb-run-resolve"] },
      { name = "GUARDBENCH_SQS_QUEUE_URLS_WORK_ITEMS", value = data.terraform_remote_state.performance_base.outputs.performance_sqs_queue_urls["gb-workitems"] },
      { name = "GUARDBENCH_SQS_QUEUE_URLS_RUN_FINALIZE", value = data.terraform_remote_state.performance_base.outputs.performance_sqs_queue_urls["gb-run-finalize"] },
      {
        name = "SPRING_APPLICATION_JSON"
        value = jsonencode({
          "guardbench.http-endpoint.allow-private-addresses"   = false
          "guardbench.http-endpoint.allowed-private-hostnames" = [data.terraform_remote_state.performance_base.outputs.performance_api_alb_dns_name]
        })
      },
    ])
    secrets = [
      { name = "SPRING_DATASOURCE_USERNAME", valueFrom = "${data.terraform_remote_state.performance_base.outputs.performance_rds_master_secret_arn}:username::" },
      { name = "SPRING_DATASOURCE_PASSWORD", valueFrom = "${data.terraform_remote_state.performance_base.outputs.performance_rds_master_secret_arn}:password::" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.performance_app.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "performance-app"
      }
    }
  })

  performance_worker_container = merge(local.backend_container_base, {
    # Worker tasks do not register with a load balancer. Keep the application
    # port available for the common image, but expose no ECS service listener.
    portMappings = []
    environment = concat(local.backend_common_environment, [
      { name = "SQS_ENABLED", value = "true" },
      { name = "WORKER_ENABLED", value = "true" },
      { name = "GUARDBENCH_WORKER_WORK_ITEMS_CONCURRENCY", value = tostring(var.performance_worker_work_items_concurrency) },
      { name = "SPRING_DATASOURCE_URL", value = "jdbc:postgresql://${data.terraform_remote_state.performance_base.outputs.performance_rds_endpoint}:${data.terraform_remote_state.performance_base.outputs.db_port}/guardbench_perf?sslmode=require" },
      { name = "GUARDBENCH_SQS_QUEUE_URLS_RESOLVE", value = data.terraform_remote_state.performance_base.outputs.performance_sqs_queue_urls["gb-run-resolve"] },
      { name = "GUARDBENCH_SQS_QUEUE_URLS_WORK_ITEMS", value = data.terraform_remote_state.performance_base.outputs.performance_sqs_queue_urls["gb-workitems"] },
      { name = "GUARDBENCH_SQS_QUEUE_URLS_RUN_FINALIZE", value = data.terraform_remote_state.performance_base.outputs.performance_sqs_queue_urls["gb-run-finalize"] },
      {
        name = "SPRING_APPLICATION_JSON"
        value = jsonencode({
          "guardbench.http-endpoint.allow-private-addresses"   = false
          "guardbench.http-endpoint.allowed-private-hostnames" = [data.terraform_remote_state.performance_base.outputs.performance_api_alb_dns_name]
        })
      },
    ])
    secrets = [
      { name = "SPRING_DATASOURCE_USERNAME", valueFrom = "${data.terraform_remote_state.performance_base.outputs.performance_rds_master_secret_arn}:username::" },
      { name = "SPRING_DATASOURCE_PASSWORD", valueFrom = "${data.terraform_remote_state.performance_base.outputs.performance_rds_master_secret_arn}:password::" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.performance_app.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "performance-worker"
      }
    }
  })
}

resource "aws_cloudwatch_log_group" "performance_app" {
  name              = "/ecs/${var.project}-${var.environment}/performance-app"
  retention_in_days = 14

  tags = {
    Name    = "/ecs/${var.project}-${var.environment}/performance-app"
    Purpose = "performance-testing"
  }
}

resource "aws_iam_role" "performance_ecs_task_execution" {
  name = "${var.project}-${var.environment}-performance-ecs-exec-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })

  tags = {
    Name    = "${var.project}-${var.environment}-performance-ecs-exec-role"
    Purpose = "performance-testing"
  }
}

resource "aws_iam_role_policy_attachment" "performance_ecs_task_execution" {
  role       = aws_iam_role.performance_ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "performance_ecs_exec_secrets" {
  name = "${var.project}-${var.environment}-performance-ecs-exec-secrets"
  role = aws_iam_role.performance_ecs_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [data.terraform_remote_state.performance_base.outputs.performance_rds_master_secret_arn]
    }]
  })
}

resource "aws_iam_role" "performance_app_task" {
  name = "${var.project}-${var.environment}-performance-app-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })

  tags = {
    Name    = "${var.project}-${var.environment}-performance-app-task-role"
    Purpose = "performance-testing"
  }
}

data "aws_iam_policy_document" "performance_app_task" {
  dynamic "statement" {
    for_each = local.sagemaker_classifier_endpoint_arn != "" ? [1] : []

    content {
      sid       = "InvokeClassifierEndpointOnly"
      effect    = "Allow"
      actions   = ["sagemaker:InvokeEndpoint"]
      resources = [local.sagemaker_classifier_endpoint_arn]
    }
  }

  statement {
    effect = "Allow"
    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
    ]
    resources = values(data.terraform_remote_state.performance_base.outputs.performance_sqs_queue_arns)
  }

  statement {
    effect = "Allow"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "performance_app_task" {
  name   = "${var.project}-${var.environment}-performance-app-task-policy"
  role   = aws_iam_role.performance_app_task.id
  policy = data.aws_iam_policy_document.performance_app_task.json
}

resource "aws_ecs_task_definition" "performance_app" {
  family                   = "${var.project}-${var.environment}-performance-app"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.performance_api_cpu
  memory                   = var.performance_api_memory

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  execution_role_arn = aws_iam_role.performance_ecs_task_execution.arn
  task_role_arn      = aws_iam_role.performance_app_task.arn

  container_definitions = jsonencode([local.performance_api_container])

  tags = {
    Name    = "${var.project}-${var.environment}-performance-app"
    Purpose = "performance-testing"
  }
}

resource "aws_ecs_task_definition" "performance_worker" {
  family                   = "${var.project}-${var.environment}-performance-worker"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.performance_api_cpu
  memory                   = var.performance_api_memory

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  execution_role_arn = aws_iam_role.performance_ecs_task_execution.arn
  task_role_arn      = aws_iam_role.performance_app_task.arn

  container_definitions = jsonencode([local.performance_worker_container])

  tags = {
    Name    = "${var.project}-${var.environment}-performance-worker"
    Purpose = "performance-testing"
    Role    = "worker"
  }
}

resource "aws_ecs_service" "performance_app" {
  name                              = "${var.project}-${var.environment}-performance-app"
  cluster                           = data.terraform_remote_state.shared.outputs.ecs_cluster_id
  task_definition                   = aws_ecs_task_definition.performance_app.arn
  desired_count                     = var.performance_app_enabled ? var.performance_api_desired_count : 0
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 120
  enable_execute_command            = true

  network_configuration {
    subnets          = data.terraform_remote_state.shared.outputs.private_subnet_ids
    security_groups  = [aws_security_group.performance_api.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = data.terraform_remote_state.performance_base.outputs.performance_api_target_group_arn
    container_name   = "app"
    container_port   = var.api_container_port
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition]
  }
}

resource "aws_ecs_service" "performance_worker" {
  name                              = "${var.project}-${var.environment}-performance-worker"
  cluster                           = data.terraform_remote_state.shared.outputs.ecs_cluster_id
  task_definition                   = aws_ecs_task_definition.performance_worker.arn
  desired_count                     = var.performance_app_enabled ? var.performance_worker_desired_count : 0
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 120
  enable_execute_command            = true

  network_configuration {
    subnets          = data.terraform_remote_state.shared.outputs.private_subnet_ids
    security_groups  = [aws_security_group.performance_worker.id]
    assign_public_ip = false
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition]
  }
}
