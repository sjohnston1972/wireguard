// scripts/test/fixtures/labs/plans/labs/soa-07-iam-kms.mjs
//
// Plain English: lab soa-07's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the
// template's resource group, then identity.tf (ann, her login profile, policy
// and attachment, the account analyzer), kms.tf (the key and its alias) and
// secret.tf (the password, the secret, the rotation role, its policies, log
// group and function, a short wait, the first version, the Secrets Manager
// permission and the rotation). The lab has no network.tf (ruling P3), so no
// zones and no AMI are read; data.archive_file.rotate is read at plan, as
// Terraform reads data sources, with the zip's hash known. Names and the IAM
// documents and the key policy are built from var.lab_id, var.region and the
// caller identity, so they are known at plan; ids, ARNs, the generated
// passwords and the version's secret_string are not.

import { ACCOUNT, AWS_PROVIDER_CONFIG, BOUNDARY, ctxAws, ref, tagged, templateMainData, templateMainResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("soa-07-iam-kms", "07");
  const id = c.id;
  const region = c.variables.region;
  const secretsArn = `arn:aws:secretsmanager:${region}:${ACCOUNT}:secret:lab-${id}-*`;
  const alias = `alias/lab-${id}-data`;
  const keyCondition = { "ForAnyValue:StringEquals": { "kms:ResourceAliases": alias } };
  const keyAliasRefs = ["local.key_alias"];
  const policyDoc = (statements) => JSON.stringify({ Version: "2012-10-17", Statement: statements });
  const trust = (service) => policyDoc([{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }]);
  const account = ref("data.aws_caller_identity.current", "account_id");
  const archive = "data.archive_file.rotate";
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: [
      ...templateMainData(),
      {
        address: archive,
        values: { type: "zip", source_file: "/work/labs/soa-07-iam-kms/terraform/lambda/rotate.py", output_path: "/work/labs/soa-07-iam-kms/terraform/.terraform/rotate.zip", output_base64sha256: "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmE=" },
        args: ["type"],
        refs: { source_file: ["path.module"], output_path: ["path.module"] },
      },
    ],
    resources: [
      ...templateMainResources(c),
      // identity.tf
      {
        address: "aws_iam_user.ann",
        values: tagged(c, { name: `lab-${id}-ann`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, force_destroy: true, tags: { Name: "user-ann" } }),
        refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"] },
      },
      {
        address: "aws_iam_user_login_profile.ann",
        values: { user: `lab-${id}-ann`, password_length: 20, password_reset_required: false },
        refs: { user: ref("aws_iam_user.ann", "name") },
      },
      {
        address: "aws_iam_policy.ann",
        values: tagged(c, {
          name: `lab-${id}-ann`, path: "/cloudlabs-lab/",
          policy: policyDoc([
            { Sid: "LookAround", Effect: "Allow", Action: ["ec2:Describe*", "cloudformation:ListStacks", "cloudformation:DescribeStacks", "kms:ListKeys", "kms:ListAliases", "secretsmanager:ListSecrets"], Resource: "*" },
            { Sid: "LabKey", Effect: "Allow", Action: ["kms:DescribeKey", "kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"], Resource: "*", Condition: keyCondition },
            { Sid: "LabSecret", Effect: "Allow", Action: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"], Resource: secretsArn },
          ]),
        }),
        refs: { name: ["var.lab_id"], policy: [...keyAliasRefs, "var.region", ...account, "var.lab_id"] },
      },
      {
        address: "aws_iam_user_policy_attachment.ann",
        values: { user: `lab-${id}-ann` },
        unknown: ["policy_arn"],
        refs: { user: ref("aws_iam_user.ann", "name"), policy_arn: ref("aws_iam_policy.ann", "arn") },
      },
      {
        address: "aws_accessanalyzer_analyzer.account",
        values: tagged(c, { analyzer_name: `lab-${id}-account`, type: "ACCOUNT", tags: { Name: "analyzer-account" } }),
        refs: { analyzer_name: ["var.lab_id"] },
      },
      // kms.tf
      {
        address: "aws_kms_key.data",
        values: tagged(c, {
          description: `lab ${id}, encrypts the lab secret`, deletion_window_in_days: 7,
          policy: policyDoc([{ Sid: "TheAccountAndItsIamPolicies", Effect: "Allow", Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` }, Action: "kms:*", Resource: "*" }]),
          tags: { Name: "key-data" },
        }),
        refs: { description: ["var.lab_id"], policy: [...account] },
      },
      {
        address: "aws_kms_alias.data",
        values: { name: alias },
        unknown: ["target_key_id"],
        refs: { name: keyAliasRefs, target_key_id: ["aws_kms_key.data.key_id", "aws_kms_key.data"] },
      },
      // secret.tf
      { address: "random_password.app", values: { length: 24, special: false }, sensitive: ["bcrypt_hash", "result"] },
      {
        address: "aws_secretsmanager_secret.app",
        values: tagged(c, { name: `lab-${id}-app-${c.prefix}`, description: `lab ${id}, an application database login`, recovery_window_in_days: 0, tags: { Name: "secret-app" } }),
        unknown: ["kms_key_id"],
        refs: { name: ["var.lab_id", "var.name_prefix"], description: ["var.lab_id"], kms_key_id: ref("aws_kms_key.data", "arn") },
      },
      {
        address: "aws_iam_role.rotate",
        values: tagged(c, { name: `lab-${id}-rotate`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: trust("lambda.amazonaws.com") }),
        refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"] },
      },
      {
        address: "aws_iam_role_policy_attachment.rotate_logs",
        values: { role: `lab-${id}-rotate`, policy_arn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" },
        refs: { role: ref("aws_iam_role.rotate", "name") },
      },
      {
        address: "aws_iam_policy.rotate",
        values: tagged(c, {
          name: `lab-${id}-rotate`, path: "/cloudlabs-lab/",
          policy: policyDoc([
            { Sid: "LabSecrets", Effect: "Allow", Action: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecretVersionStage"], Resource: secretsArn },
            { Sid: "NewPasswords", Effect: "Allow", Action: "secretsmanager:GetRandomPassword", Resource: "*" },
            { Sid: "LabKey", Effect: "Allow", Action: ["kms:Decrypt", "kms:GenerateDataKey"], Resource: "*", Condition: keyCondition },
          ]),
        }),
        refs: { name: ["var.lab_id"], policy: ["var.region", ...account, "var.lab_id", ...keyAliasRefs] },
      },
      {
        address: "aws_iam_role_policy_attachment.rotate",
        values: { role: `lab-${id}-rotate` },
        unknown: ["policy_arn"],
        refs: { role: ref("aws_iam_role.rotate", "name"), policy_arn: ref("aws_iam_policy.rotate", "arn") },
      },
      {
        address: "aws_cloudwatch_log_group.rotate",
        values: tagged(c, { name: `/cloudlabs/${id}/rotate`, retention_in_days: 1 }),
        refs: { name: ["var.lab_id"] },
      },
      {
        address: "aws_lambda_function.rotate",
        values: tagged(c, {
          function_name: `lab-${id}-rotate`, runtime: "python3.13", architectures: ["arm64"], handler: "rotate.handler", memory_size: 128, timeout: 30,
          logging_config: [{ log_format: "Text", log_group: `/cloudlabs/${id}/rotate` }],
          tags: { Name: "fn-rotate" },
        }),
        unknown: ["role"],
        refs: {
          function_name: ["var.lab_id"],
          role: ref("aws_iam_role.rotate", "arn"),
          filename: ref(archive, "output_path"),
          source_code_hash: ref(archive, "output_base64sha256"),
          "logging_config.0.log_group": ref("aws_cloudwatch_log_group.rotate", "name"),
        },
      },
      { address: "time_sleep.tags", values: { create_duration: "20s" }, refs: {} },
      {
        address: "aws_secretsmanager_secret_version.app",
        values: {},
        unknown: ["secret_id", "secret_string"],
        sensitive: ["secret_string"],
        refs: { secret_id: ref("aws_secretsmanager_secret.app", "id"), secret_string: ref("random_password.app", "result") },
      },
      {
        address: "aws_lambda_permission.secrets_manager",
        values: { statement_id: "SecretsManagerRotation", action: "lambda:InvokeFunction", function_name: `lab-${id}-rotate`, principal: "secretsmanager.amazonaws.com" },
        unknown: ["source_arn"],
        refs: { function_name: ref("aws_lambda_function.rotate", "function_name"), source_arn: ref("aws_secretsmanager_secret.app", "arn") },
      },
      {
        address: "aws_secretsmanager_secret_rotation.app",
        values: { rotation_rules: [{ automatically_after_days: 30 }] },
        unknown: ["secret_id", "rotation_lambda_arn"],
        refs: { secret_id: ref("aws_secretsmanager_secret.app", "id"), rotation_lambda_arn: ref("aws_lambda_function.rotate", "arn") },
      },
    ],
  };
};
