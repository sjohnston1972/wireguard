// scripts/test/fixtures/labs/plans/labs/saa-17-data-pipeline.mjs
//
// Plain English: lab saa-17's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the
// template's resource group, then stream.tf (the Kinesis stream, the
// producer's log group, role, policy, attachments and function, the wait, the
// every-minute rule, its permission and target), delivery.tf (the lake bucket
// and its public access block, the Firehose role, policy and attachment, the
// wait and the delivery stream) and catalog.tf (the Glue database, the
// crawler's role, policy and attachment, the crawler and the Athena
// workgroup). The lab has no network.tf (ruling A61). Every name, the three
// policies (built from the account, region, lab id and name prefix), the
// database name, the crawler's S3 path and the workgroup's configuration are
// known at plan; what is built from another resource's attribute is unknown,
// with its references: the permission's source_arn, the target's arn, the
// delivery stream's source stream, role and bucket, and the crawler's role.

import { ACCOUNT, AWS_PROVIDER_CONFIG, BOUNDARY, ctxAws, ref, tagged, templateMainData, templateMainResources } from "../common-aws.mjs";

/** A policy document as Terraform's jsonencode prints it: object keys in sorted order. */
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
const doc = (statements) => JSON.stringify(sorted({ Version: "2012-10-17", Statement: statements }));

