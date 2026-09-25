# Read-only permissions used by the backend repository's manual Performance
# analysis workflow. Keep this separate from deploy permissions so the added
# access is explicit and limited to Performance result/diagnostic resources.
data "aws_iam_policy_document" "performance_analysis_github_read" {
  statement {
    sid    = "ReadPerformanceResultsBucket"
    effect = "Allow"
    actions = [
      "s3:GetBucketLocation",
      "s3:ListBucket",
    ]
    resources = [aws_s3_bucket.performance_results.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["performance/results/*"]
    }
  }

  statement {
    sid       = "ReadPerformanceResultObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.performance_results.arn}/performance/results/*"]
  }

  statement {
    sid    = "QueryPerformanceApplicationLogs"
    effect = "Allow"
    actions = [
      "logs:StartQuery",
      "logs:GetQueryResults",
    ]
    resources = ["${aws_cloudwatch_log_group.performance_app.arn}:*"]
  }
}

resource "aws_iam_role_policy" "performance_analysis_github_read" {
  name   = "${var.project}-${var.environment}-performance-analysis-read"
  role   = aws_iam_role.backend_performance_github_actions_deploy.id
  policy = data.aws_iam_policy_document.performance_analysis_github_read.json
}
