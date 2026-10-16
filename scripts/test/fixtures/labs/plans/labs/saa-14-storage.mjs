// scripts/test/fixtures/labs/plans/labs/saa-14-storage.mjs
//
// Plain English: lab saa-14's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then compute.tf (vm-storage, the gp3 and io2 volumes and their
// attachments), efs.tf (sg-efs and its rule, the file system, the 20-second
// wait and the two mount targets made by count) and s3.tf (the bucket, its
// public access block, the Intelligent-Tiering archive configuration, the
// lifecycle rules and two objects). The instance's cloud-init names the file
// system's id, so its user_data is unknown (with references). Each volume's
// zone is the subnet's attribute, so it is unknown with a reference to the
// subnet. The file system's creation token and the bucket's name are built
// from the lab id and name prefix, so they are known at plan.

import { AWS_PROVIDER_CONFIG, al2023Instance, awsData, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("saa-14-storage", "14");
  const id = c.id;
  const zone = ["aws_subnet.private[0].availability_zone", "aws_subnet.private[0]", "aws_subnet.private"];
  const instance = al2023Instance(c, { key: "storage", name: "vm-storage", volumeName: null, userDataUnknown: true });
  instance.refs.user_data = ["local.cloud_init_base", ...ref("aws_efs_file_system.shared", "id")];
  const volume = (key, extra) => ({
    address: `aws_ebs_volume.${key}`,
    values: tagged(c, { size: 4, type: key, ...extra }),
    unknown: ["availability_zone"],
    refs: { availability_zone: zone },
  });
  const attachment = (key, device) => ({
    address: `aws_volume_attachment.${key}`,
    values: { device_name: device },
    unknown: ["volume_id", "instance_id"],
    refs: { volume_id: ref(`aws_ebs_volume.${key}`, "id"), instance_id: ref("aws_instance.storage", "id") },
  });
  const bucket = ref("aws_s3_bucket.tiers", "id");
  const onBucket = (type, values, extra = {}) => ({ address: `${type}.${extra.key ?? "tiers"}`, values, unknown: ["bucket"], refs: { bucket, ...(extra.refs ?? {}) } });
  const block = { block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true };
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
      volume("gp3"),
      volume("io2", { iops: 100 }),
      attachment("gp3", "/dev/sdf"),
      attachment("io2", "/dev/sdg"),
      // efs.tf
      { address: "aws_security_group.efs", values: tagged(c, { name: "lab-efs", description: "NFS from the lab instances", tags: { Name: "sg-efs" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      {
        address: "aws_vpc_security_group_ingress_rule.efs_nfs",
        values: tagged(c, { ip_protocol: "tcp", from_port: 2049, to_port: 2049 }),
        unknown: ["security_group_id", "referenced_security_group_id"],
        refs: { security_group_id: ref("aws_security_group.efs", "id"), referenced_security_group_id: ref("aws_security_group.vms", "id") },
      },
      {
        address: "aws_efs_file_system.shared",
        values: tagged(c, { creation_token: `lab-${id}-${c.prefix}`, encrypted: true, performance_mode: "generalPurpose", throughput_mode: "bursting", tags: { Name: "efs-shared" } }),
        refs: { creation_token: ["var.lab_id", "var.name_prefix"] },
      },
      { address: "time_sleep.efs_tags", values: { create_duration: "20s" }, refs: {} },
      ...[0, 1].map((i) => ({
        address: `aws_efs_mount_target.shared[${i}]`,
        count: 2,
        values: {},
        unknown: ["file_system_id", "subnet_id", "security_groups"],
        refs: { file_system_id: ref("aws_efs_file_system.shared", "id"), subnet_id: ["aws_subnet.private", "count.index"], security_groups: ref("aws_security_group.efs", "id") },
      })),
      // s3.tf
      { address: "aws_s3_bucket.tiers", values: tagged(c, { bucket: `cloudlabs-${c.prefix}-tiers`, force_destroy: true, tags: { Name: "tiers" } }), refs: { bucket: ["var.name_prefix"] } },
      onBucket("aws_s3_bucket_public_access_block", block),
      onBucket("aws_s3_bucket_intelligent_tiering_configuration", {
        name: "archive", status: "Enabled",
        tiering: [{ access_tier: "ARCHIVE_ACCESS", days: 90 }, { access_tier: "DEEP_ARCHIVE_ACCESS", days: 180 }],
      }, { key: "archive" }),
      onBucket("aws_s3_bucket_lifecycle_configuration", {
        rule: [
          { id: "reports-to-intelligent-tiering", status: "Enabled", filter: [{ prefix: "reports/" }], transition: [{ days: 0, storage_class: "INTELLIGENT_TIERING" }] },
          { id: "logs", status: "Enabled", filter: [{ prefix: "logs/" }], transition: [{ days: 30, storage_class: "STANDARD_IA" }, { days: 90, storage_class: "GLACIER_IR" }], expiration: [{ days: 365 }] },
        ],
      }),
      onBucket("aws_s3_object", tagged(c, { key: "reports/hello.txt", content: "an object stored straight into Intelligent-Tiering\n", content_type: "text/plain", storage_class: "INTELLIGENT_TIERING" }), { key: "report" }),
      onBucket("aws_s3_object", tagged(c, { key: "logs/first.log", content: "a log line that the logs/ rule will move to Standard-IA after 30 days\n", content_type: "text/plain" }), { key: "log" }),
    ],
  };
};
