# ============================================
# VPC Outputs
# ============================================
output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "VPC CIDR block"
  value       = aws_vpc.main.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet IDs"
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet IDs"
  value       = aws_subnet.private[*].id
}

output "private_route_table_id" {
  description = "Private route table ID"
  value       = aws_route_table.private.id
}

output "nat_gateway_id" {
  description = "NAT Gateway used by private ECS subnets for external HTTPS egress"
  value       = aws_nat_gateway.main.id
}

output "nat_gateway_public_ip" {
  description = "Public EIP used by the private-subnet NAT Gateway"
  value       = aws_eip.nat.public_ip
}

# ============================================
# VPC Endpoint Outputs
# ============================================
output "vpc_endpoints_security_group_id" {
  description = "VPC Endpoints security group ID"
  value       = aws_security_group.vpc_endpoints.id
}

output "vpc_endpoint_s3_prefix_list_id" {
  description = "S3 Gateway VPC endpoint prefix list ID"
  value       = aws_vpc_endpoint.s3.prefix_list_id
}

output "vpc_endpoint_sqs_id" {
  description = "SQS VPC endpoint ID"
  value       = aws_vpc_endpoint.sqs.id
}

output "vpc_endpoint_bedrock_runtime_id" {
  description = "Bedrock Runtime VPC endpoint ID"
  value       = aws_vpc_endpoint.bedrock_runtime.id
}

output "vpc_endpoint_bedrock_id" {
  description = "Bedrock VPC endpoint ID"
  value       = aws_vpc_endpoint.bedrock.id
}

output "vpc_endpoint_sagemaker_runtime_id" {
  description = "SageMaker Runtime VPC interface endpoint ID used by private ECS tasks"
  value       = aws_vpc_endpoint.sagemaker_runtime.id
}

output "vpc_endpoint_ssm_id" {
  description = "SSM VPC endpoint ID"
  value       = aws_vpc_endpoint.ssm.id
}

output "vpc_endpoint_logs_id" {
  description = "CloudWatch Logs VPC endpoint ID"
  value       = aws_vpc_endpoint.logs.id
}

output "vpc_endpoint_ecr_api_id" {
  description = "ECR API VPC endpoint ID"
  value       = aws_vpc_endpoint.ecr_api.id
}

output "vpc_endpoint_s3_id" {
  description = "S3 Gateway VPC endpoint ID"
  value       = aws_vpc_endpoint.s3.id
}

# ============================================
# ECR / ECS Cluster Outputs
# ============================================
output "ecr_repository_url" {
  description = "Backend ECR repository URL"
  value       = aws_ecr_repository.app.repository_url
}

output "ecr_repository_arn" {
  description = "Backend ECR repository ARN"
  value       = aws_ecr_repository.app.arn
}

output "ecr_repository_name" {
  description = "Backend ECR repository name"
  value       = aws_ecr_repository.app.name
}

output "demo_ai_ecr_repository_url" {
  description = "Private ECR repository URL for immutable Demo AI images"
  value       = aws_ecr_repository.demo_ai.repository_url
}

output "demo_ai_ecr_repository_arn" {
  description = "Private ECR repository ARN for immutable Demo AI images"
  value       = aws_ecr_repository.demo_ai.arn
}

output "ecs_cluster_id" {
  description = "Shared ECS cluster ID"
  value       = aws_ecs_cluster.main.id
}

output "ecs_cluster_name" {
  description = "Shared ECS cluster name"
  value       = aws_ecs_cluster.main.name
}

output "ecs_cluster_arn" {
  description = "Shared ECS cluster ARN"
  value       = aws_ecs_cluster.main.arn
}

# ============================================
# Shared ALB Access Logs / OIDC Outputs
# ============================================
output "alb_access_logs_bucket_name" {
  description = "Private S3 bucket for Public and Performance ALB access logs"
  value       = aws_s3_bucket.alb_access_logs.id
}

output "alb_access_logs_bucket_arn" {
  description = "Private S3 bucket ARN for Public and Performance ALB access logs"
  value       = aws_s3_bucket.alb_access_logs.arn
}

output "github_oidc_provider_arn" {
  description = "GitHub Actions OIDC provider ARN"
  value       = local.github_oidc_provider_arn
}

output "frontend_github_actions_role_arn" {
  description = "Role ARN used by guardbench-frontend GitHub Actions via OIDC"
  value       = aws_iam_role.frontend_github_actions_deploy.arn
}

output "frontend_github_actions_role_name" {
  description = "Role name used by guardbench-frontend GitHub Actions via OIDC"
  value       = aws_iam_role.frontend_github_actions_deploy.name
}

output "backend_github_actions_role_arn" {
  description = "Role ARN used by guardbench-backend GitHub Actions via OIDC"
  value       = aws_iam_role.backend_github_actions_deploy.arn
}

output "backend_github_actions_role_name" {
  description = "Role name used by guardbench-backend GitHub Actions via OIDC"
  value       = aws_iam_role.backend_github_actions_deploy.name
}
