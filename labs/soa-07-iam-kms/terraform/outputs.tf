# outputs.tf
#
# Plain English: what the dashboard shows once lab 07 is up (AWS labs spec
# §4, §10). users is ann's console sign-in: her user name, and the password
# Terraform generated with the address to sign in at. It is sensitive, masked
# in the run's log, and shown only behind Show (ruling P5).

output "private_ips" {
  value = {}
}

output "users" {
  sensitive = true
  value = {
    (aws_iam_user.ann.name) = "password ${aws_iam_user_login_profile.ann.password} at https://${data.aws_caller_identity.current.account_id}.signin.aws.amazon.com/console"
  }
}

output "connect" {
  value = [
    "Sign in as ${aws_iam_user.ann.name} (the password is behind Show), in a private window",
    "aws secretsmanager get-secret-value --secret-id ${aws_secretsmanager_secret.app.name} --query SecretString --output text",
    "aws secretsmanager rotate-secret --secret-id ${aws_secretsmanager_secret.app.name}",
    "aws accessanalyzer list-findings-v2 --analyzer-arn ${aws_accessanalyzer_analyzer.account.arn}",
  ]
}
