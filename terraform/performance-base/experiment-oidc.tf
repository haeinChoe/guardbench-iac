# Dedicated GitHub OIDC role for the single performance experiment entrypoint workflow.
# Grants permissions strictly scoped to the shared/performance-base read-only state,
# performance-experiment state and resources, CodeBuild Runner project, results S3,
# CloudWatch metrics/logs, performance SQS queues, and performance RDS metadata.

locals {
  experiment_ecs_cluster_name = data.terraform_remote_state.shared.outputs.ecs_cluster_name
  experiment_oidc_role_prefix = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.project}-${var.environment}"
  experiment_ecs_task_def_arns = [
    "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.project}-${var.environment}-performance-app",
    "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.project}-${var.environment}-performance-app:*",
    "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.project}-${var.environment}-performance-worker",
    "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.project}-${var.environment}-performance-worker:*",
    "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.project}-${var.environment}-demo-ai",
    "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.project}-${var.environment}-demo-ai:*",
  ]
  experiment_ecs_service_arns = [
    "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${local.experiment_ecs_cluster_name}/${var.project}-${var.environment}-performance-app",
    "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${local.experiment_ecs_cluster_name}/${var.project}-${var.environment}-performance-worker",
    "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${local.experiment_ecs_cluster_name}/${var.project}-${var.environment}-demo-ai",
  ]
  experiment_ecs_role_arns = [
    "${local.experiment_oidc_role_prefix}-performance-ecs-exec-role",
    "${local.experiment_oidc_role_prefix}-performance-app-task-role",
    "${local.experiment_oidc_role_prefix}-demo-ai-exec-role",
    "${local.experiment_oidc_role_prefix}-demo-ai-task-role",
  ]
  experiment_sagemaker_role_arn = "${local.experiment_oidc_role_prefix}-performance-sagemaker-exec-role"
  experiment_log_group_arns = [
    "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/ecs/${var.project}-${var.environment}/performance-app",
    "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/ecs/${var.project}-${var.environment}/demo-ai",
  ]
  experiment_base_sg_arns = [
    "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:security-group/${data.terraform_remote_state.shared.outputs.vpc_endpoints_security_group_id}",
    aws_security_group.performance_rds.arn,
    aws_security_group.performance_api_alb.arn,
    aws_security_group.performance_codebuild_runner.arn,
  ]
}

data "aws_iam_policy_document" "performance_experiment_assume_role" {
  statement {
    sid     = "GitHubActionsPerformanceEntrypoint"
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

    # GitHub environment subjects omit ref/branch. Restrict the performance-experiment
    # environment's deployment branches to dev in repository settings.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.performance_experiment_github_repository}:environment:${var.performance_experiment_github_environment}",
      ]
    }
  }
}

resource "aws_iam_role" "performance_experiment_github_actions" {
  name                 = "${var.project}-${var.environment}-perf-experiment-gha-role"
  description          = "Run performance experiment lifecycle from guardbench-iac entrypoint workflow via GitHub OIDC"
  assume_role_policy   = data.aws_iam_policy_document.performance_experiment_assume_role.json
  max_session_duration = 7200

  tags = {
    Name        = "${var.project}-${var.environment}-perf-experiment-gha-role"
    Environment = "performance"
    Purpose     = "performance-testing"
  }
}

