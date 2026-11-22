# ============================================
# Performance API Security Group (ECS Fargate)
# ============================================
resource "aws_security_group" "performance_api" {
  name        = "${var.project}-${var.environment}-performance-api-sg"
  description = "GuardBench Performance API Fargate service"
  vpc_id      = data.terraform_remote_state.shared.outputs.vpc_id

  tags = {
    Name    = "${var.project}-${var.environment}-performance-api-sg"
    Purpose = "performance-testing"
  }
}

resource "aws_security_group_rule" "performance_api_ingress_from_alb" {
  type                     = "ingress"
  from_port                = var.api_container_port
  to_port                  = var.api_container_port
  protocol                 = "tcp"
  source_security_group_id = data.terraform_remote_state.performance_base.outputs.performance_api_alb_security_group_id
  description              = "From internal performance API ALB"
  security_group_id        = aws_security_group.performance_api.id
}

resource "aws_security_group_rule" "performance_api_egress_to_vpc_endpoints" {
  type                     = "egress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  source_security_group_id = data.terraform_remote_state.shared.outputs.vpc_endpoints_security_group_id
  description              = "AWS services through VPC endpoints"
  security_group_id        = aws_security_group.performance_api.id
}

resource "aws_security_group_rule" "performance_api_egress_to_external_https" {
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "External HTTPS endpoints via NAT Gateway"
  security_group_id = aws_security_group.performance_api.id
}

resource "aws_security_group_rule" "performance_api_egress_to_s3_gateway" {
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  prefix_list_ids   = [data.terraform_remote_state.shared.outputs.vpc_endpoint_s3_prefix_list_id]
  description       = "ECR image layers through S3 Gateway endpoint"
  security_group_id = aws_security_group.performance_api.id
}

resource "aws_security_group_rule" "performance_api_egress_to_performance_rds" {
  type                     = "egress"
  from_port                = data.terraform_remote_state.performance_base.outputs.db_port
  to_port                  = data.terraform_remote_state.performance_base.outputs.db_port
  protocol                 = "tcp"
  source_security_group_id = data.terraform_remote_state.performance_base.outputs.performance_rds_security_group_id
  description              = "To performance-test RDS PostgreSQL"
  security_group_id        = aws_security_group.performance_api.id
}

resource "aws_security_group_rule" "performance_api_egress_to_performance_alb" {
  type                     = "egress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  source_security_group_id = data.terraform_remote_state.performance_base.outputs.performance_api_alb_security_group_id
  description              = "Performance Backend target calls through the internal ALB"
  security_group_id        = aws_security_group.performance_api.id
}

# ============================================
# Performance Worker Security Group (ECS Fargate)
# ============================================
resource "aws_security_group" "performance_worker" {
  name        = "${var.project}-${var.environment}-performance-worker-sg"
  description = "GuardBench Performance Worker Fargate service (SQS polling)"
  vpc_id      = data.terraform_remote_state.shared.outputs.vpc_id

  tags = {
    Name    = "${var.project}-${var.environment}-performance-worker-sg"
    Purpose = "performance-testing"
  }
}

resource "aws_security_group_rule" "performance_worker_egress_https" {
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "AWS services (Bedrock, SQS, CloudWatch, SSM)"
  security_group_id = aws_security_group.performance_worker.id
}

resource "aws_security_group_rule" "performance_worker_egress_to_performance_rds" {
  type                     = "egress"
  from_port                = data.terraform_remote_state.performance_base.outputs.db_port
  to_port                  = data.terraform_remote_state.performance_base.outputs.db_port
  protocol                 = "tcp"
  source_security_group_id = data.terraform_remote_state.performance_base.outputs.performance_rds_security_group_id
  description              = "To performance-test RDS PostgreSQL"
  security_group_id        = aws_security_group.performance_worker.id
}

resource "aws_security_group_rule" "performance_worker_egress_to_performance_alb" {
  type                     = "egress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  source_security_group_id = data.terraform_remote_state.performance_base.outputs.performance_api_alb_security_group_id
  description              = "Performance Worker target calls through the internal ALB"
  security_group_id        = aws_security_group.performance_worker.id
}

# ============================================
# Demo AI Service Security Group (ECS Fargate)
# ============================================
resource "aws_security_group" "demo_ai" {
  name        = "${var.project}-${var.environment}-demo-ai-sg"
  description = "GuardBench Demo AI performance-test Fargate service"
  vpc_id      = data.terraform_remote_state.shared.outputs.vpc_id

  tags = {
    Name    = "${var.project}-${var.environment}-demo-ai-sg"
    Purpose = "performance-testing"
  }
}

