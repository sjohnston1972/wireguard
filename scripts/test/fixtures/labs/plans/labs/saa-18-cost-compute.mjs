// scripts/test/fixtures/labs/plans/labs/saa-18-cost-compute.mjs
//
// Plain English: lab saa-18's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then compute.tf: the x86 AMI parameter, two launch templates (one
// resource, for_each over arm and x86, each with its image and user data known
// from the parameters and locals, user_data sensitive because it holds the
// password) and the mixed-instances Auto Scaling group asg-<prefix>. The
// group's distribution and its three overrides are known at plan; the two
// launch template ids it points at are not (they are the templates' ids, so
// they carry references). The group is named literally, so its name is known.

import { AWS_PROVIDER_CONFIG, awsData, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

const X86_AMI = "ami-0fedcba9876543210";

export default () => {
  const c = ctxAws("saa-18-cost-compute", "18");
  const id = c.id;
  const asg = `asg-${c.prefix}`;
  const templates = { forEach: { references: ["local.templates"] } };
  const spec = (type, key) => ({ resource_type: type, tags: { ...c.tags, Name: `vm-${key}` } });
  const template = (key, image, type) => ({
    address: `aws_launch_template.mixed["${key}"]`,
    ...templates,
    values: tagged(c, {
      name: `lt-${c.prefix}-${key}`, image_id: image, instance_type: type, update_default_version: true, user_data: "(base64 of the mixed cloud-init)",
      metadata_options: [{ http_tokens: "required", http_endpoint: "enabled" }],
      block_device_mappings: [{ device_name: "/dev/xvda", ebs: [{ volume_size: 8, volume_type: "gp3", delete_on_termination: "true" }] }],
      tag_specifications: [spec("instance", key), spec("volume", key), spec("network-interface", key)],
      tags: { Name: `lt-${key}` },
    }),
    unknown: ["vpc_security_group_ids"],
    sensitive: ["user_data"],
    refs: {
      name: ["var.name_prefix", "each.key"],
      image_id: ["each.value"],
      instance_type: ["each.key"],
      vpc_security_group_ids: ref("aws_security_group.vms", "id"),
      user_data: ["local.mixed_cloud_init"],
      "tag_specifications.0.tags": ["var.tags", "each.key"],
      "tag_specifications.1.tags": ["var.tags", "each.key"],
      "tag_specifications.2.tags": ["var.tags", "each.key"],
      tags: ["each.key"],
    },
  });
  const templateId = (key) => [`aws_launch_template.mixed["${key}"].id`, `aws_launch_template.mixed["${key}"]`, "aws_launch_template.mixed"];
  const base = "mixed_instances_policy.0.launch_template.0";
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: [...awsData(), { address: "data.aws_ssm_parameter.al2023_x86", values: { name: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64", insecure_value: X86_AMI }, args: ["name"], refs: {} }],
    resources: [
      ...templateResources(c),
      template("arm", "ami-0123456789abcdef0", "t4g.micro"),
      template("x86", X86_AMI, "t3.micro"),
      {
        address: "aws_autoscaling_group.mixed",
        values: {
          name: asg, min_size: 3, max_size: 4, desired_capacity: 3, capacity_rebalance: true, force_delete: true, wait_for_capacity_timeout: "0",
          mixed_instances_policy: [{
            instances_distribution: [{ on_demand_base_capacity: 1, on_demand_percentage_above_base_capacity: 0, spot_allocation_strategy: "price-capacity-optimized" }],
            launch_template: [{
              launch_template_specification: [{ version: "$Latest" }],
              override: [
                { instance_type: "t4g.micro", launch_template_specification: [] },
                { instance_type: "t4g.small", launch_template_specification: [] },
                { instance_type: "t3.micro", launch_template_specification: [{ version: "$Latest" }] },
              ],
            }],
          }],
          tag: [{ key: "cloudlabs-lab", value: id, propagate_at_launch: true }, { key: "cloudlabs-session", value: c.tags["cloudlabs-session"], propagate_at_launch: true }, { key: "project", value: "cloudlabs", propagate_at_launch: true }, { key: "Name", value: "vm-mixed", propagate_at_launch: true }],
        },
        unknown: ["vpc_zone_identifier", `${base}.launch_template_specification.0.launch_template_id`, `${base}.override.2.launch_template_specification.0.launch_template_id`],
        refs: {
          name: ["var.name_prefix"],
          // A splat (aws_subnet.private[*].id) is listed as the resource alone.
          vpc_zone_identifier: ["aws_subnet.private"],
          [`${base}.launch_template_specification.0.launch_template_id`]: templateId("arm"),
          [`${base}.override.2.launch_template_specification.0.launch_template_id`]: templateId("x86"),
          "tag.0.value": ["var.lab_id"],
          // var.tags["key"]: the indexed reference, then the variable.
          "tag.1.value": ['var.tags["cloudlabs-session"]', "var.tags"],
          "tag.2.value": ['var.tags["project"]', "var.tags"],
        },
      },
    ],
  };
};
