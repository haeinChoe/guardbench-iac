# Permissions boundary for every IAM role created by the performance-experiment root.
# It is the upper bound of what those roles can ever be granted. It lives in this root so the
# experiment OIDC role cannot edit it: that role may create or modify experiment roles only
# while they carry this boundary, and it is explicitly denied from changing the policy itself.

locals {
  experiment_boundary_log_stream_arns = [for log_arn in local.experiment_log_group_arns : "${log_arn}:*"]
  experiment_sagemaker_log_group_arns = [
    "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/sagemaker/*",
    "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/sagemaker/*:*",
  ]
  experiment_jumpstart_bucket_arn = "arn:${data.aws_partition.current.partition}:s3:::jumpstart-cache-prod-${var.aws_region}"
}

data "aws_iam_policy_document" "performance_experiment_boundary" {
  # ECS task execution (image pull) and SageMaker serving container pull.
  statement {
    sid    = "PullContainerImages"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetAuthorizationToken",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = ["*"]
  }

  # ECS task execution: awslogs driver.
  statement {
    sid    = "WriteEcsTaskLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = local.experiment_boundary_log_stream_arns
  }

  # ECS task execution: Performance RDS master secret injected into containers.
  statement {
    sid       = "ReadPerformanceRdsSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.performance.master_user_secret[0].secret_arn]
  }

  # Performance API and Worker tasks: classifier endpoint and performance queues.
  statement {
    sid       = "InvokePerformanceClassifierEndpoint"
    effect    = "Allow"
    actions   = ["sagemaker:InvokeEndpoint"]
    resources = ["arn:${data.aws_partition.current.partition}:sagemaker:${var.aws_region}:${data.aws_caller_identity.current.account_id}:endpoint/${var.project}-${var.environment}-performance-*"]
  }

  statement {
    sid    = "UsePerformanceQueues"
    effect = "Allow"
    actions = [
      "sqs:DeleteMessage",
      "sqs:ReceiveMessage",
      "sqs:SendMessage",
    ]
    resources = [for queue in aws_sqs_queue.performance_source : queue.arn]
  }

  # Task roles: ECS Exec message channels.
  statement {
    sid    = "EcsExecMessageChannels"
    effect = "Allow"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }

  # Demo AI task: Bedrock inference through account inference profiles and their routed foundation models.
  statement {
    sid     = "InvokeDemoAiBedrockModels"
    effect  = "Allow"
    actions = ["bedrock:InvokeModel"]
    resources = [
      "arn:${data.aws_partition.current.partition}:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/*",
      "arn:${data.aws_partition.current.partition}:bedrock:*::foundation-model/*",
    ]
  }

  # SageMaker execution role: model artifacts and endpoint logs.
  statement {
    sid       = "ListSageMakerModelArtifactBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [local.experiment_jumpstart_bucket_arn]
  }

  statement {
    sid       = "ReadSageMakerModelArtifacts"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${local.experiment_jumpstart_bucket_arn}/*"]
  }

  statement {
    sid    = "WriteSageMakerEndpointLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = local.experiment_sagemaker_log_group_arns
  }
}

resource "aws_iam_policy" "performance_experiment_boundary" {
  name        = "${var.project}-${var.environment}-perf-experiment-boundary"
  description = "Maximum permissions for IAM roles created by the performance experiment root"
  policy      = data.aws_iam_policy_document.performance_experiment_boundary.json

  tags = {
    Name        = "${var.project}-${var.environment}-perf-experiment-boundary"
    Environment = "performance"
    Purpose     = "performance-testing"
  }
}
