// scripts/test/fixtures/labs/plans/labs/soa-04-backup.mjs
//
// Plain English: lab soa-04's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then compute.tf (vm-data, the data volume, its attachment and
// snapshot), backup.tf (vault, role, plan, selection) and s3.tf (two
// versioned buckets, lifecycle, replication role, policy and configuration,
// the first object). Names built from var.lab_id and var.name_prefix are
// known at plan; ids and ARNs are unknown. The IAM documents are literal JSON
// (ruling P12): the replication policy names the buckets by ARNs built from
// names. The instance tags its volumes with volume_tags = var.tags (no Name), and the
// data volume carries only the default tags, so the two agree (final review, Important 1);
// the backup selection names the data volume by ARN (unknown at plan).

import { AWS_PROVIDER_CONFIG, BOUNDARY, al2023Instance, awsData, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("soa-04-backup", "04");
  const id = c.id;
  const src = `cloudlabs-${c.prefix}-src`;
  const dst = `cloudlabs-${c.prefix}-dst`;
  const srcArn = `arn:aws:s3:::${src}`;
  const dstArn = `arn:aws:s3:::${dst}`;
  const BACKUP_POLICIES = ["arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup", "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"];
  const trust = (service) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }] });
  const role = (key, name, service) => ({
    address: `aws_iam_role.${key}`,
    values: tagged(c, { name: `lab-${id}-${name}`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: trust(service) }),
    refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"] },
  });
  const bucket = (key, name, label) => ({
    address: `aws_s3_bucket.${key}`,
    values: tagged(c, { bucket: name, force_destroy: true, tags: { Name: label } }),
    refs: { bucket: [`local.${key}_bucket`, "var.name_prefix"] },
  });
  const onBucket = (type, key, values, extra = {}) => ({
    address: `${type}.${key}`,
    values,
    unknown: ["bucket", ...(extra.unknown ?? [])],
    refs: { bucket: ref(`aws_s3_bucket.${key === "hello" ? "src" : key}`, "id"), ...(extra.refs ?? {}) },
  });
  const block = { block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true };
  const versioning = (key) => onBucket("aws_s3_bucket_versioning", key, { versioning_configuration: [{ status: "Enabled" }] });
  const instance = al2023Instance(c, { key: "data", name: "vm-data", type: "t4g.nano", volumeName: null });
  instance.refs.user_data = ["local.cloud_init_base"];
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: awsData(),
    resources: [
      ...templateResources(c),
      // compute.tf
      instance,
      { address: "aws_ebs_volume.data", values: tagged(c, { availability_zone: "eu-west-2a", size: 1, type: "gp3" }), refs: { availability_zone: ["local.azs"] } },
      {
        address: "aws_volume_attachment.data",
        values: { device_name: "/dev/sdf", stop_instance_before_detaching: true },
        unknown: ["volume_id", "instance_id"],
        refs: { volume_id: ref("aws_ebs_volume.data", "id"), instance_id: ref("aws_instance.data", "id") },
      },
      { address: "time_sleep.first_write", values: { create_duration: "180s" }, refs: {} },
      {
        address: "aws_ebs_snapshot.data",
        values: tagged(c, { description: "Lab soa-04: the data volume as it was at deploy", tags: { Name: "snap-data" } }),
        unknown: ["volume_id"],
        refs: { volume_id: ref("aws_ebs_volume.data", "id") },
      },
      // backup.tf
      { address: "aws_backup_vault.lab", values: tagged(c, { name: `lab-${id}-vault`, force_destroy: true, tags: { Name: "lab-vault" } }), refs: { name: ["var.lab_id"] } },
      role("backup", "backup", "backup.amazonaws.com"),
      ...[["backup_backup", BACKUP_POLICIES[0]], ["backup_restores", BACKUP_POLICIES[1]]].map(([key, arn]) => ({
        address: `aws_iam_role_policy_attachment.${key}`,
        values: { role: `lab-${id}-backup`, policy_arn: arn },
        refs: { role: ref("aws_iam_role.backup", "name") },
      })),
      {
        address: "aws_backup_plan.daily",
        values: tagged(c, {
          name: `lab-${id}-daily`,
          rule: [{ rule_name: "daily", target_vault_name: `lab-${id}-vault`, schedule: "cron(0 5 ? * * *)", start_window: 60, completion_window: 120, recovery_point_tags: c.tags, lifecycle: [{ delete_after: 1 }] }],
          tags: { Name: "lab-daily" },
        }),
        refs: { name: ["var.lab_id"], "rule.0.target_vault_name": ref("aws_backup_vault.lab", "name"), "rule.0.recovery_point_tags": ["var.tags"] },
      },
      {
        address: "aws_backup_selection.data",
        values: {
          name: `lab-${id}-data`,
          resources: [],
          condition: [{ string_equals: [{ key: "aws:ResourceTag/cloudlabs-lab", value: id }] }],
        },
        unknown: ["plan_id", "iam_role_arn", "resources.0"],
        refs: { name: ["var.lab_id"], plan_id: ref("aws_backup_plan.daily", "id"), iam_role_arn: ref("aws_iam_role.backup", "arn"), resources: ref("aws_ebs_volume.data", "arn"), "condition.0.string_equals.0.value": ["var.lab_id"] },
      },
      // s3.tf
      bucket("src", src, "src"),
      bucket("dst", dst, "dst"),
      onBucket("aws_s3_bucket_public_access_block", "src", block),
      onBucket("aws_s3_bucket_public_access_block", "dst", block),
      versioning("src"),
      versioning("dst"),
      onBucket("aws_s3_bucket_lifecycle_configuration", "src", {
        rule: [{ id: "tidy", status: "Enabled", filter: [{}], transition: [{ days: 30, storage_class: "STANDARD_IA" }], noncurrent_version_expiration: [{ noncurrent_days: 30 }] }],
      }),
      role("replication", "replication", "s3.amazonaws.com"),
      {
        address: "aws_iam_policy.replication",
        values: tagged(c, {
          name: `lab-${id}-replication`, path: "/cloudlabs-lab/",
          policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Action: ["s3:GetReplicationConfiguration", "s3:ListBucket"], Resource: srcArn },
              { Effect: "Allow", Action: ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"], Resource: `${srcArn}/*` },
              { Effect: "Allow", Action: ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"], Resource: `${dstArn}/*` },
            ],
          }),
        }),
        refs: { name: ["var.lab_id"], policy: ["local.src_arn", "local.dst_arn", "var.name_prefix"] },
      },
      {
        address: "aws_iam_role_policy_attachment.replication",
        values: { role: `lab-${id}-replication` },
        unknown: ["policy_arn"],
        refs: { role: ref("aws_iam_role.replication", "name"), policy_arn: ref("aws_iam_policy.replication", "arn") },
      },
      { address: "time_sleep.replication_role", values: { create_duration: "20s" }, refs: {} },
      onBucket("aws_s3_bucket_replication_configuration", "src", {
        rule: [{ id: "all", status: "Enabled", filter: [{}], delete_marker_replication: [{ status: "Enabled" }], destination: [{ storage_class: "STANDARD" }] }],
      }, { unknown: ["role"], refs: { role: ref("aws_iam_role.replication", "arn"), "rule.0.destination.0.bucket": ref("aws_s3_bucket.dst", "arn") } }),
      onBucket("aws_s3_object", "hello", tagged(c, { key: "hello.txt", content: "first version\n", content_type: "text/plain" })),
    ],
  };
};
