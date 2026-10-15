# labs.tf (aws-bootstrap)
#
# Plain English: the AWS labs' own login (AWS labs spec §7). GitHub workflows
# on main assume wg-admin-labs with their signed identity, for 3-hour
# sessions. Its permissions are the managed policies rendered into
# lab-policies.json by scripts/aws-labs-abac.mjs --render (several, as AWS
# caps one at 6,144 characters; ruling A29): free hands inside resources
# tagged cloudlabs-lab in London and Ireland, IAM only under
# /cloudlabs-lab/lab-*, and never the VPN server, the default VPC, other
# regions, other roles, access keys or billing. Every role or user a lab
# makes must carry wg-admin-lab-boundary, so nothing a lab creates can do more.

provider "aws" {
  alias  = "ireland"
  region = "eu-west-1"
  default_tags {
    tags = { project = "wg-admin", "wg-admin" = "bootstrap" }
  }
}

data "aws_vpcs" "default_london" {
  filter {
    name   = "is-default"
    values = ["true"]
  }
}

data "aws_vpcs" "default_ireland" {
  provider = aws.ireland
  filter {
    name   = "is-default"
    values = ["true"]
  }
}

locals {
  lab_policies     = jsondecode(file("${path.module}/lab-policies.json"))
  default_vpc_arns = concat([for id in data.aws_vpcs.default_london.ids : "arn:aws:ec2:${var.region}:${local.account}:vpc/${id}"], [for id in data.aws_vpcs.default_ireland.ids : "arn:aws:ec2:eu-west-1:${local.account}:vpc/${id}"])
  # A Resource list may not be empty: with no default VPC, an ARN that matches nothing. A JSON array (ruling C11).
  vpc_arns_json = jsonencode(length(local.default_vpc_arns) > 0 ? local.default_vpc_arns : ["arn:aws:ec2:${var.region}:${local.account}:vpc/vpc-00000000000000000"])
  role_docs     = [for d in local.lab_policies.role : replace(replace(jsonencode(d), "__ACCOUNT__", local.account), "\"__DEFAULT_VPC_ARNS__\"", local.vpc_arns_json)]
  boundary_doc  = replace(replace(jsonencode(local.lab_policies.boundary), "__ACCOUNT__", local.account), "\"__DEFAULT_VPC_ARNS__\"", local.vpc_arns_json)
}

resource "aws_iam_policy" "lab_boundary" {
  name   = "wg-admin-lab-boundary"
  policy = local.boundary_doc
}

resource "aws_iam_policy" "labs" {
  count  = length(local.role_docs)
  name   = "wg-admin-labs-${count.index + 1}"
  policy = local.role_docs[count.index]
}

resource "aws_iam_role" "labs" {
  name                 = "wg-admin-labs"
  max_session_duration = 10800
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

resource "aws_iam_role_policy_attachment" "labs" {
  count      = length(aws_iam_policy.labs)
  role       = aws_iam_role.labs.name
  policy_arn = aws_iam_policy.labs[count.index].arn
}
