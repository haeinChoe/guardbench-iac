# Dedicated Response Behavior Classifier served by SageMaker LMI/vLLM for performance experiments.
locals {
  # aws_sagemaker_model has no name_prefix argument. The model name is the prefix plus a short hash of the
  # model definition, so a changed definition gets a new name and create_before_destroy can replace it
  # without a name conflict. SageMaker model names allow 63 characters.
  performance_sagemaker_model_name_prefix = "${var.project}-${var.environment}-perf-qwen3-4b-"
  performance_sagemaker_endpoint_name     = "${var.project}-${var.environment}-performance-qwen3-4b-endpoint"
  performance_sagemaker_variant_name      = "AllTraffic"
  performance_sagemaker_jumpstart_bucket  = "jumpstart-cache-prod-${var.aws_region}"

  performance_sagemaker_container = {
    image          = coalesce(var.performance_sagemaker_container_image, "763104351884.dkr.ecr.${var.aws_region}.amazonaws.com/djl-inference:0.36.0-lmi18.0.0-cu128")
    model_data_uri = "s3://${local.performance_sagemaker_jumpstart_bucket}/huggingface-reasoning/huggingface-reasoning-qwen3-4b/artifacts/inference-prepack/v2.0.0/"
    environment = {
      ENDPOINT_SERVER_TIMEOUT        = "3600"
      HF_MODEL_ID                    = "/opt/ml/model"
      MAX_BATCH_SIZE                 = "128"
      MAX_CONCURRENT_REQUESTS        = "256"
      MODEL_CACHE_ROOT               = "/opt/ml/model"
      OPTION_DTYPE                   = "fp16"
      OPTION_ENABLE_CHUNKED_PREFILL  = "true"
      OPTION_GPU_MEMORY_UTILIZATION  = "0.88"
      OPTION_MAX_MODEL_LEN           = "40960"
      OPTION_MAX_NUM_BATCHED_TOKENS  = "81920"
      OPTION_MAX_ROLLING_BATCH_SIZE  = "128"
      OPTION_TENSOR_PARALLEL_DEGREE  = "1"
      OPTION_TOOL_CALL_PARSER        = "hermes"
      SAGEMAKER_ENV                  = "1"
      SAGEMAKER_MODEL_SERVER_TIMEOUT = "3600"
      SAGEMAKER_MODEL_SERVER_WORKERS = "1"
      SAGEMAKER_PROGRAM              = "inference.py"
      SAGEMAKER_SUBMIT_DIRECTORY     = "/opt/ml/model/code"
      TENSOR_PARALLEL_DEGREE         = "1"
      VLLM_ALLOW_LONG_MAX_MODEL_LEN  = "1"
    }
  }

  performance_sagemaker_model_name = "${local.performance_sagemaker_model_name_prefix}${substr(sha256(jsonencode([
    aws_iam_role.performance_sagemaker_execution.arn,
    local.performance_sagemaker_container,
  ])), 0, 12)}"
}

resource "aws_iam_role" "performance_sagemaker_execution" {
  name                 = "${var.project}-${var.environment}-performance-sagemaker-exec-role"
  description          = "GuardBench performance classifier - Qwen3-4B SageMaker endpoint execution role"
  permissions_boundary = data.terraform_remote_state.performance_base.outputs.experiment_permissions_boundary_arn

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "sagemaker.amazonaws.com" }
    }]
  })

  tags = {
    Name    = "${var.project}-${var.environment}-performance-sagemaker-exec-role"
    Purpose = "performance-testing"
  }
}

resource "aws_iam_role_policy" "performance_sagemaker_execution" {
  name = "${var.project}-${var.environment}-performance-sagemaker-exec-policy"
  role = aws_iam_role.performance_sagemaker_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadQwenJumpStartArtifacts"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = "arn:aws:s3:::${local.performance_sagemaker_jumpstart_bucket}"
      },
      {
        Sid      = "ReadQwenJumpStartArtifactObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "arn:aws:s3:::${local.performance_sagemaker_jumpstart_bucket}/*"
      },
      {
        Sid    = "WriteSageMakerEndpointLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/sagemaker/*"
      },
      {
        Sid      = "PullServingContainer"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_sagemaker_model" "performance_classifier" {
  name               = local.performance_sagemaker_model_name
  execution_role_arn = aws_iam_role.performance_sagemaker_execution.arn

  # SageMaker validates the role while creating the model. Keep the
  # least-privilege policy in place before that validation begins.
  depends_on = [aws_iam_role_policy.performance_sagemaker_execution]

  primary_container {
    image = local.performance_sagemaker_container.image

    model_data_source {
      s3_data_source {
        s3_data_type     = "S3Prefix"
        s3_uri           = local.performance_sagemaker_container.model_data_uri
        compression_type = "None"
      }
    }

    environment = local.performance_sagemaker_container.environment
  }

  # A changed definition gets a new name, so the replacement is created before the old model is destroyed.
  lifecycle {
    create_before_destroy = true

    precondition {
      condition     = length(local.performance_sagemaker_model_name) <= 63
      error_message = "SageMaker model name must be at most 63 characters; shorten project or environment."
    }
  }

  tags = {
    Name    = local.performance_sagemaker_model_name
    Purpose = "performance-testing"
  }
}

resource "aws_sagemaker_endpoint_configuration" "performance_classifier" {
  name_prefix = "${var.project}-${var.environment}-perf-qwen3-4b-"

  production_variants {
    variant_name           = local.performance_sagemaker_variant_name
    model_name             = aws_sagemaker_model.performance_classifier.name
    initial_instance_count = var.performance_sagemaker_instance_count
    initial_variant_weight = 1.0
    instance_type          = var.performance_sagemaker_instance_type
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name    = "${trimsuffix(local.performance_sagemaker_model_name_prefix, "-")}-config"
    Purpose = "performance-testing"
  }
}

resource "aws_sagemaker_endpoint" "performance_classifier" {
  name                 = local.performance_sagemaker_endpoint_name
  endpoint_config_name = aws_sagemaker_endpoint_configuration.performance_classifier.name

  tags = {
    Name    = local.performance_sagemaker_endpoint_name
    Purpose = "performance-testing"
  }
}
