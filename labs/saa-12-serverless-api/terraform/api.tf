# api.tf
#
# Plain English: lab 12's HTTP API, lab-<id> (public by nature, spec §7.4).
# One Lambda integration and three routes: GET /health for anyone, GET and
# POST /items only with a valid token from the lab's own user pool for its
# own app client (a JWT authoriser; ruling P12). The $default stage deploys
# every change and holds the API to 10 requests at once and 5 a second, so a
# leaked address cannot run up a bill.

resource "aws_apigatewayv2_api" "lab" {
  name          = "lab-${var.lab_id}"
  protocol_type = "HTTP"
  tags          = { Name = "api-lab" }
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.lab.id
  authorizer_type  = "JWT"
  name             = "cognito"
  identity_sources = ["$request.header.Authorization"]
  jwt_configuration {
    audience = [aws_cognito_user_pool_client.cli.id]
    issuer   = "https://${aws_cognito_user_pool.users.endpoint}"
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.lab.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.lab.id
  route_key = "GET /health"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_route" "items_get" {
  api_id             = aws_apigatewayv2_api.lab.id
  route_key          = "GET /items"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "items_post" {
  api_id             = aws_apigatewayv2_api.lab.id
  route_key          = "POST /items"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.lab.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 10
    throttling_rate_limit  = 5
  }
  tags = { Name = "stage-default" }
}
