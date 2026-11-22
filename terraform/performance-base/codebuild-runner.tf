# Private VPC CodeBuild project running the GuardBench performance Runner.
# Traffic to the Performance Backend API and Demo AI Target (/v1/chat/completions)
# traverses the internal Performance ALB on port 80.

resource "aws_cloudwatch_log_group" "performance_codebuild_runner" {
  name              = "/codebuild/${var.project}-${var.environment}-performance-runner"
  retention_in_days = 14

  tags = {
    Name        = "/codebuild/${var.project}-${var.environment}-performance-runner"
    Environment = "performance"
    Purpose     = "performance-testing"
  }
}

resource "aws_security_group" "performance_codebuild_runner" {
  name        = "${var.project}-${var.environment}-performance-codebuild-sg"
  description = "Private VPC CodeBuild Runner calling internal Performance ALB and HTTPS dependencies"
  vpc_id      = data.terraform_remote_state.shared.outputs.vpc_id

  tags = {
    Name        = "${var.project}-${var.environment}-performance-codebuild-sg"
    Environment = "performance"
    Purpose     = "performance-testing"
  }
}

resource "aws_security_group_rule" "performance_codebuild_runner_egress_to_performance_alb" {
  type                     = "egress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.performance_api_alb.id
  description              = "Reach Performance API and Demo AI route through internal ALB"
  security_group_id        = aws_security_group.performance_codebuild_runner.id
}

resource "aws_security_group_rule" "performance_api_alb_ingress_from_codebuild_runner" {
  type                     = "ingress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.performance_codebuild_runner.id
  description              = "Allow private CodeBuild Runner requests to internal Performance ALB"
  security_group_id        = aws_security_group.performance_api_alb.id
}

resource "aws_security_group_rule" "performance_codebuild_runner_egress_to_vpc_endpoints" {
  type                     = "egress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  source_security_group_id = data.terraform_remote_state.shared.outputs.vpc_endpoints_security_group_id
  description              = "Reach CloudWatch Logs and AWS interface endpoints over HTTPS"
  security_group_id        = aws_security_group.performance_codebuild_runner.id
}

resource "aws_security_group_rule" "vpc_endpoints_ingress_from_performance_codebuild_runner" {
  type                     = "ingress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.performance_codebuild_runner.id
  description              = "HTTPS from performance CodeBuild Runner"
  security_group_id        = data.terraform_remote_state.shared.outputs.vpc_endpoints_security_group_id
}

resource "aws_security_group_rule" "performance_codebuild_runner_egress_to_s3_gateway" {
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  prefix_list_ids   = [data.terraform_remote_state.shared.outputs.vpc_endpoint_s3_prefix_list_id]
  description       = "Upload Runner artifacts through S3 Gateway endpoint"
  security_group_id = aws_security_group.performance_codebuild_runner.id
}

resource "aws_security_group_rule" "performance_codebuild_runner_egress_https" {
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "GitHub backend checkout, k6 release tarball, and Python packages via NAT Gateway"
  security_group_id = aws_security_group.performance_codebuild_runner.id
}

resource "aws_iam_role" "performance_codebuild_runner" {
  name = "${var.project}-${var.environment}-performance-codebuild-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "codebuild.amazonaws.com" }
    }]
  })

  tags = {
    Name        = "${var.project}-${var.environment}-performance-codebuild-role"
    Environment = "performance"
    Purpose     = "performance-testing"
  }
}

data "aws_iam_policy_document" "performance_codebuild_runner" {
  statement {
    sid    = "WriteCodeBuildLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      aws_cloudwatch_log_group.performance_codebuild_runner.arn,
      "${aws_cloudwatch_log_group.performance_codebuild_runner.arn}:*",
    ]
  }

  statement {
    sid    = "DescribeVpcNetworking"
    effect = "Allow"
    actions = [
      "ec2:CreateNetworkInterface",
      "ec2:DeleteNetworkInterface",
      "ec2:DescribeDhcpOptions",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeSubnets",
      "ec2:DescribeVpcs",
    ]
    resources = ["*"]
  }

  statement {
    sid     = "CreatePrivateSubnetEniPermission"
    effect  = "Allow"
    actions = ["ec2:CreateNetworkInterfacePermission"]
    resources = [
      "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:network-interface/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "ec2:AuthorizedService"
      values   = ["codebuild.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "ec2:Subnet"
      values = [
        for subnet_id in data.terraform_remote_state.shared.outputs.private_subnet_ids :
        "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:subnet/${subnet_id}"
      ]
    }
  }

  statement {
    sid     = "InspectResultsBucket"
    effect  = "Allow"
    actions = ["s3:GetBucketLocation"]
    resources = [
      aws_s3_bucket.performance_results.arn,
    ]
  }

  statement {
    sid    = "UploadRunnerResults"
    effect = "Allow"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
    ]
    resources = [
      "${aws_s3_bucket.performance_results.arn}/*",
    ]
  }
}

resource "aws_iam_role_policy" "performance_codebuild_runner" {
  name   = "${var.project}-${var.environment}-performance-codebuild-policy"
  role   = aws_iam_role.performance_codebuild_runner.id
  policy = data.aws_iam_policy_document.performance_codebuild_runner.json
}

resource "aws_codebuild_project" "performance_runner" {
  name                   = "${var.project}-${var.environment}-performance-runner"
  description            = "Runs GuardBench performance scenarios from a pinned backend commit against private performance API"
  service_role           = aws_iam_role.performance_codebuild_runner.arn
  build_timeout          = var.performance_codebuild_timeout_minutes
  concurrent_build_limit = 1

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type                = var.performance_codebuild_compute_type
    image                       = var.performance_codebuild_image
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "BACKEND_REPO_URL"
      value = var.backend_repository_url
    }
  }

  source {
    type      = "NO_SOURCE"
    buildspec = file("${path.module}/../../codebuild/performance-runner.buildspec.yml")
  }

  vpc_config {
    vpc_id             = data.terraform_remote_state.shared.outputs.vpc_id
    subnets            = data.terraform_remote_state.shared.outputs.private_subnet_ids
    security_group_ids = [aws_security_group.performance_codebuild_runner.id]
  }

  logs_config {
    cloudwatch_logs {
      status      = "ENABLED"
      group_name  = aws_cloudwatch_log_group.performance_codebuild_runner.name
      stream_name = "runner"
    }
  }

  depends_on = [aws_iam_role_policy.performance_codebuild_runner]

  tags = {
    Name        = "${var.project}-${var.environment}-performance-runner"
    Environment = "performance"
    Purpose     = "performance-testing"
  }
}
