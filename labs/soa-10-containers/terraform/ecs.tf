# ecs.tf
#
# Plain English: lab 10's containers. An ECR repository, lab-<id>-web, that
# scans each pushed image and keeps the five newest (it starts empty: pushing
# an image is a Thing to try; ruling P16). An ECS cluster with Container
# Insights. A task, lab-<id>-web: nginx from Amazon ECR Public on Fargate
# ARM64 (Graviton), 0.25 vCPU and 0.5 GB, logging to /cloudlabs/<id>/web (one
# day; ruling A56), started with the role lab-<id>-exec (pull and log only,
# AmazonECSTaskExecutionRolePolicy, under the lab boundary; it is also the
# task role, so the scope check sees no unset role). And the service,
# two tasks in the private subnets behind the load balancer. A 20-second wait
# lets the repository's tag reach IAM before its lifecycle policy (ruling P15).

locals {
  log_group = "/cloudlabs/${var.lab_id}/web"
}

resource "aws_ecr_repository" "web" {
  name                 = "lab-${var.lab_id}-web"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = true
  }
  tags = { Name = "ecr-web" }
}

resource "time_sleep" "ecr_tags" {
  create_duration = "20s"
  depends_on      = [aws_ecr_repository.web]
}

resource "aws_ecr_lifecycle_policy" "web" {
  repository = aws_ecr_repository.web.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the five newest images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
  depends_on = [time_sleep.ecr_tags]
}

resource "aws_ecs_cluster" "lab" {
  name = "lab-${var.lab_id}"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = { Name = "ecs-lab" }
}

resource "aws_cloudwatch_log_group" "web" {
  name              = local.log_group
  retention_in_days = 1
}

resource "aws_iam_role" "exec" {
  name                 = "lab-${var.lab_id}-exec"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "exec" {
  role       = aws_iam_role.exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_ecs_task_definition" "web" {
  family                   = "lab-${var.lab_id}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.exec.arn
  task_role_arn            = aws_iam_role.exec.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name         = "web"
    image        = "public.ecr.aws/nginx/nginx:stable-alpine"
    essential    = true
    portMappings = [{ containerPort = 80, protocol = "tcp" }]
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = local.log_group, "awslogs-region" = var.region, "awslogs-stream-prefix" = "web" }
    }
  }])
  tags       = { Name = "td-web" }
  depends_on = [aws_cloudwatch_log_group.web]
}

resource "aws_security_group" "tasks" {
  name        = "lab-tasks"
  description = "The service tasks: HTTP from the load balancer, out through the NAT gateway"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-tasks" }
}

resource "aws_vpc_security_group_ingress_rule" "tasks_http_alb" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_vpc_security_group_egress_rule" "tasks_all" {
  security_group_id = aws_security_group.tasks.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_ecs_service" "web" {
  name                              = "lab-${var.lab_id}-web"
  cluster                           = aws_ecs_cluster.lab.id
  task_definition                   = aws_ecs_task_definition.web.arn
  desired_count                     = 2
  launch_type                       = "FARGATE"
  propagate_tags                    = "SERVICE"
  enable_ecs_managed_tags           = true
  health_check_grace_period_seconds = 30

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 80
  }

  tags       = { Name = "svc-web" }
  depends_on = [aws_lb_listener.http, aws_route.private_nat, aws_iam_role_policy_attachment.exec]
}
