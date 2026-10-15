// scripts/test/fixtures/labs/plans/labs/soa-03-auto-scaling.mjs
//
// Plain English: lab soa-03's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then public.tf (internet gateway, two public subnets, their route
// table), alb.tf (the load balancer, its security groups, target group and
// listener) and asg.tf (the launch template, the Auto Scaling group and its
// policy, schedule and lifecycle hook). Names built from var.lab_id and
// var.name_prefix are known at plan; ids and ARNs are unknown. The group has
// no tags_all (its tag blocks carry the lab, session and project tags); the launch template's
// tag_specifications hold the session's tags, and its user_data is known
// (built from locals of known values) but sensitive because it holds the
// password. The group's name is set literally, so the policy, schedule and
// hook know their autoscaling_group_name at plan (the real plan, 2026-10-15).

import { AWS_PROVIDER_CONFIG, awsData, cidrsubnet, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("soa-03-auto-scaling", "03");
  const id = c.id;
  const VPC = "aws_vpc.lab";
  const asg = `asg-${c.prefix}`;
  const sgRule = (address, sg, extra, unknown, refs) => ({ address, values: tagged(c, { ip_protocol: "tcp", from_port: 80, to_port: 80, ...extra }), unknown: ["security_group_id", ...unknown], refs: { security_group_id: ref(sg, "id"), ...refs } });
  const publicSubnet = (i) => ({
    address: `aws_subnet.public[${i}]`,
    count: 2,
    values: tagged(c, { cidr_block: cidrsubnet(c.vpcCidr, 4, 8 + i), availability_zone: `eu-west-2${"ab"[i]}`, map_public_ip_on_launch: false, tags: { Name: `snet-public-${i + 1}` } }),
    unknown: ["vpc_id"],
    refs: { vpc_id: ref(VPC, "id"), cidr_block: ["local.vpc_cidr", "count.index"], availability_zone: ["local.azs", "count.index"], tags: ["count.index"] },
  });
  const publicAssoc = (i) => ({
    address: `aws_route_table_association.public[${i}]`,
    count: 2,
    values: {},
    unknown: ["subnet_id", "route_table_id"],
    refs: { subnet_id: ["aws_subnet.public", "count.index"], route_table_id: ref("aws_route_table.public", "id") },
  });
  const spec = (type) => ({ resource_type: type, tags: { ...c.tags, Name: "vm-web" } });
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: awsData(),
    resources: [
      ...templateResources(c),
      // public.tf
      { address: "aws_internet_gateway.lab", values: tagged(c, { tags: { Name: "igw-lab" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC, "id") } },
      publicSubnet(0),
      publicSubnet(1),
      { address: "aws_route_table.public", values: tagged(c, { tags: { Name: "rt-public" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC, "id") } },
      {
        address: "aws_route.public_internet",
        values: { destination_cidr_block: "0.0.0.0/0" },
        unknown: ["route_table_id", "gateway_id"],
        refs: { route_table_id: ref("aws_route_table.public", "id"), gateway_id: ref("aws_internet_gateway.lab", "id") },
      },
      publicAssoc(0),
      publicAssoc(1),
      // alb.tf
      { address: "aws_security_group.alb", values: tagged(c, { name: "lab-alb", description: "The load balancer: HTTP from the internet, HTTP on to the instances", tags: { Name: "sg-alb" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC, "id") } },
      sgRule("aws_vpc_security_group_ingress_rule.alb_http", "aws_security_group.alb", { cidr_ipv4: "0.0.0.0/0" }, [], {}),
      sgRule("aws_vpc_security_group_egress_rule.alb_to_vms", "aws_security_group.alb", {}, ["referenced_security_group_id"], { referenced_security_group_id: ref("aws_security_group.vms", "id") }),
      sgRule("aws_vpc_security_group_ingress_rule.vms_http_alb", "aws_security_group.vms", {}, ["referenced_security_group_id"], { referenced_security_group_id: ref("aws_security_group.alb", "id") }),
      {
        address: "aws_lb.web",
        values: tagged(c, { name: `alb-${c.prefix}`, internal: false, load_balancer_type: "application", enable_deletion_protection: false, tags: { Name: "alb-web" } }),
        unknown: ["security_groups", "subnets"],
        refs: { name: ["var.name_prefix"], security_groups: ref("aws_security_group.alb", "id"), subnets: ["aws_subnet.public"] },
      },
      {
        address: "aws_lb_target_group.web",
        values: tagged(c, {
          name: `tg-${c.prefix}`, port: 80, protocol: "HTTP", deregistration_delay: "30",
          health_check: [{ path: "/", interval: 15, healthy_threshold: 2, unhealthy_threshold: 2, matcher: "200" }],
          tags: { Name: "tg-web" },
        }),
        unknown: ["vpc_id"],
        refs: { name: ["var.name_prefix"], vpc_id: ref(VPC, "id") },
      },
      {
        address: "aws_lb_listener.http",
        values: tagged(c, { port: 80, protocol: "HTTP", default_action: [{ type: "forward" }], tags: { Name: "listener-http" } }),
        unknown: ["load_balancer_arn", "default_action.0.target_group_arn"],
        refs: { load_balancer_arn: ref("aws_lb.web", "arn"), "default_action.0.target_group_arn": ref("aws_lb_target_group.web", "arn") },
      },
      // asg.tf
      {
        address: "aws_launch_template.web",
        values: tagged(c, {
          name: `lt-${c.prefix}`, image_id: "ami-0123456789abcdef0", instance_type: "t4g.micro", update_default_version: true, user_data: "(base64 of the web cloud-init)",
          metadata_options: [{ http_tokens: "required", http_endpoint: "enabled" }],
          block_device_mappings: [{ device_name: "/dev/xvda", ebs: [{ volume_size: 8, volume_type: "gp3", delete_on_termination: "true" }] }],
          tag_specifications: [spec("instance"), spec("volume"), spec("network-interface")],
          tags: { Name: "lt-web" },
        }),
        unknown: ["vpc_security_group_ids"],
        sensitive: ["user_data"],
        refs: {
          name: ["var.name_prefix"],
          image_id: ["data.aws_ssm_parameter.al2023_arm64.insecure_value", "data.aws_ssm_parameter.al2023_arm64"],
          vpc_security_group_ids: ref("aws_security_group.vms", "id"),
          user_data: ["local.web_cloud_init"],
          "tag_specifications.0.tags": ["var.tags"],
          "tag_specifications.1.tags": ["var.tags"],
          "tag_specifications.2.tags": ["var.tags"],
        },
      },
      {
        address: "aws_autoscaling_group.web",
        values: {
          name: asg, min_size: 2, max_size: 4, desired_capacity: 2, health_check_type: "ELB", health_check_grace_period: 120, force_delete: true, wait_for_capacity_timeout: "10m",
          launch_template: [{}],
          instance_refresh: [{ strategy: "Rolling", preferences: [{ min_healthy_percentage: 50 }] }],
          tag: [{ key: "cloudlabs-lab", value: id, propagate_at_launch: true }, { key: "cloudlabs-session", value: c.tags["cloudlabs-session"], propagate_at_launch: true }, { key: "project", value: "cloudlabs", propagate_at_launch: true }, { key: "Name", value: "vm-web", propagate_at_launch: true }],
        },
        unknown: ["vpc_zone_identifier", "target_group_arns", "launch_template.0.id", "launch_template.0.version"],
        refs: {
          name: ["var.name_prefix"],
          // A splat (aws_subnet.private[*].id) is listed as the resource alone.
          vpc_zone_identifier: ["aws_subnet.private"],
          target_group_arns: ref("aws_lb_target_group.web", "arn"),
          "launch_template.0.id": ref("aws_launch_template.web", "id"),
          "launch_template.0.version": ref("aws_launch_template.web", "latest_version"),
          "tag.0.value": ["var.lab_id"],
          // var.tags["key"]: the indexed reference, then the variable.
          "tag.1.value": ['var.tags["cloudlabs-session"]', "var.tags"],
          "tag.2.value": ['var.tags["project"]', "var.tags"],
        },
      },
      {
        address: "aws_autoscaling_policy.cpu",
        values: { name: "cpu-50", autoscaling_group_name: asg, policy_type: "TargetTrackingScaling", target_tracking_configuration: [{ predefined_metric_specification: [{ predefined_metric_type: "ASGAverageCPUUtilization" }], target_value: 50 }] },
        refs: { autoscaling_group_name: ref("aws_autoscaling_group.web", "name") },
      },
      {
        address: "aws_autoscaling_schedule.evening",
        values: { scheduled_action_name: "evening-back-to-two", autoscaling_group_name: asg, recurrence: "0 22 * * *", time_zone: "Europe/London", min_size: 2, max_size: 4, desired_capacity: 2 },
        refs: { autoscaling_group_name: ref("aws_autoscaling_group.web", "name") },
      },
      {
        address: "aws_autoscaling_lifecycle_hook.launch",
        values: { name: "launch-wait", autoscaling_group_name: asg, lifecycle_transition: "autoscaling:EC2_INSTANCE_LAUNCHING", heartbeat_timeout: 60, default_result: "CONTINUE" },
        refs: { autoscaling_group_name: ref("aws_autoscaling_group.web", "name") },
      },
    ],
  };
};
