# outputs.tf
#
# Plain English: what the dashboard shows once lab 12 is up: the API's
# address, and CloudShell lines to sign in as labuser (the session password
# is behind Show) and call the API with the token. No instances, no peering.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "curl -s ${aws_apigatewayv2_api.lab.api_endpoint}/health",
    "TOKEN=$(aws cognito-idp initiate-auth --region ${var.region} --auth-flow USER_PASSWORD_AUTH --client-id ${aws_cognito_user_pool_client.cli.id} --auth-parameters USERNAME=labuser,PASSWORD='<the session password>' --query AuthenticationResult.IdToken --output text)",
    "curl -s -X POST -H \"Authorization: Bearer $TOKEN\" -d '{\"text\":\"hello\"}' ${aws_apigatewayv2_api.lab.api_endpoint}/items",
    "curl -s -H \"Authorization: Bearer $TOKEN\" ${aws_apigatewayv2_api.lab.api_endpoint}/items",
  ]
}
