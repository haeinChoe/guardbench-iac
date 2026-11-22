data "terraform_remote_state" "shared" {
  backend = "s3"

  config = {
    bucket = var.remote_state_bucket
    key    = var.shared_state_key
    region = var.remote_state_region
  }
}

data "terraform_remote_state" "performance_base" {
  backend = "s3"

  config = {
    bucket = var.remote_state_bucket
    key    = var.performance_base_state_key
    region = var.remote_state_region
  }
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}
