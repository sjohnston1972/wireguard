// scripts/test/fixtures/labs/plans/labs/soa-02-systems-manager.mjs
//
// Plain English: lab soa-02's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then ssm.tf (the instances' role and profile, the interface
// endpoints, vm-web1 and vm-web2, the patch baseline, group and associations)
// and config.tf (the bucket, the Config recorder, channel and rule, the
// remediation and its roles, sg-demo). Names built from var.lab_id and
// var.name_prefix are known at plan; ids, ARNs and anything built from them
// are unknown. IAM documents are literal JSON (ruling P12).

import { AWS_PROVIDER_CONFIG, BOUNDARY, al2023Instance, awsData, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

const trust = (service) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }] });

export default () => {
  const c = ctxAws("soa-02-systems-manager", "02");
  const id = c.id;
  const bucket = `cloudlabs-${c.prefix}-config`;
  const bucketArn = `arn:aws:s3:::${bucket}`;
  const subnet = ["aws_subnet.private[0].id", "aws_subnet.private[0]", "aws_subnet.private"];
  const role = (key, name, service) => ({
    address: `aws_iam_role.${key}`,
    values: tagged(c, { name: `lab-${id}-${name}`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: trust(service) }),
    refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"] },
  });
  const attach = (key, roleKey, policyArn) => ({
    address: `aws_iam_role_policy_attachment.${key}`,
    values: { role: `lab-${id}-${roleKey === "ssm" ? "ssm" : roleKey}`, ...(policyArn ? { policy_arn: policyArn } : {}) },
    unknown: policyArn ? [] : ["policy_arn"],
    refs: { role: ref(`aws_iam_role.${roleKey}`, "name"), ...(policyArn ? {} : { policy_arn: ref(`aws_iam_policy.${key}`, "arn") }) },
  });
  const endpoint = (key) => ({
    address: `aws_vpc_endpoint.interface["${key}"]`,
    forEach: { references: [], constant_value: ["ssm", "ssmmessages", "ec2messages"] },
    values: tagged(c, { service_name: `com.amazonaws.${c.variables.region}.${key}`, vpc_endpoint_type: "Interface", private_dns_enabled: true, tags: { Name: `vpce-${key}` } }),
    unknown: ["vpc_id", "subnet_ids", "security_group_ids"],
    refs: { vpc_id: ref("aws_vpc.lab", "id"), service_name: ["var.region", "each.key"], subnet_ids: subnet, security_group_ids: ref("aws_security_group.endpoints", "id"), tags: ["each.key"] },
  });
  const web = (i) => {
    const r = al2023Instance(c, { key: `web[${i}]`, name: `vm-web${i + 1}`, subnet: `aws_subnet.private[${i}]`, profile: "aws_iam_instance_profile.ssm" });
    r.count = 2;
    r.values.tags = { Name: `vm-web${i + 1}`, "Patch Group": `lab-${id}-web` };
    r.values.tags_all = { ...c.tags, ...r.values.tags };
    r.refs.subnet_id = ["aws_subnet.private", "count.index"];
    r.refs.volume_tags = ["var.tags", "count.index"];
    r.refs.tags = ["var.lab_id", "count.index"];
    return r;
  };
  const association = (key, name, schedule, targetKey, targetValue, extra = {}) => ({
    address: `aws_ssm_association.${key}`,
    values: tagged(c, { name, association_name: `lab-${id}-${key === "patch_scan" ? "patch-scan" : "inventory"}`, schedule_expression: schedule, targets: [{ key: targetKey, values: [targetValue] }], ...extra }),
    refs: { association_name: ["var.lab_id"], "targets.0.values": ["var.lab_id"] },
  });
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: awsData(),
    resources: [
      ...templateResources(c),
      // ssm.tf
      role("ssm", "ssm", "ec2.amazonaws.com"),
      attach("ssm_core", "ssm", "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"),
      { address: "aws_iam_instance_profile.ssm", values: tagged(c, { name: `lab-${id}-ssm`, path: "/cloudlabs-lab/", role: `lab-${id}-ssm` }), refs: { name: ["var.lab_id"], role: ref("aws_iam_role.ssm", "name") } },
      { address: "aws_security_group.endpoints", values: tagged(c, { name: "lab-endpoints", description: "Interface endpoints: HTTPS from the lab VPC", tags: { Name: "sg-endpoints" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      { address: "aws_vpc_security_group_ingress_rule.endpoints_https", values: tagged(c, { cidr_ipv4: c.vpcCidr, ip_protocol: "tcp", from_port: 443, to_port: 443 }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.endpoints", "id"), cidr_ipv4: ["local.vpc_cidr"] } },
      endpoint("ssm"),
      endpoint("ssmmessages"),
      endpoint("ec2messages"),
      web(0),
      web(1),
      {
        address: "aws_ssm_patch_baseline.al2023",
        values: tagged(c, {
          name: `lab-${id}-al2023`, description: "Security updates rated Critical or Important, approved at once", operating_system: "AMAZON_LINUX_2023",
          approval_rule: [{ approve_after_days: 0, compliance_level: "HIGH", patch_filter: [{ key: "CLASSIFICATION", values: ["Security"] }, { key: "SEVERITY", values: ["Critical", "Important"] }] }],
        }),
        refs: { name: ["var.lab_id"] },
      },
      {
        address: "aws_ssm_patch_group.web",
        values: { patch_group: `lab-${id}-web` },
        unknown: ["baseline_id"],
        refs: { baseline_id: ref("aws_ssm_patch_baseline.al2023", "id"), patch_group: ["var.lab_id"] },
      },
      association("patch_scan", "AWS-RunPatchBaseline", "rate(1 day)", "tag:Patch Group", `lab-${id}-web`, { parameters: { Operation: "Scan" } }),
      association("inventory", "AWS-GatherSoftwareInventory", "rate(30 minutes)", "tag:cloudlabs-lab", id),
      // config.tf
      { address: "aws_s3_bucket.config", values: tagged(c, { bucket, force_destroy: true, tags: { Name: "config-snapshots" } }), refs: { bucket: ["local.config_bucket", "var.name_prefix"] } },
      {
        address: "aws_s3_bucket_public_access_block.config",
        values: { block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true },
        unknown: ["bucket"],
        refs: { bucket: ref("aws_s3_bucket.config", "id") },
      },
      role("config", "config", "config.amazonaws.com"),
      attach("config_managed", "config", "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole"),
      {
        address: "aws_iam_policy.config_delivery",
        values: tagged(c, {
          name: `lab-${id}-config-delivery`, path: "/cloudlabs-lab/",
          policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Action: ["s3:GetBucketAcl", "s3:ListBucket"], Resource: bucketArn },
              { Effect: "Allow", Action: ["s3:PutObject"], Resource: `${bucketArn}/AWSLogs/*` },
            ],
          }),
        }),
        refs: { name: ["var.lab_id"], policy: ["local.config_bucket_arn", "var.name_prefix"] },
      },
      { ...attach("config_delivery", "config", null), refs: { role: ref("aws_iam_role.config", "name"), policy_arn: ref("aws_iam_policy.config_delivery", "arn") } },
      {
        address: "aws_config_configuration_recorder.lab",
        values: { name: `lab-${id}-recorder`, recording_group: [{ all_supported: false, include_global_resource_types: false, resource_types: ["AWS::EC2::SecurityGroup", "AWS::EC2::Instance"] }] },
        unknown: ["role_arn"],
        refs: { name: ["var.lab_id"], role_arn: ref("aws_iam_role.config", "arn") },
      },
      {
        address: "aws_config_delivery_channel.lab",
        values: { name: `lab-${id}-channel`, s3_bucket_name: bucket },
        refs: { name: ["var.lab_id"], s3_bucket_name: ref("aws_s3_bucket.config", "bucket") },
      },
      {
        address: "aws_config_configuration_recorder_status.lab",
        values: { name: `lab-${id}-recorder`, is_enabled: true },
        refs: { name: ["var.lab_id"] },
      },
      {
        address: "aws_config_config_rule.restricted_ssh",
        values: tagged(c, {
          name: `lab-${id}-restricted-ssh`,
          source: [{ owner: "AWS", source_identifier: "INCOMING_SSH_DISABLED" }],
          scope: [{ compliance_resource_types: ["AWS::EC2::SecurityGroup"], tag_key: "cloudlabs-lab", tag_value: id }],
        }),
        refs: { name: ["var.lab_id"], "scope.0.tag_value": ["var.lab_id"] },
      },
      role("remediation", "remediation", "ssm.amazonaws.com"),
      attach("remediation_managed", "remediation", "arn:aws:iam::aws:policy/service-role/AmazonSSMAutomationRole"),
      {
        address: "aws_iam_policy.remediation",
        values: tagged(c, {
          name: `lab-${id}-remediation`, path: "/cloudlabs-lab/",
          policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["ec2:DescribeSecurityGroups", "ec2:RevokeSecurityGroupIngress"], Resource: "*" }] }),
        }),
        refs: { name: ["var.lab_id"] },
      },
      { ...attach("remediation", "remediation", null), refs: { role: ref("aws_iam_role.remediation", "name"), policy_arn: ref("aws_iam_policy.remediation", "arn") } },
      {
        address: "aws_config_remediation_configuration.restricted_ssh",
        values: {
          config_rule_name: `lab-${id}-restricted-ssh`, target_type: "SSM_DOCUMENT", target_id: "AWS-DisablePublicAccessForSecurityGroup", resource_type: "AWS::EC2::SecurityGroup",
          automatic: true, maximum_automatic_attempts: 3, retry_attempt_seconds: 60,
          parameter: [{ name: "AutomationAssumeRole" }, { name: "GroupId", resource_value: "RESOURCE_ID" }],
        },
        unknown: ["parameter.0.static_value"],
        refs: { config_rule_name: ref("aws_config_config_rule.restricted_ssh", "name"), "parameter.0.static_value": ref("aws_iam_role.remediation", "arn") },
      },
      { address: "aws_security_group.demo", values: tagged(c, { name: "lab-demo", description: "Empty and attached to nothing: open SSH here to watch Config remove it", tags: { Name: "sg-demo" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
    ],
  };
};
