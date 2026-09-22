resource "aws_appautoscaling_target" "dev_worker" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.worker.name}"
  min_capacity       = var.dev_worker_min_capacity
  max_capacity       = var.dev_worker_max_capacity

  depends_on = [aws_ecs_service.worker]
}

resource "aws_appautoscaling_policy" "dev_worker_scale_out" {
  name               = "${var.project}-${var.environment}-worker-scale-out"
  policy_type        = "StepScaling"
  resource_id        = aws_appautoscaling_target.dev_worker.resource_id
  scalable_dimension = aws_appautoscaling_target.dev_worker.scalable_dimension
  service_namespace  = aws_appautoscaling_target.dev_worker.service_namespace

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 60
    metric_aggregation_type = "Maximum"

    step_adjustment {
      metric_interval_lower_bound = 0
      scaling_adjustment          = 1
    }
  }
}

resource "aws_appautoscaling_policy" "dev_worker_scale_in" {
  name               = "${var.project}-${var.environment}-worker-scale-in"
  policy_type        = "StepScaling"
  resource_id        = aws_appautoscaling_target.dev_worker.resource_id
  scalable_dimension = aws_appautoscaling_target.dev_worker.scalable_dimension
  service_namespace  = aws_appautoscaling_target.dev_worker.service_namespace

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 600
    metric_aggregation_type = "Maximum"

    step_adjustment {
      metric_interval_upper_bound = 0
      scaling_adjustment          = -1
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "dev_worker_approximate_number_of_messages_visible_scale_out" {
  alarm_name          = "${var.project}-${var.environment}-worker-workitems-approximate-number-of-messages-visible-scale-out"
  alarm_description   = "Scale the development Worker by one task when the work-items backlog reaches 64 visible messages."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 64
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_appautoscaling_policy.dev_worker_scale_out.arn]

  dimensions = {
    QueueName = aws_sqs_queue.source["gb-workitems"].name
  }
}

resource "aws_cloudwatch_metric_alarm" "dev_worker_approximate_age_of_oldest_message_scale_out" {
  alarm_name          = "${var.project}-${var.environment}-worker-workitems-approximate-age-of-oldest-message-scale-out"
  alarm_description   = "Scale the development Worker by one task when the oldest work-items message is at least 20 seconds old."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 20
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_appautoscaling_policy.dev_worker_scale_out.arn]

  dimensions = {
    QueueName = aws_sqs_queue.source["gb-workitems"].name
  }
}

resource "aws_cloudwatch_metric_alarm" "dev_worker_approximate_number_of_messages_visible_scale_in" {
  alarm_name          = "${var.project}-${var.environment}-worker-workitems-approximate-number-of-messages-visible-scale-in"
  alarm_description   = "Scale the development Worker in only after ten minutes at eight or fewer visible work-items messages."
  comparison_operator = "LessThanOrEqualToThreshold"
  evaluation_periods  = 10
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 8
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.source["gb-workitems"].name
  }
}

resource "aws_cloudwatch_metric_alarm" "dev_worker_approximate_age_of_oldest_message_scale_in" {
  alarm_name          = "${var.project}-${var.environment}-worker-workitems-approximate-age-of-oldest-message-scale-in"
  alarm_description   = "Scale the development Worker in only after ten minutes with no aged work-items message."
  comparison_operator = "LessThanOrEqualToThreshold"
  evaluation_periods  = 10
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  # SQS may omit the age datapoint for an empty queue. Missing data is kept
  # non-breaching so an absent datapoint cannot cause an unsafe scale-in.
  treat_missing_data = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.source["gb-workitems"].name
  }
}

resource "aws_cloudwatch_metric_alarm" "dev_worker_scale_in" {
  alarm_name          = "${var.project}-${var.environment}-worker-scale-in-ready"
  alarm_description   = "Scale the development Worker in only when both official SQS metrics are low for ten minutes."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 10
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_appautoscaling_policy.dev_worker_scale_in.arn]

  metric_query {
    id          = "visible"
    return_data = false

    metric {
      metric_name = "ApproximateNumberOfMessagesVisible"
      namespace   = "AWS/SQS"
      period      = 60
      stat        = "Maximum"

      dimensions = {
        QueueName = aws_sqs_queue.source["gb-workitems"].name
      }
    }
  }

  metric_query {
    id          = "oldestmessage"
    return_data = false

    metric {
      metric_name = "ApproximateAgeOfOldestMessage"
      namespace   = "AWS/SQS"
      period      = 60
      stat        = "Maximum"

      dimensions = {
        QueueName = aws_sqs_queue.source["gb-workitems"].name
      }
    }
  }

  metric_query {
    id          = "scalein"
    expression  = "(visible <= 8) AND (oldestmessage <= 0)"
    label       = "Dev Worker scale-in condition"
    return_data = true
  }
}
