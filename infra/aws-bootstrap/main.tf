# main.tf (aws-bootstrap)
#
# Plain English: the one-off setup that lets wg-admin use AWS without ever
# holding the admin keys. Run once from Steven's machine (scripts/aws-bootstrap.mjs).
#   - GitHub Actions gets a role it can assume with its own signed identity
#     (OIDC). No AWS keys are stored in GitHub at all.
#   - The Worker gets a small IAM user that can only look, start/stop the
#     wg-admin server, edit its firewall rules and read cost.
#   - A budget alarm emails if the whole account passes ~15 GBP in a month,
#     whatever wg-admin itself believes.

terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "wg-admin", "wg-admin" = "bootstrap" }
  }
}

data "aws_caller_identity" "me" {}

locals {
  account = data.aws_caller_identity.me.account_id
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

resource "aws_iam_role" "deploy" {
  name                 = "wg-admin-deploy"
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "${var.github_sub_prefix}:ref:refs/heads/main"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "deploy" {
  name = "wg-admin-deploy"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "Ec2InTheRegion"
        Effect    = "Allow"
        Action    = ["ec2:*"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = var.region } }
      },
      {
        Sid      = "ReadTags"
        Effect   = "Allow"
        Action   = ["tag:GetResources", "sts:GetCallerIdentity"]
        Resource = "*"
      },
      # The deny below keys on the wg-admin=vpn tag, so the role must not be able
      # to put that tag on something else (or strip it) and then act on it.
      # Tagging at creation time (RunInstances, CreateVpc...) is still allowed.
      {
        Sid      = "NoRetaggingWgAdmin"
        Effect   = "Deny"
        Action   = ["ec2:CreateTags"]
        Resource = "*"
        Condition = {
          "ForAnyValue:StringEquals" = { "aws:TagKeys" = ["wg-admin"] }
          "Null"                     = { "ec2:CreateAction" = "true" }
        }
      },
      {
        Sid       = "NoUntaggingWgAdmin"
        Effect    = "Deny"
        Action    = ["ec2:DeleteTags"]
        Resource  = "*"
        Condition = { "ForAnyValue:StringEquals" = { "aws:TagKeys" = ["wg-admin"] } }
      },
      {
        Sid    = "OnlyWgAdminThings"
        Effect = "Deny"
        Action = [
          "ec2:TerminateInstances", "ec2:StopInstances", "ec2:StartInstances", "ec2:ModifyInstanceAttribute",
          "ec2:DeleteVolume", "ec2:DeleteVpc", "ec2:DeleteSecurityGroup", "ec2:ReleaseAddress",
          "ec2:DeleteSubnet", "ec2:DeleteRouteTable", "ec2:DeleteNetworkInterface", "ec2:DisassociateAddress", "ec2:DeleteInternetGateway", "ec2:DetachInternetGateway", "ec2:DeleteKeyPair",
          "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress",
        ]
        Resource  = "*"
        Condition = { StringNotEquals = { "aws:ResourceTag/wg-admin" = "vpn" } }
      },
    ]
  })
}

resource "aws_iam_user" "worker" {
  name = "wg-admin-worker"
}

resource "aws_iam_access_key" "worker" {
  user = aws_iam_user.worker.name
}

resource "aws_iam_user_policy" "worker" {
  name = "wg-admin-worker"
  user = aws_iam_user.worker.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "Look"
        Effect    = "Allow"
        Action    = ["ec2:DescribeInstances", "ec2:DescribeVpcs", "ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules", "ec2:DescribeAddresses", "ec2:DescribeVolumes"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = var.region } }
      },
      {
        Sid       = "PowerOurServer"
        Effect    = "Allow"
        Action    = ["ec2:StartInstances", "ec2:StopInstances"]
        Resource  = "arn:aws:ec2:${var.region}:${local.account}:instance/*"
        Condition = { StringEquals = { "aws:ResourceTag/wg-admin" = "vpn" } }
      },
      {
        Sid       = "EdgeRules"
        Effect    = "Allow"
        Action    = ["ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress"]
        Resource  = "arn:aws:ec2:${var.region}:${local.account}:security-group/*"
        Condition = { StringEquals = { "aws:ResourceTag/wg-admin" = "vpn" } }
      },
      {
        Sid      = "InventoryAndCost"
        Effect   = "Allow"
        Action   = ["tag:GetResources", "ce:GetCostAndUsage"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_budgets_budget" "guard" {
  name         = "wg-admin-guard"
  budget_type  = "COST"
  limit_amount = var.budget_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
