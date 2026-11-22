# GitHub Actions OIDC provider is account-wide. Reuse an existing provider by
# setting github_oidc_provider_arn; otherwise this root creates it.
resource "aws_iam_openid_connect_provider" "github_actions" {
  count = var.github_oidc_provider_arn == null ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = {
    Name = "github-actions-oidc"
  }
}

locals {
  github_oidc_provider_arn = var.github_oidc_provider_arn != null ? var.github_oidc_provider_arn : aws_iam_openid_connect_provider.github_actions[0].arn
}

data "aws_iam_policy_document" "frontend_github_actions_assume_role" {
  statement {
    sid     = "GitHubActionsMainBranch"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      # GuardBench customizes GitHub OIDC subjects with immutable organization
      # and repository IDs. Keep the main ref suffix to restrict deployments.
      values = [
        "repo:GuardBench@316853045/guardbench-frontend@1346059955:ref:refs/heads/main",
      ]
    }
  }
}

# Inline permission policy lives in terraform/dev so the S3 bucket and
# CloudFront distribution ARNs stay inside the dev root.
resource "aws_iam_role" "frontend_github_actions_deploy" {
  name               = "${var.project}-${var.environment}-frontend-github-deploy"
  description        = "Deploy GuardBench dev frontend from GitHub Actions main branch"
  assume_role_policy = data.aws_iam_policy_document.frontend_github_actions_assume_role.json

  max_session_duration = 3600

  tags = {
    Name = "${var.project}-${var.environment}-frontend-github-deploy"
  }
}

data "aws_iam_policy_document" "backend_github_actions_assume_role" {
  statement {
    sid     = "GitHubActionsDevEnvironment"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      # Environment subjects do not contain a branch. Restrict the GitHub
      # dev environment's deployment branches/tags in repository settings.
      values = [
        "repo:GuardBench@316853045/guardbench-backend@1333885107:environment:dev",
      ]
    }
  }
}

# Inline permission policy lives in terraform/dev so dev ECS services and roles
# stay inside the dev root.
resource "aws_iam_role" "backend_github_actions_deploy" {
  name               = "${var.project}-${var.environment}-backend-github-deploy"
  description        = "Deploy GuardBench dev backend from GitHub Actions via OIDC"
  assume_role_policy = data.aws_iam_policy_document.backend_github_actions_assume_role.json

  max_session_duration = 3600

  tags = {
    Name = "${var.project}-${var.environment}-backend-github-deploy"
  }
}
