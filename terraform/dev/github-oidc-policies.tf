locals {
  backend_task_definition_family_arn        = "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.project}-${var.environment}-app:*"
  backend_worker_task_definition_family_arn = "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.project}-${var.environment}-worker:*"
  backend_ecs_service_arn                   = "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${data.terraform_remote_state.shared.outputs.ecs_cluster_name}/${aws_ecs_service.app.name}"
  backend_worker_ecs_service_arn            = "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${data.terraform_remote_state.shared.outputs.ecs_cluster_name}/${aws_ecs_service.worker.name}"
}

data "aws_iam_policy_document" "frontend_github_actions_deploy" {
  statement {
    sid = "ReadFrontendBucket"
    actions = [
      "s3:GetBucketLocation",
      "s3:ListBucket",
    ]
    resources = [aws_s3_bucket.frontend.arn]
  }

  statement {
    sid = "SyncFrontendObjects"
    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]
  }

  statement {
    sid       = "InvalidateFrontendDistribution"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = [aws_cloudfront_distribution.frontend.arn]
  }
}

resource "aws_iam_role_policy" "frontend_github_actions_deploy" {
  name   = "${var.project}-${var.environment}-frontend-deploy"
  role   = data.terraform_remote_state.shared.outputs.frontend_github_actions_role_name
  policy = data.aws_iam_policy_document.frontend_github_actions_deploy.json
}

data "aws_iam_policy_document" "backend_github_actions_deploy" {
  statement {
    sid       = "EcrAuthorization"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PushBackendImage"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [data.terraform_remote_state.shared.outputs.ecr_repository_arn]
  }

  statement {
    sid       = "DescribeTaskDefinition"
    effect    = "Allow"
    actions   = ["ecs:DescribeTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid       = "RegisterAppTaskDefinition"
    effect    = "Allow"
    actions   = ["ecs:RegisterTaskDefinition"]
    resources = [local.backend_task_definition_family_arn]
  }

  statement {
    sid       = "DescribeAppService"
    effect    = "Allow"
    actions   = ["ecs:DescribeServices"]
    resources = [local.backend_ecs_service_arn]
  }

  statement {
    sid       = "UpdateAppService"
    effect    = "Allow"
    actions   = ["ecs:UpdateService"]
    resources = [local.backend_ecs_service_arn]

    condition {
      test     = "ArnLike"
      variable = "ecs:task-definition"
      values   = [local.backend_task_definition_family_arn]
    }
  }

  statement {
    sid       = "RegisterWorkerTaskDefinition"
    effect    = "Allow"
    actions   = ["ecs:RegisterTaskDefinition"]
    resources = [local.backend_worker_task_definition_family_arn]
  }

  statement {
    sid       = "DescribeWorkerService"
    effect    = "Allow"
    actions   = ["ecs:DescribeServices"]
    resources = [local.backend_worker_ecs_service_arn]
  }

  statement {
    sid       = "UpdateWorkerService"
    effect    = "Allow"
    actions   = ["ecs:UpdateService"]
    resources = [local.backend_worker_ecs_service_arn]

    condition {
      test     = "ArnLike"
      variable = "ecs:task-definition"
      values   = [local.backend_worker_task_definition_family_arn]
    }
  }

  statement {
    sid       = "PassEcsTaskRoles"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.ecs_task_execution.arn, aws_iam_role.app_task.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "backend_github_actions_deploy" {
  name   = "${var.project}-${var.environment}-backend-deploy"
  role   = data.terraform_remote_state.shared.outputs.backend_github_actions_role_name
  policy = data.aws_iam_policy_document.backend_github_actions_deploy.json
}