resource "aws_security_group_rule" "demo_ai_ingress_from_performance_alb" {
  type                     = "ingress"
  from_port                = 8080
  to_port                  = 8080
  protocol                 = "tcp"
  source_security_group_id = data.terraform_remote_state.performance_base.outputs.performance_api_alb_security_group_id
  description              = "Demo AI requests from the private performance ALB"
  security_group_id        = aws_security_group.demo_ai.id
}

resource "aws_security_group_rule" "demo_ai_egress_to_vpc_endpoints" {
  type                     = "egress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  source_security_group_id = data.terraform_remote_state.shared.outputs.vpc_endpoints_security_group_id
  description              = "Bedrock, ECR, and CloudWatch through VPC endpoints"
  security_group_id        = aws_security_group.demo_ai.id
}

resource "aws_security_group_rule" "demo_ai_egress_to_s3_gateway" {
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  prefix_list_ids   = [data.terraform_remote_state.shared.outputs.vpc_endpoint_s3_prefix_list_id]
  description       = "ECR image layers through S3 Gateway endpoint"
  security_group_id = aws_security_group.demo_ai.id
}

# ============================================
# Cross-Root Security Group Rules
# ============================================
resource "aws_security_group_rule" "vpc_endpoints_ingress_from_performance_api" {
  type                     = "ingress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.performance_api.id
  description              = "HTTPS from Performance API ECS service"
  security_group_id        = data.terraform_remote_state.shared.outputs.vpc_endpoints_security_group_id
}

resource "aws_security_group_rule" "vpc_endpoints_ingress_from_performance_worker" {
  type                     = "ingress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.performance_worker.id
  description              = "HTTPS from Performance Worker ECS service"
  security_group_id        = data.terraform_remote_state.shared.outputs.vpc_endpoints_security_group_id
}

resource "aws_security_group_rule" "vpc_endpoints_ingress_from_demo_ai" {
  type                     = "ingress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.demo_ai.id
  description              = "HTTPS from Demo AI ECS service"
  security_group_id        = data.terraform_remote_state.shared.outputs.vpc_endpoints_security_group_id
}

resource "aws_security_group_rule" "performance_rds_ingress_from_performance_api" {
  type                     = "ingress"
  from_port                = data.terraform_remote_state.performance_base.outputs.db_port
  to_port                  = data.terraform_remote_state.performance_base.outputs.db_port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.performance_api.id
  description              = "From Performance API ECS service"
  security_group_id        = data.terraform_remote_state.performance_base.outputs.performance_rds_security_group_id
}

resource "aws_security_group_rule" "performance_rds_ingress_from_performance_worker" {
  type                     = "ingress"
  from_port                = data.terraform_remote_state.performance_base.outputs.db_port
  to_port                  = data.terraform_remote_state.performance_base.outputs.db_port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.performance_worker.id
  description              = "From Performance Worker ECS service"
  security_group_id        = data.terraform_remote_state.performance_base.outputs.performance_rds_security_group_id
}

resource "aws_security_group_rule" "performance_api_alb_ingress_from_performance_api" {
  type                     = "ingress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.performance_api.id
  description              = "Performance Backend target calls through the internal ALB"
  security_group_id        = data.terraform_remote_state.performance_base.outputs.performance_api_alb_security_group_id
}

resource "aws_security_group_rule" "performance_api_alb_ingress_from_performance_worker" {
  type                     = "ingress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.performance_worker.id
  description              = "Performance Worker target calls through the internal ALB"
  security_group_id        = data.terraform_remote_state.performance_base.outputs.performance_api_alb_security_group_id
}

resource "aws_security_group_rule" "performance_api_alb_egress_to_performance_api" {
  type                     = "egress"
  from_port                = var.api_container_port
  to_port                  = var.api_container_port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.performance_api.id
  description              = "Forward performance workload requests to ECS"
  security_group_id        = data.terraform_remote_state.performance_base.outputs.performance_api_alb_security_group_id
}

resource "aws_security_group_rule" "performance_api_alb_egress_to_demo_ai" {
  type                     = "egress"
  from_port                = 8080
  to_port                  = 8080
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.demo_ai.id
  description              = "Forward the Demo AI target route to ECS"
  security_group_id        = data.terraform_remote_state.performance_base.outputs.performance_api_alb_security_group_id
}
