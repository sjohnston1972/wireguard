# main.tf
#
# Plain English: what every AWS lab has (AWS labs spec §4). Its own AWS
# Resource Groups group, lab-<id>, a free tag query that is the dashboard's
# "Open in AWS console" link, and the IAM permission boundary every lab role
# must carry. A lab with regions.secondary adds a second group there with
# provider = aws.secondary (groups are regional).

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  # Every lab role and user carries this boundary (spec §7.2); the scope check refuses one without it.
  boundary_arn = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:policy/wg-admin-lab-boundary"
}

resource "aws_resourcegroups_group" "lab" {
  name = "lab-${var.lab_id}"

  resource_query {
    type = "TAG_FILTERS_1_0"
    query = jsonencode({
      ResourceTypeFilters = ["AWS::AllSupported"]
      TagFilters          = [{ Key = "cloudlabs-lab", Values = [var.lab_id] }]
    })
  }
}