data "aws_iam_policy_document" "performance_experiment" {
  # Remote state access: shared & performance-base read-only, performance-experiment read-write.
  statement {
    sid    = "ListStateBucketForExperiment"
    effect = "Allow"
    actions = [
      "s3:GetBucketLocation",
      "s3:ListBucket",
    ]
    resources = ["arn:${data.aws_partition.current.partition}:s3:::${var.remote_state_bucket}"]
  }

  statement {
    sid     = "ReadUpstreamPerformanceState"
    effect  = "Allow"
    actions = ["s3:GetObject"]
    resources = [
      "arn:${data.aws_partition.current.partition}:s3:::${var.remote_state_bucket}/${var.shared_state_key}",
      "arn:${data.aws_partition.current.partition}:s3:::${var.remote_state_bucket}/${var.performance_base_state_key}",
    ]
  }

  statement {
    sid    = "ReadWritePerformanceExperimentState"
    effect = "Allow"
    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:s3:::${var.remote_state_bucket}/${var.performance_experiment_state_key}",
      "arn:${data.aws_partition.current.partition}:s3:::${var.remote_state_bucket}/${var.performance_experiment_state_key}.tflock",
    ]
  }

  # Experiment ECS task definitions, services, and tasks.
  statement {
    sid       = "DescribeSharedEcsCluster"
    effect    = "Allow"
    actions   = ["ecs:DescribeClusters"]
    resources = [data.terraform_remote_state.shared.outputs.ecs_cluster_arn]
  }

  statement {
    sid    = "ReadEcsTaskDefinitions"
    effect = "Allow"
    actions = [
      "ecs:DescribeTaskDefinition",
      "ecs:ListTaskDefinitions",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ManageExperimentTaskDefinitions"
    effect = "Allow"
    actions = [
      "ecs:DeleteTaskDefinitions",
      "ecs:DeregisterTaskDefinition",
      "ecs:ListTagsForResource",
      "ecs:RegisterTaskDefinition",
      "ecs:TagResource",
    ]
    resources = local.experiment_ecs_task_def_arns
  }

  statement {
    sid    = "ManageExperimentEcsServices"
    effect = "Allow"
    actions = [
      "ecs:CreateService",
      "ecs:DeleteService",
      "ecs:DescribeServices",
      "ecs:ListTagsForResource",
      "ecs:TagResource",
      "ecs:UntagResource",
      "ecs:UpdateService",
    ]
    resources = local.experiment_ecs_service_arns
  }

  statement {
    sid    = "InspectExperimentClusterTasks"
    effect = "Allow"
    actions = [
      "ecs:DescribeTasks",
      "ecs:ListTasks",
    ]
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [data.terraform_remote_state.shared.outputs.ecs_cluster_arn]
    }
  }

  # Dedicated performance SageMaker classifier lifecycle.
  statement {
    sid    = "ManagePerformanceSageMaker"
    effect = "Allow"
    actions = [
      "sagemaker:AddTags",
      "sagemaker:CreateEndpoint",
      "sagemaker:CreateEndpointConfig",
      "sagemaker:CreateModel",
      "sagemaker:DeleteEndpoint",
      "sagemaker:DeleteEndpointConfig",
      "sagemaker:DeleteModel",
      "sagemaker:DeleteTags",
      "sagemaker:DescribeEndpoint",
      "sagemaker:DescribeEndpointConfig",
      "sagemaker:DescribeModel",
      "sagemaker:ListTags",
      "sagemaker:UpdateEndpoint",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:sagemaker:${var.aws_region}:${data.aws_caller_identity.current.account_id}:model/${var.project}-${var.environment}-performance-*",
      "arn:${data.aws_partition.current.partition}:sagemaker:${var.aws_region}:${data.aws_caller_identity.current.account_id}:endpoint-config/${var.project}-${var.environment}-perf-*",
      "arn:${data.aws_partition.current.partition}:sagemaker:${var.aws_region}:${data.aws_caller_identity.current.account_id}:endpoint/${var.project}-${var.environment}-performance-*",
    ]
  }

  # Experiment IAM roles and service-scoped PassRole.
  statement {
    sid    = "ManageExperimentIamRoles"
    effect = "Allow"
    actions = [
      "iam:AttachRolePolicy",
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
    ]
    resources = concat(local.experiment_ecs_role_arns, [local.experiment_sagemaker_role_arn])
  }

  statement {
    sid       = "PassExperimentEcsRoles"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = local.experiment_ecs_role_arns

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid       = "PassPerformanceSageMakerRole"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [local.experiment_sagemaker_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["sagemaker.amazonaws.com"]
    }
  }

  # CloudWatch Logs management for experiment services and query access including CodeBuild logs.
  statement {
    sid    = "DescribeLogGroupsAndQueries"
    effect = "Allow"
    actions = [
      "logs:DescribeLogGroups",
      "logs:GetQueryResults",
      "logs:StopQuery",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ManageExperimentLogGroups"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:DeleteLogGroup",
      "logs:ListTagsForResource",
      "logs:PutRetentionPolicy",
      "logs:TagResource",
      "logs:UntagResource",
    ]
    resources = local.experiment_log_group_arns
  }

  statement {
    sid    = "QueryPerformanceLogs"
    effect = "Allow"
    actions = [
      "logs:DescribeLogStreams",
      "logs:FilterLogEvents",
      "logs:GetLogEvents",
      "logs:StartQuery",
    ]
    resources = concat(
      local.experiment_log_group_arns,
      [for log_arn in local.experiment_log_group_arns : "${log_arn}:*"],
      [
        aws_cloudwatch_log_group.performance_codebuild_runner.arn,
        "${aws_cloudwatch_log_group.performance_codebuild_runner.arn}:*",
      ],
    )
  }

  # EC2 security group lifecycle strictly isolated to performance-testing tagged SGs and base/shared attachment targets.
  statement {
    sid    = "DescribeVpcSecurityGroups"
    effect = "Allow"
    actions = [
      "ec2:DescribeAccountAttributes",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DescribeSecurityGroupRules",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeSubnets",
      "ec2:DescribeTags",
      "ec2:DescribeVpcs",
    ]
    resources = ["*"]
  }

  statement {
    sid     = "CreateExperimentSecurityGroupInSharedVpc"
    effect  = "Allow"
    actions = ["ec2:CreateSecurityGroup"]
    resources = [
      "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:vpc/${data.terraform_remote_state.shared.outputs.vpc_id}",
    ]
  }

  statement {
    sid     = "CreateTaggedExperimentSecurityGroup"
    effect  = "Allow"
    actions = ["ec2:CreateSecurityGroup"]
    resources = [
      "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:security-group/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Purpose"
      values   = ["performance-testing"]
    }
  }

  statement {
    sid     = "TagExperimentSecurityGroupsOnCreate"
    effect  = "Allow"
    actions = ["ec2:CreateTags"]
    resources = [
      "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:security-group/*",
      "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:security-group-rule/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Purpose"
      values   = ["performance-testing"]
    }
  }

  statement {
    sid    = "ManageTaggedExperimentSecurityGroups"
    effect = "Allow"
    actions = [
      "ec2:AuthorizeSecurityGroupEgress",
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:DeleteSecurityGroup",
      "ec2:DeleteTags",
      "ec2:RevokeSecurityGroupEgress",
      "ec2:RevokeSecurityGroupIngress",
      "ec2:UpdateSecurityGroupRuleDescriptionsEgress",
      "ec2:UpdateSecurityGroupRuleDescriptionsIngress",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:security-group/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Purpose"
      values   = ["performance-testing"]
    }
  }

  statement {
    sid    = "ManageCrossRootPerformanceSecurityGroupRules"
    effect = "Allow"
    actions = [
      "ec2:AuthorizeSecurityGroupEgress",
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:RevokeSecurityGroupEgress",
      "ec2:RevokeSecurityGroupIngress",
      "ec2:UpdateSecurityGroupRuleDescriptionsEgress",
      "ec2:UpdateSecurityGroupRuleDescriptionsIngress",
    ]
    resources = local.experiment_base_sg_arns
  }

  # CodeBuild execution for this project only.
  statement {
    sid    = "RunPerformanceCodeBuild"
    effect = "Allow"
    actions = [
      "codebuild:BatchGetBuilds",
      "codebuild:StartBuild",
      "codebuild:StopBuild",
    ]
    resources = [aws_codebuild_project.performance_runner.arn]
  }

  # Performance results S3 bucket access.
  statement {
    sid    = "InspectPerformanceResultsBucket"
    effect = "Allow"
    actions = [
      "s3:GetBucketLocation",
      "s3:ListBucket",
    ]
    resources = [aws_s3_bucket.performance_results.arn]
  }

  statement {
    sid    = "ReadWritePerformanceResultsObjects"
    effect = "Allow"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetObject",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.performance_results.arn}/*"]
  }

  # CloudWatch metrics and preflight/drain observations for performance infrastructure.
  statement {
    sid    = "ReadCloudWatchMetrics"
    effect = "Allow"
    actions = [
      "cloudwatch:GetMetricData",
      "cloudwatch:GetMetricStatistics",
      "cloudwatch:ListMetrics",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "InspectPerformanceQueues"
    effect = "Allow"
    actions = [
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
    ]
    resources = concat(
      [for queue in aws_sqs_queue.performance_source : queue.arn],
      [for queue in aws_sqs_queue.performance_dead_letter : queue.arn],
    )
  }

  statement {
    sid       = "DescribePerformanceRds"
    effect    = "Allow"
    actions   = ["rds:DescribeDBInstances"]
    resources = [aws_db_instance.performance.arn]
  }
}

resource "aws_iam_role_policy" "performance_experiment_github_actions" {
  name   = "${var.project}-${var.environment}-perf-experiment-gha-policy"
  role   = aws_iam_role.performance_experiment_github_actions.id
  policy = data.aws_iam_policy_document.performance_experiment.json
}
