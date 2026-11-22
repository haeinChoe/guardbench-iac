locals {
  backend_performance_task_definition_family_arn        = "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.project}-${var.environment}-performance-app:*"
  backend_performance_worker_task_definition_family_arn = "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.project}-${var.environment}-performance-worker:*"
  backend_performance_ecs_service_arn                   = "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${data.terraform_remote_state.shared.outputs.ecs_cluster_name}/${aws_ecs_service.performance_app.name}"
  backend_performance_worker_ecs_service_arn            = "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${data.terraform_remote_state.shared.outputs.ecs_cluster_name}/${aws_ecs_service.performance_worker.name}"
}

data "aws_iam_policy_document" "backend_performance_github_actions_assume_role" {
  statement {
    sid     = "GitHubActionsPerformanceEnvironment"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.terraform_remote_state.shared.outputs.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:GuardBench@316853045/guardbench-backend@1333885107:environment:performance",
      ]
    }
  }
}

resource "aws_iam_role" "backend_performance_github_actions_deploy" {
  name               = "${var.project}-${var.environment}-performance-backend-deploy"
  description        = "Deploy GuardBench performance backend from GitHub Actions performance environment"
  assume_role_policy = data.aws_iam_policy_document.backend_performance_github_actions_assume_role.json

  max_session_duration = 3600

  tags = {
    Name    = "${var.project}-${var.environment}-performance-backend-deploy"
    Purpose = "performance-testing"
  }
}

data "aws_iam_policy_document" "backend_performance_github_actions_deploy" {
  statement {
    sid       = "CallerIdentity"
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }

  statement {
    sid       = "EcrAuthorization"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PushPerformanceBackendImage"
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
    sid     = "RegisterPerformanceTaskDefinition"
    effect  = "Allow"
    actions = ["ecs:RegisterTaskDefinition"]
    resources = [
      local.backend_performance_task_definition_family_arn,
      local.backend_performance_worker_task_definition_family_arn,
    ]
  }

  statement {
    sid     = "DescribePerformanceService"
    effect  = "Allow"
    actions = ["ecs:DescribeServices"]
    resources = [
      local.backend_performance_ecs_service_arn,
      local.backend_performance_worker_ecs_service_arn,
    ]
  }

  statement {
    sid     = "UpdatePerformanceService"
    effect  = "Allow"
    actions = ["ecs:UpdateService"]
    resources = [
      local.backend_performance_ecs_service_arn,
      local.backend_performance_worker_ecs_service_arn,
    ]

    condition {
      test     = "ArnLike"
      variable = "ecs:task-definition"
      values = [
        local.backend_performance_task_definition_family_arn,
        local.backend_performance_worker_task_definition_family_arn,
      ]
    }
  }

  statement {
    sid       = "PassEcsTaskRoles"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.performance_ecs_task_execution.arn, aws_iam_role.performance_app_task.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "backend_performance_github_actions_deploy" {
  name   = "${var.project}-${var.environment}-performance-backend-deploy"
  role   = aws_iam_role.backend_performance_github_actions_deploy.id
  policy = data.aws_iam_policy_document.backend_performance_github_actions_deploy.json
}
