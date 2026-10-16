// scripts/test/fixtures/labs/plans/labs/soa-10-containers.mjs
//
// Plain English: lab soa-10's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then public.tf (as soa-03's), nat.tf (the Elastic IP, the NAT
// gateway and the private default route), alb.tf (the load balancer, target
// group, listener and the security group rules) and ecs.tf (the ECR repository
// and its lifecycle policy after the 20-second wait, the cluster, the log
// group, the execution role, the task definition and the service). Names built
// from var.lab_id and var.name_prefix are known at plan; ids and ARNs are
// unknown. The task definition's container definitions are built from locals
// and var.region, so they are known (rule `lingering` reads the awslogs group).

import { AWS_PROVIDER_CONFIG, BOUNDARY, awsData, cidrsubnet, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("soa-10-containers", "10");
  const id = c.id;
  const VPC = "aws_vpc.lab";
  const group = `/cloudlabs/${id}/web`;
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
  // jsonencode prints object keys in sorted order.
  const containers = JSON.stringify([{
    essential: true,
    image: "public.ecr.aws/nginx/nginx:stable-alpine",
    logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": group, "awslogs-region": "eu-west-2", "awslogs-stream-prefix": "web" } },
    name: "web",
    portMappings: [{ containerPort: 80, protocol: "tcp" }],
  }]);
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
      // nat.tf
      { address: "aws_eip.nat", values: tagged(c, { domain: "vpc", tags: { Name: "eip-nat" } }), refs: {} },
      { address: "aws_nat_gateway.lab", values: tagged(c, { tags: { Name: "nat-lab" } }), unknown: ["allocation_id", "subnet_id"], refs: { allocation_id: ref("aws_eip.nat", "id"), subnet_id: ["aws_subnet.public[0].id", "aws_subnet.public[0]", "aws_subnet.public"] } },
      {
        address: "aws_route.private_nat",
        values: { destination_cidr_block: "0.0.0.0/0" },
        unknown: ["route_table_id", "nat_gateway_id"],
        refs: { route_table_id: ref("aws_route_table.private", "id"), nat_gateway_id: ref("aws_nat_gateway.lab", "id") },
      },
      // alb.tf
      { address: "aws_security_group.alb", values: tagged(c, { name: "lab-alb", description: "The load balancer: HTTP from the internet, HTTP on to the tasks", tags: { Name: "sg-alb" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC, "id") } },
      sgRule("aws_vpc_security_group_ingress_rule.alb_http", "aws_security_group.alb", { cidr_ipv4: "0.0.0.0/0" }, [], {}),
      sgRule("aws_vpc_security_group_egress_rule.alb_to_tasks", "aws_security_group.alb", {}, ["referenced_security_group_id"], { referenced_security_group_id: ref("aws_security_group.tasks", "id") }),
      {
        address: "aws_lb.web",
        values: tagged(c, { name: `alb-${c.prefix}`, internal: false, load_balancer_type: "application", enable_deletion_protection: false, tags: { Name: "alb-web" } }),
        unknown: ["security_groups", "subnets"],
        refs: { name: ["var.name_prefix"], security_groups: ref("aws_security_group.alb", "id"), subnets: ["aws_subnet.public"] },
      },
      {
        address: "aws_lb_target_group.web",
        values: tagged(c, {
          name: `tg-${c.prefix}`, port: 80, protocol: "HTTP", target_type: "ip", deregistration_delay: "30",
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
      // ecs.tf
      {
        address: "aws_ecr_repository.web",
        values: tagged(c, { name: `lab-${id}-web`, image_tag_mutability: "MUTABLE", force_delete: true, image_scanning_configuration: [{ scan_on_push: true }], tags: { Name: "ecr-web" } }),
        refs: { name: ["var.lab_id"] },
      },
      { address: "time_sleep.ecr_tags", values: { create_duration: "20s" }, refs: {} },
      {
        address: "aws_ecr_lifecycle_policy.web",
        values: {
          repository: `lab-${id}-web`,
          policy: JSON.stringify({ rules: [{ action: { type: "expire" }, description: "keep the five newest images", rulePriority: 1, selection: { countNumber: 5, countType: "imageCountMoreThan", tagStatus: "any" } }] }),
        },
        refs: { repository: ref("aws_ecr_repository.web", "name") },
      },
      {
        address: "aws_ecs_cluster.lab",
        values: tagged(c, { name: `lab-${id}`, setting: [{ name: "containerInsights", value: "enabled" }], tags: { Name: "ecs-lab" } }),
        refs: { name: ["var.lab_id"] },
      },
      { address: "aws_cloudwatch_log_group.web", values: tagged(c, { name: group, retention_in_days: 1 }), refs: { name: ["local.log_group"] } },
      {
        address: "aws_iam_role.exec",
        values: tagged(c, {
          name: `lab-${id}-exec`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY,
          assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" }, Action: "sts:AssumeRole" }] }),
        }),
        refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"] },
      },
      {
        address: "aws_iam_role_policy_attachment.exec",
        values: { role: `lab-${id}-exec`, policy_arn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy" },
        refs: { role: ref("aws_iam_role.exec", "name") },
      },
      {
        address: "aws_ecs_task_definition.web",
        values: tagged(c, {
          family: `lab-${id}-web`, requires_compatibilities: ["FARGATE"], network_mode: "awsvpc", cpu: "256", memory: "512",
          runtime_platform: [{ operating_system_family: "LINUX", cpu_architecture: "ARM64" }],
          container_definitions: containers,
          tags: { Name: "td-web" },
        }),
        unknown: ["execution_role_arn"],
        refs: { family: ["var.lab_id"], execution_role_arn: ref("aws_iam_role.exec", "arn"), container_definitions: ["local.log_group", "var.region"] },
      },
      { address: "aws_security_group.tasks", values: tagged(c, { name: "lab-tasks", description: "The service tasks: HTTP from the load balancer, out through the NAT gateway", tags: { Name: "sg-tasks" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC, "id") } },
      sgRule("aws_vpc_security_group_ingress_rule.tasks_http_alb", "aws_security_group.tasks", {}, ["referenced_security_group_id"], { referenced_security_group_id: ref("aws_security_group.alb", "id") }),
      { address: "aws_vpc_security_group_egress_rule.tasks_all", values: tagged(c, { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.tasks", "id") } },
      {
        address: "aws_ecs_service.web",
        values: tagged(c, {
          name: `lab-${id}-web`, desired_count: 2, launch_type: "FARGATE", propagate_tags: "SERVICE", enable_ecs_managed_tags: true, health_check_grace_period_seconds: 30,
          network_configuration: [{ assign_public_ip: false }],
          load_balancer: [{ container_name: "web", container_port: 80 }],
          tags: { Name: "svc-web" },
        }),
        unknown: ["cluster", "task_definition", "network_configuration.0.subnets", "network_configuration.0.security_groups", "load_balancer.0.target_group_arn"],
        refs: {
          name: ["var.lab_id"],
          cluster: ref("aws_ecs_cluster.lab", "id"),
          task_definition: ref("aws_ecs_task_definition.web", "arn"),
          // A splat (aws_subnet.private[*].id) is listed as the resource alone.
          "network_configuration.0.subnets": ["aws_subnet.private"],
          "network_configuration.0.security_groups": ref("aws_security_group.tasks", "id"),
          "load_balancer.0.target_group_arn": ref("aws_lb_target_group.web", "arn"),
        },
      },
    ],
  };
};
