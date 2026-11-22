data "terraform_remote_state" "shared" {
  backend = "s3"

  config = {
    bucket = var.remote_state_bucket
    key    = var.shared_state_key
    region = var.remote_state_region
  }
}

data "aws_caller_identity" "current" {}
