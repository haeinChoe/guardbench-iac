# Internal ALB providing SG-scoped private access to Performance Backend API
# and Demo AI target services. Experiment roots attach standalone ingress and
# egress rules to this security group.
resource "aws_security_group" "performance_api_alb" {
  name        = "${var.project}-${var.environment}-performance-api-alb-sg"
  description = "Internal ALB exposing the Performance Backend API inside the VPC"
  vpc_id      = data.terraform_remote_state.shared.outputs.vpc_id

  tags = {
    Name    = "${var.project}-${var.environment}-performance-api-alb-sg"
    Purpose = "performance-testing"
  }
}

resource "aws_lb" "performance_api" {
  name               = "${var.project}-${var.environment}-performance-api"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.performance_api_alb.id]
  subnets            = data.terraform_remote_state.shared.outputs.private_subnet_ids

  access_logs {
    bucket  = data.terraform_remote_state.shared.outputs.alb_access_logs_bucket_name
    enabled = true
    prefix  = "performance"
  }

  tags = {
    Name    = "${var.project}-${var.environment}-performance-api"
    Purpose = "performance-testing"
  }
}

resource "aws_lb_target_group" "performance_api" {
  name        = "${var.project}-${var.environment}-performance-api"
  port        = var.api_container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = data.terraform_remote_state.shared.outputs.vpc_id

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200"
  }

  tags = {
    Name    = "${var.project}-${var.environment}-performance-api"
    Purpose = "performance-testing"
  }
}

resource "aws_lb_target_group" "performance_demo_ai" {
  name        = "${var.project}-${var.environment}-demo-ai"
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = data.terraform_remote_state.shared.outputs.vpc_id

  health_check {
    path                = "/health"
    port                = "traffic-port"
    protocol            = "HTTP"
    healthy_threshold   = 2
    unhealthy_threshold = 2
    timeout             = 5
    interval            = 30
    matcher             = "200"
  }

  tags = {
    Name    = "${var.project}-${var.environment}-demo-ai"
    Purpose = "performance-testing"
  }
}

resource "aws_lb_listener" "performance_api" {
  load_balancer_arn = aws_lb.performance_api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.performance_api.arn
  }
}

# Route /v1/chat/completions to the synthetic Demo AI target group while
# keeping the Performance Backend service as the default target.
resource "aws_lb_listener_rule" "performance_demo_ai" {
  listener_arn = aws_lb_listener.performance_api.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.performance_demo_ai.arn
  }

  condition {
    path_pattern {
      values = ["/v1/chat/completions"]
    }
  }
}
