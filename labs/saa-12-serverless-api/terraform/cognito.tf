# cognito.tf
#
# Plain English: lab 12's sign-in. A Cognito user pool on the free Lite tier
# (ruling P12) where only an administrator makes users, deletable at
# tear-down, with no hosted domain (CloudShell signs in directly); an app
# client that signs in with a user name and password (USER_PASSWORD_AUTH,
# no client secret, as a command-line client); and one user, labuser, whose
# password is the session's (behind Show), set permanent and no email sent.
# A 20-second wait lets the pool's tags reach IAM before the client and the
# user, which IAM judges by them (ruling P11).

resource "aws_cognito_user_pool" "users" {
  name                = "lab-${var.lab_id}-users"
  user_pool_tier      = "LITE"
  deletion_protection = "INACTIVE"
  mfa_configuration   = "OFF"

  admin_create_user_config {
    allow_admin_create_user_only = true
  }
  account_recovery_setting {
    recovery_mechanism {
      name     = "admin_only"
      priority = 1
    }
  }
  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = false
  }
  tags = { Name = "pool-users" }
}

resource "time_sleep" "pool_tags" {
  create_duration = "20s"
  depends_on      = [aws_cognito_user_pool.users]
}

resource "aws_cognito_user_pool_client" "cli" {
  name                          = "lab-${var.lab_id}-cli"
  user_pool_id                  = aws_cognito_user_pool.users.id
  generate_secret               = false
  explicit_auth_flows           = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  depends_on                    = [time_sleep.pool_tags]
}

resource "aws_cognito_user" "labuser" {
  user_pool_id   = aws_cognito_user_pool.users.id
  username       = "labuser"
  password       = var.admin_password
  message_action = "SUPPRESS"
  depends_on     = [time_sleep.pool_tags]
}