export default () => {
  const c = ctxAws("saa-17-data-pipeline", "17");
  const id = c.id;
  const region = c.variables.region;
  const lake = `cloudlabs-${c.prefix}-lake`;
  const glueDb = `lab_${id.replaceAll("-", "_")}`;
  const glueArn = `arn:aws:glue:${region}:${ACCOUNT}`;
  const streamArn = `arn:aws:kinesis:${region}:${ACCOUNT}:stream/lab-${id}-events`;
  const archive = "data.archive_file.producer";
  const assume = (service) => doc([{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }]);
  const role = (key, service) => ({
    address: `aws_iam_role.${key}`,
    values: tagged(c, { name: `lab-${id}-${key}`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: assume(service) }),
    refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"] },
  });
  const policy = (key, statements, refs) => ({
    address: `aws_iam_policy.${key}`,
    values: tagged(c, { name: `lab-${id}-${key}`, path: "/cloudlabs-lab/", policy: doc(statements) }),
    refs: { name: ["var.lab_id"], policy: refs },
  });
  const attach = (key) => ({
    address: `aws_iam_role_policy_attachment.${key}`,
    values: { role: `lab-${id}-${key}` },
    unknown: ["policy_arn"],
    refs: { role: ref(`aws_iam_role.${key}`, "name"), policy_arn: ref(`aws_iam_policy.${key}`, "arn") },
  });
  const lakeArns = [`arn:aws:s3:::${lake}`, `arn:aws:s3:::${lake}/*`];
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: [
      ...templateMainData(),
      {
        address: archive,
        values: { type: "zip", source_file: "/work/labs/saa-17-data-pipeline/terraform/lambda/producer.py", output_path: "/work/labs/saa-17-data-pipeline/terraform/.terraform/producer.zip", output_base64sha256: "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmE=" },
        args: ["type"],
        refs: { source_file: ["path.module"], output_path: ["path.module"] },
      },
    ],
    resources: [
      ...templateMainResources(c),
      // stream.tf
      {
        address: "aws_kinesis_stream.events",
        values: tagged(c, {
          name: `lab-${id}-events`, shard_count: 1, retention_period: 24, enforce_consumer_deletion: true,
          stream_mode_details: [{ stream_mode: "PROVISIONED" }],
          tags: { Name: "stream-events" },
        }),
        refs: { name: ["var.lab_id"] },
      },
      {
        address: "aws_cloudwatch_log_group.producer",
        values: tagged(c, { name: `/cloudlabs/${id}/producer`, retention_in_days: 1 }),
        refs: { name: ["var.lab_id"] },
      },
      role("producer", "lambda.amazonaws.com"),
      {
        address: "aws_iam_role_policy_attachment.producer_logs",
        values: { role: `lab-${id}-producer`, policy_arn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" },
        refs: { role: ref("aws_iam_role.producer", "name") },
      },
      policy("producer", [{ Sid: "LabStream", Effect: "Allow", Action: ["kinesis:PutRecord", "kinesis:PutRecords"], Resource: streamArn }], ["local.stream_arn"]),
      attach("producer"),
      {
        address: "aws_lambda_function.producer",
        values: tagged(c, {
          function_name: `lab-${id}-producer`, runtime: "python3.13", architectures: ["arm64"], handler: "producer.handler", memory_size: 128, timeout: 30,
          environment: [{ variables: { STREAM: `lab-${id}-events` } }],
          logging_config: [{ log_format: "Text", log_group: `/cloudlabs/${id}/producer` }],
          tags: { Name: "fn-producer" },
        }),
        unknown: ["role"],
        refs: {
          function_name: ["var.lab_id"],
          role: ref("aws_iam_role.producer", "arn"),
          filename: ref(archive, "output_path"),
          source_code_hash: ref(archive, "output_base64sha256"),
          "environment.0.variables": ref("aws_kinesis_stream.events", "name"),
          "logging_config.0.log_group": ref("aws_cloudwatch_log_group.producer", "name"),
        },
      },
      { address: "time_sleep.producer_tags", values: { create_duration: "20s" }, refs: {} },
      {
        address: "aws_cloudwatch_event_rule.every_minute",
        values: tagged(c, { name: `lab-${id}-every-minute`, schedule_expression: "rate(1 minute)", tags: { Name: "rule-every-minute" } }),
        refs: { name: ["var.lab_id"] },
      },
      {
        address: "aws_lambda_permission.every_minute",
        values: { statement_id: "EveryMinute", action: "lambda:InvokeFunction", function_name: `lab-${id}-producer`, principal: "events.amazonaws.com" },
        unknown: ["source_arn"],
        refs: { function_name: ref("aws_lambda_function.producer", "function_name"), source_arn: ref("aws_cloudwatch_event_rule.every_minute", "arn") },
      },
      {
        address: "aws_cloudwatch_event_target.producer",
        values: { rule: `lab-${id}-every-minute`, target_id: "producer" },
        unknown: ["arn"],
        refs: { rule: ref("aws_cloudwatch_event_rule.every_minute", "name"), arn: ref("aws_lambda_function.producer", "arn") },
      },
      // delivery.tf
      { address: "aws_s3_bucket.lake", values: tagged(c, { bucket: lake, force_destroy: true, tags: { Name: "lake" } }), refs: { bucket: ["var.name_prefix"] } },
      {
        address: "aws_s3_bucket_public_access_block.lake",
        values: { block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true },
        unknown: ["bucket"],
        refs: { bucket: ref("aws_s3_bucket.lake", "id") },
      },
      role("firehose", "firehose.amazonaws.com"),
      policy("firehose", [
        { Sid: "ReadTheStream", Effect: "Allow", Action: ["kinesis:DescribeStream", "kinesis:DescribeStreamSummary", "kinesis:GetShardIterator", "kinesis:GetRecords", "kinesis:ListShards"], Resource: streamArn },
        { Sid: "WriteTheLake", Effect: "Allow", Action: ["s3:AbortMultipartUpload", "s3:GetBucketLocation", "s3:GetObject", "s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:PutObject"], Resource: lakeArns },
      ], ["local.stream_arn", "var.name_prefix"]),
      attach("firehose"),
      { address: "time_sleep.firehose_role", values: { create_duration: "20s" }, refs: {} },
      {
        address: "aws_kinesis_firehose_delivery_stream.to_s3",
        values: tagged(c, {
          name: `lab-${id}-to-s3`, destination: "extended_s3",
          kinesis_source_configuration: [{}],
          extended_s3_configuration: [{
            prefix: "events/", error_output_prefix: "errors/!{firehose:error-output-type}/", buffering_size: 1, buffering_interval: 60, compression_format: "UNCOMPRESSED",
            cloudwatch_logging_options: [{ enabled: false }],
          }],
          tags: { Name: "firehose-to-s3" },
        }),
        unknown: ["kinesis_source_configuration.0.kinesis_stream_arn", "kinesis_source_configuration.0.role_arn", "extended_s3_configuration.0.role_arn", "extended_s3_configuration.0.bucket_arn"],
        refs: {
          name: ["var.lab_id"],
          "kinesis_source_configuration.0.kinesis_stream_arn": ref("aws_kinesis_stream.events", "arn"),
          "kinesis_source_configuration.0.role_arn": ref("aws_iam_role.firehose", "arn"),
          "extended_s3_configuration.0.role_arn": ref("aws_iam_role.firehose", "arn"),
          "extended_s3_configuration.0.bucket_arn": ref("aws_s3_bucket.lake", "arn"),
        },
      },
      // catalog.tf
      {
        address: "aws_glue_catalog_database.lake",
        values: tagged(c, { name: glueDb, description: `lab ${id}: the lake's tables`, tags: { Name: "glue-lake" } }),
        refs: { name: ["local.glue_db"], description: ["var.lab_id"] },
      },
      role("crawler", "glue.amazonaws.com"),
      policy("crawler", [
        { Sid: "LabCatalogue", Effect: "Allow", Action: "glue:*", Resource: [`${glueArn}:catalog`, `${glueArn}:database/${glueDb}`, `${glueArn}:table/${glueDb}/*`] },
        { Sid: "ReadTheLake", Effect: "Allow", Action: ["s3:GetObject", "s3:ListBucket"], Resource: [`arn:aws:s3:::${lake}`, `arn:aws:s3:::${lake}/events/*`] },
      ], ["local.glue_arn", "local.glue_db", "var.name_prefix"]),
      attach("crawler"),
      {
        address: "aws_glue_crawler.events",
        values: tagged(c, {
          name: `lab-${id}-events`, database_name: glueDb,
          s3_target: [{ path: `s3://${lake}/events/` }],
          schema_change_policy: [{ delete_behavior: "DELETE_FROM_DATABASE", update_behavior: "UPDATE_IN_DATABASE" }],
          tags: { Name: "crawler-events" },
        }),
        unknown: ["role"],
        refs: {
          name: ["var.lab_id"],
          database_name: ref("aws_glue_catalog_database.lake", "name"),
          role: ref("aws_iam_role.crawler", "arn"),
          "s3_target.0.path": ref("aws_s3_bucket.lake", "bucket"),
        },
      },
      {
        address: "aws_athena_workgroup.wg",
        values: tagged(c, {
          name: `lab-${id}-wg`, force_destroy: true,
          configuration: [{
            enforce_workgroup_configuration: true, publish_cloudwatch_metrics_enabled: false, bytes_scanned_cutoff_per_query: 10485760,
            result_configuration: [{ output_location: `s3://${lake}/athena-results/` }],
          }],
          tags: { Name: "athena-wg" },
        }),
        refs: { name: ["var.lab_id"], "configuration.0.result_configuration.0.output_location": ref("aws_s3_bucket.lake", "bucket") },
      },
    ],
  };
};
