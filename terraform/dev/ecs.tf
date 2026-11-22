locals {
  backend_service_desired_counts = merge(
    { app = 1, worker = var.dev_worker_min_capacity },
    var.backend_service_desired_counts,
  )

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
    { name = "SAGEMAKER_CLASSIFIER_ENDPOINT_NAME", value = local.sagemaker_classifier_endpoint_name },
    { name = "SAGEMAKER_CLASSIFIER_SYSTEM_PROMPT", value = replace(var.sagemaker_classifier_system_prompt, "\r\n", "\n") },
    { name = "SAGEMAKER_CLASSIFIER_USER_PROMPT_TEMPLATE", value = replace(var.sagemaker_classifier_user_prompt_template, "\r\n", "\n") },
    { name = "SPRING_TASK_SCHEDULING_POOL_SIZE", value = "4" },
  ]

  backend_dev_container = merge(local.backend_container_base, {
    environment = concat(local.backend_common_environment, [
      { name = "SQS_ENABLED", value = "true" },
      { name = "WORKER_ENABLED", value = "false" },
      { name = "SPRING_DATASOURCE_URL", value = "jdbc:postgresql://${aws_db_instance.app.address}:${var.db_port}/guardbench?sslmode=require" },
      { name = "GUARDBENCH_SQS_QUEUE_URLS_RESOLVE", value = aws_sqs_queue.source["gb-run-resolve"].url },
      { name = "GUARDBENCH_SQS_QUEUE_URLS_WORK_ITEMS", value = aws_sqs_queue.source["gb-workitems"].url },
      { name = "GUARDBENCH_SQS_QUEUE_URLS_RUN_FINALIZE", value = aws_sqs_queue.source["gb-run-finalize"].url },
    ])
    secrets = [
      { name = "SPRING_DATASOURCE_USERNAME", valueFrom = "${aws_db_instance.app.master_user_secret[0].secret_arn}:username::" },
      { name = "SPRING_DATASOURCE_PASSWORD", valueFrom = "${aws_db_instance.app.master_user_secret[0].secret_arn}:password::" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "app"
      }
    }
  })

  backend_dev_worker_container = merge(local.backend_container_base, {
    # Worker tasks poll SQS and are not registered with the public ALB.
    portMappings = []
    environment = concat(local.backend_common_environment, [
      { name = "SQS_ENABLED", value = "true" },
      { name = "WORKER_ENABLED", value = "true" },
      { name = "GUARDBENCH_WORKER_WORK_ITEMS_CONCURRENCY", value = tostring(var.dev_worker_work_items_concurrency) },
      { name = "SPRING_DATASOURCE_URL", value = "jdbc:postgresql://${aws_db_instance.app.address}:${var.db_port}/guardbench?sslmode=require" },
      { name = "GUARDBENCH_SQS_QUEUE_URLS_RESOLVE", value = aws_sqs_queue.source["gb-run-resolve"].url },
      { name = "GUARDBENCH_SQS_QUEUE_URLS_WORK_ITEMS", value = aws_sqs_queue.source["gb-workitems"].url },
      { name = "GUARDBENCH_SQS_QUEUE_URLS_RUN_FINALIZE", value = aws_sqs_queue.source["gb-run-finalize"].url },
    ])
    secrets = [
      { name = "SPRING_DATASOURCE_USERNAME", valueFrom = "${aws_db_instance.app.master_user_secret[0].secret_arn}:username::" },
      { name = "SPRING_DATASOURCE_PASSWORD", valueFrom = "${aws_db_instance.app.master_user_secret[0].secret_arn}:password::" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "worker"
      }
    }
  })
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.project}-${var.environment}/app"
  retention_in_days = 14
}

resource "aws_iam_role" "ecs_task_execution" {
  name = "${var.project}-${var.environment}-ecs-exec-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_exec_secrets" {
  name = "${var.project}-${var.environment}-ecs-exec-secrets"
  role = aws_iam_role.ecs_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_db_instance.app.master_user_secret[0].secret_arn]
    }]
  })
}

resource "aws_iam_role" "app_task" {
  name = "${var.project}-${var.environment}-app-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "app_task" {
  name = "${var.project}-${var.environment}-app-task-policy"
  role = aws_iam_role.app_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "InvokeClassifierEndpointOnly"
        Effect   = "Allow"
        Action   = ["sagemaker:InvokeEndpoint"]
        Resource = local.sagemaker_classifier_endpoint_arn
      },
      {
        Effect = "Allow"
        Action = [
          "sqs:SendMessage",
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
        ]
        Resource = [for queue in values(aws_sqs_queue.source) : queue.arn]
      },
      {
        Effect = "Allow"
        Action = [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ]
        Resource = "*"
      },
    ]
  })
}

resource "aws_ecs_task_definition" "app" {
  family                   = "${var.project}-${var.environment}-app"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.api_cpu
  memory                   = var.api_memory

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  execution_role_arn = aws_iam_role.ecs_task_execution.arn
  task_role_arn      = aws_iam_role.app_task.arn

  container_definitions = jsonencode([local.backend_dev_container])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.project}-${var.environment}-worker"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.api_cpu
  memory                   = var.api_memory

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  execution_role_arn = aws_iam_role.ecs_task_execution.arn
  task_role_arn      = aws_iam_role.app_task.arn

  container_definitions = jsonencode([local.backend_dev_worker_container])

  tags = {
    Name = "${var.project}-${var.environment}-worker"
    Role = "worker"
  }
}

resource "aws_ecs_service" "app" {
  name                              = "${var.project}-${var.environment}-app"
  cluster                           = data.terraform_remote_state.shared.outputs.ecs_cluster_id
  task_definition                   = aws_ecs_task_definition.app.arn
  desired_count                     = local.backend_service_desired_counts["app"]
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 120
  enable_execute_command            = true

  # GitHub Actions owns dev application task-definition revisions after the
  # initial service creation. Terraform continues to own the service shape
  # but must not roll the service back to its baseline revision.
  lifecycle {
    ignore_changes = [task_definition]
  }

  network_configuration {
    subnets          = data.terraform_remote_state.shared.outputs.private_subnet_ids
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "app"
    container_port   = var.api_container_port
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.http]
}

resource "aws_ecs_service" "worker" {
  name                   = "${var.project}-${var.environment}-worker"
  cluster                = data.terraform_remote_state.shared.outputs.ecs_cluster_id
  task_definition        = aws_ecs_task_definition.worker.arn
  desired_count          = local.backend_service_desired_counts["worker"]
  launch_type            = "FARGATE"
  enable_execute_command = true

  # Backend CI owns application task-definition revisions after the bootstrap
  # revision created by Terraform. Keep infrastructure shape and deployment
  # ownership separate so apply cannot roll back an application deployment.
  lifecycle {
    ignore_changes = [task_definition]
  }

  network_configuration {
    subnets          = data.terraform_remote_state.shared.outputs.private_subnet_ids
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = false
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}
