// scripts/test/fixtures/labs/plans/labs/saa-12-serverless-api.mjs
//
// Plain English: lab saa-12's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the
// template's resource group, then data.tf (the table), function.tf (the log
// group, the role, its policies and attachments, the function, the two-step
// wait, the API Gateway permission), cognito.tf (the pool, a wait, the app
// client and labuser) and api.tf (the HTTP API, its authoriser, integration,
// three routes and the $default stage). The lab has no network.tf (ruling
// A61), so no zones and no AMI are read; data.archive_file.api is read at plan
// with the zip's hash known. Every name, the table's settings, the role's and
// policy's documents (the table ARN is built from the caller identity and
// region), the pool's settings, the routes' route_key and the stage's
// throttling are known at plan. What is built from another resource's
// attribute is unknown, with its references: the integration's
// integration_uri, the permission's source_arn, the authoriser's issuer and
// audience, the routes' target and authorizer_id, every api_id and
// user_pool_id. Computed attributes (invoke_arn, execution_arn, arn, id,
// endpoint, api_endpoint) are marked by realisticPlan itself.

import { ACCOUNT, AWS_PROVIDER_CONFIG, BOUNDARY, ctxAws, ref, tagged, templateMainData, templateMainResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("saa-12-serverless-api", "12");
  const id = c.id;
  const region = c.variables.region;
  const policyDoc = (statements) => JSON.stringify({ Version: "2012-10-17", Statement: statements });
  const account = ref("data.aws_caller_identity.current", "account_id");
  const archive = "data.archive_file.api";
  const API = "aws_apigatewayv2_api.lab";
  const POOL = "aws_cognito_user_pool.users";
  const apiId = ref(API, "id");
  const integration = ref("aws_apigatewayv2_integration.api", "id");
  const route = (key, routeKey, secured) => ({
    address: `aws_apigatewayv2_route.${key}`,
    values: { route_key: routeKey, ...(secured ? { authorization_type: "JWT" } : {}) },
    unknown: ["api_id", "target", ...(secured ? ["authorizer_id"] : [])],
    refs: { api_id: apiId, target: integration, ...(secured ? { authorizer_id: ref("aws_apigatewayv2_authorizer.cognito", "id") } : {}) },
  });
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: [
      ...templateMainData(),
      {
        address: archive,
        values: { type: "zip", source_file: "/work/labs/saa-12-serverless-api/terraform/lambda/api.py", output_path: "/work/labs/saa-12-serverless-api/terraform/.terraform/api.zip", output_base64sha256: "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmE=" },
        args: ["type"],
        refs: { source_file: ["path.module"], output_path: ["path.module"] },
      },
    ],
    resources: [
      ...templateMainResources(c),
      // data.tf
      {
        address: "aws_dynamodb_table.items",
        values: tagged(c, { name: `lab-${id}-items`, billing_mode: "PAY_PER_REQUEST", hash_key: "id", deletion_protection_enabled: false, attribute: [{ name: "id", type: "S" }], tags: { Name: "table-items" } }),
        refs: { name: ["var.lab_id"] },
      },
      // function.tf
      {
        address: "aws_cloudwatch_log_group.api",
        values: tagged(c, { name: `/cloudlabs/${id}/api`, retention_in_days: 1 }),
        refs: { name: ["var.lab_id"] },
      },
      {
        address: "aws_iam_role.api",
        values: tagged(c, {
          name: `lab-${id}-api`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY,
          assume_role_policy: policyDoc([{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }]),
        }),
        refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"] },
      },
      {
        address: "aws_iam_role_policy_attachment.api_logs",
        values: { role: `lab-${id}-api`, policy_arn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" },
        refs: { role: ref("aws_iam_role.api", "name") },
      },
      {
        address: "aws_iam_policy.api",
        values: tagged(c, {
          name: `lab-${id}-api`, path: "/cloudlabs-lab/",
          policy: policyDoc([{ Sid: "LabTable", Effect: "Allow", Action: ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:PutItem"], Resource: `arn:aws:dynamodb:${region}:${ACCOUNT}:table/lab-${id}-items` }]),
        }),
        refs: { name: ["var.lab_id"], policy: ["local.table_arn"] },
      },
      {
        address: "aws_iam_role_policy_attachment.api",
        values: { role: `lab-${id}-api` },
        unknown: ["policy_arn"],
        refs: { role: ref("aws_iam_role.api", "name"), policy_arn: ref("aws_iam_policy.api", "arn") },
      },
      {
        address: "aws_lambda_function.api",
        values: tagged(c, {
          function_name: `lab-${id}-api`, runtime: "python3.13", architectures: ["arm64"], handler: "api.handler", memory_size: 128, timeout: 10,
          environment: [{ variables: { TABLE: `lab-${id}-items` } }],
          logging_config: [{ log_format: "Text", log_group: `/cloudlabs/${id}/api` }],
          tags: { Name: "fn-api" },
        }),
        unknown: ["role"],
        refs: {
          function_name: ["var.lab_id"],
          role: ref("aws_iam_role.api", "arn"),
          filename: ref(archive, "output_path"),
          source_code_hash: ref(archive, "output_base64sha256"),
          "environment.0.variables": ref("aws_dynamodb_table.items", "name"),
          "logging_config.0.log_group": ref("aws_cloudwatch_log_group.api", "name"),
        },
      },
      { address: "time_sleep.function_tags", values: { create_duration: "20s" }, refs: {} },
      {
        address: "aws_lambda_permission.api",
        values: { statement_id: "ApiGateway", action: "lambda:InvokeFunction", function_name: `lab-${id}-api`, principal: "apigateway.amazonaws.com" },
        unknown: ["source_arn"],
        refs: { function_name: ref("aws_lambda_function.api", "function_name"), source_arn: ref(API, "execution_arn") },
      },
      // cognito.tf
      {
        address: POOL,
        values: tagged(c, {
          name: `lab-${id}-users`, user_pool_tier: "LITE", deletion_protection: "INACTIVE", mfa_configuration: "OFF",
          admin_create_user_config: [{ allow_admin_create_user_only: true }],
          account_recovery_setting: [{ recovery_mechanism: [{ name: "admin_only", priority: 1 }] }],
          password_policy: [{ minimum_length: 12, require_lowercase: true, require_uppercase: true, require_numbers: true, require_symbols: false }],
          tags: { Name: "pool-users" },
        }),
        refs: { name: ["var.lab_id"] },
      },
      { address: "time_sleep.pool_tags", values: { create_duration: "20s" }, refs: {} },
      {
        address: "aws_cognito_user_pool_client.cli",
        values: { name: `lab-${id}-cli`, generate_secret: false, explicit_auth_flows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"], prevent_user_existence_errors: "ENABLED" },
        unknown: ["user_pool_id"],
        refs: { name: ["var.lab_id"], user_pool_id: ref(POOL, "id") },
      },
      {
        address: "aws_cognito_user.labuser",
        values: { username: "labuser", password: "(the session's admin password)", message_action: "SUPPRESS" },
        unknown: ["user_pool_id"],
        sensitive: ["password"],
        refs: { user_pool_id: ref(POOL, "id"), password: ["var.admin_password"] },
      },
      // api.tf
      {
        address: API,
        values: tagged(c, { name: `lab-${id}`, protocol_type: "HTTP", tags: { Name: "api-lab" } }),
        refs: { name: ["var.lab_id"] },
      },
      {
        address: "aws_apigatewayv2_authorizer.cognito",
        values: { authorizer_type: "JWT", name: "cognito", identity_sources: ["$request.header.Authorization"], jwt_configuration: [{}] },
        unknown: ["api_id", "jwt_configuration.0.audience", "jwt_configuration.0.issuer"],
        refs: {
          api_id: apiId,
          "jwt_configuration.0.audience": ref("aws_cognito_user_pool_client.cli", "id"),
          "jwt_configuration.0.issuer": ref(POOL, "endpoint"),
        },
      },
      {
        address: "aws_apigatewayv2_integration.api",
        values: { integration_type: "AWS_PROXY", payload_format_version: "2.0" },
        unknown: ["api_id", "integration_uri"],
        refs: { api_id: apiId, integration_uri: ref("aws_lambda_function.api", "invoke_arn") },
      },
      route("health", "GET /health", false),
      route("items_get", "GET /items", true),
      route("items_post", "POST /items", true),
      {
        address: "aws_apigatewayv2_stage.default",
        values: tagged(c, { name: "$default", auto_deploy: true, default_route_settings: [{ throttling_burst_limit: 10, throttling_rate_limit: 5 }], tags: { Name: "stage-default" } }),
        unknown: ["api_id"],
        refs: { api_id: apiId },
      },
    ],
  };
};
