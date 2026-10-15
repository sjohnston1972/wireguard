# outputs.tf (aws-bootstrap). The script pipes these straight into gh and wrangler; they are never printed.

output "account_id" {
  value = local.account
}

output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}

output "labs_role_arn" {
  value = aws_iam_role.labs.arn
}

# The default VPCs (London's, then Ireland's) that DenyDefaultVpc names: the --labs simulator asks about one.
output "default_vpc_arns" {
  value = local.default_vpc_arns
}

output "worker_access_key_id" {
  value     = aws_iam_access_key.worker.id
  sensitive = true
}

output "worker_secret_access_key" {
  value     = aws_iam_access_key.worker.secret
  sensitive = true
}
