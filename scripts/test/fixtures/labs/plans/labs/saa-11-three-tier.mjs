// scripts/test/fixtures/labs/plans/labs/saa-11-three-tier.mjs
//
// Plain English: lab saa-11's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then public.tf, alb.tf and nat.tf (as soa-03's and soa-10's), app.tf
// (the launch template and the Auto Scaling group of 2) and data.tf (two data
// subnets with a route table that has no way out, the database and cache
// security groups and their rules, both subnet groups, the Multi-AZ MySQL
// database and the one-node Valkey replication group). Names built from
// var.lab_id and var.name_prefix are known at plan; ids and ARNs are unknown.
// The launch template's user_data names the database and cache addresses, so
// it is unknown (and sensitive: it holds the password). The replication
// group's at_rest_encryption_enabled is the string "true" (a nullable bool in
// aws 6.69).

import { AWS_PROVIDER_CONFIG, GATEWAY_CIDR, awsData, cidrsubnet, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("saa-11-three-tier", "11");
  const id = c.id;
  const VPC = "aws_vpc.lab";
  const asg = `asg-${c.prefix}`;
  const sgRule = (address, sg, extra, unknown, refs, port = 80) => ({ address, values: tagged(c, { ip_protocol: "tcp", from_port: port, to_port: port, ...extra }), unknown: ["security_group_id", ...unknown], refs: { security_group_id: ref(sg, "id"), ...refs } });
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
  const dataSubnet = (i) => ({
    address: `aws_subnet.data[${i}]`,
    count: 2,
    values: tagged(c, { cidr_block: cidrsubnet(c.vpcCidr, 4, 2 + i), availability_zone: `eu-west-2${"ab"[i]}`, map_public_ip_on_launch: false, tags: { Name: `snet-data-${i + 1}` } }),
    unknown: ["vpc_id"],
    refs: { vpc_id: ref(VPC, "id"), cidr_block: ["local.vpc_cidr", "count.index"], availability_zone: ["local.azs", "count.index"], tags: ["count.index"] },
  });
  const dataAssoc = (i) => ({
    address: `aws_route_table_association.data[${i}]`,
    count: 2,
    values: {},
    unknown: ["subnet_id", "route_table_id"],
    refs: { subnet_id: ["aws_subnet.data", "count.index"], route_table_id: ref("aws_route_table.data", "id") },
  });
  const spec = (type) => ({ resource_type: type, tags: { ...c.tags, Name: "vm-app" } });
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
      // data.tf
      dataSubnet(0),
      dataSubnet(1),
      { address: "aws_route_table.data", values: tagged(c, { tags: { Name: "rt-data" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC, "id") } },
      dataAssoc(0),
      dataAssoc(1),
      { address: "aws_security_group.db", values: tagged(c, { name: "lab-db", description: "MySQL from the app tier and, when peered, the gateway", tags: { Name: "sg-db" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC, "id") } },
      sgRule("aws_vpc_security_group_ingress_rule.db_from_app", "aws_security_group.db", {}, ["referenced_security_group_id"], { referenced_security_group_id: ref("aws_security_group.vms", "id") }, 3306),
      sgRule("aws_vpc_security_group_ingress_rule.db_from_gateway", "aws_security_group.db", { cidr_ipv4: GATEWAY_CIDR }, [], { cidr_ipv4: ["var.gateway_cidr"] }, 3306),
      { address: "aws_security_group.cache", values: tagged(c, { name: "lab-cache", description: "Valkey from the app tier and, when peered, the gateway", tags: { Name: "sg-cache" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC, "id") } },
      sgRule("aws_vpc_security_group_ingress_rule.cache_from_app", "aws_security_group.cache", {}, ["referenced_security_group_id"], { referenced_security_group_id: ref("aws_security_group.vms", "id") }, 6379),
      sgRule("aws_vpc_security_group_ingress_rule.cache_from_gateway", "aws_security_group.cache", { cidr_ipv4: GATEWAY_CIDR }, [], { cidr_ipv4: ["var.gateway_cidr"] }, 6379),
      {
        address: "aws_db_subnet_group.data",
        values: tagged(c, { name: `lab-${id}-data`, tags: { Name: "lab-data" } }),
        unknown: ["subnet_ids"],
        refs: { name: ["var.lab_id"], subnet_ids: ["aws_subnet.data"] },
      },
      {
        address: "aws_db_instance.app",
        values: tagged(c, {
          identifier: `db-${c.prefix}`, engine: "mysql", engine_version: "8.4", instance_class: "db.t4g.micro", allocated_storage: 20, storage_type: "gp2", storage_encrypted: true, multi_az: true,
          db_name: "appdb", username: "labadmin", password: "(the session's admin password)", publicly_accessible: false, backup_retention_period: 1,
          skip_final_snapshot: true, deletion_protection: false, delete_automated_backups: true, copy_tags_to_snapshot: true, performance_insights_enabled: false,
          auto_minor_version_upgrade: true, apply_immediately: true, tags: { Name: "db-app" },
          // The group's name is set literally in its own block: known at plan.
          db_subnet_group_name: `lab-${id}-data`,
        }),
        unknown: ["vpc_security_group_ids"],
        refs: { identifier: ["var.name_prefix"], password: ["var.admin_password"], db_subnet_group_name: ref("aws_db_subnet_group.data", "name"), vpc_security_group_ids: ref("aws_security_group.db", "id") },
      },
      {
        address: "aws_elasticache_subnet_group.data",
        values: tagged(c, { name: `lab-${id}-cache`, tags: { Name: "lab-cache-subnets" } }),
        unknown: ["subnet_ids"],
        refs: { name: ["var.lab_id"], subnet_ids: ["aws_subnet.data"] },
      },
      {
        address: "aws_elasticache_replication_group.app",
        values: tagged(c, {
          replication_group_id: `c${c.prefix}`, description: `lab ${id}: the app tier's cache`, engine: "valkey", engine_version: "8.0", node_type: "cache.t4g.micro", num_cache_clusters: 1, port: 6379,
          at_rest_encryption_enabled: "true", transit_encryption_enabled: false, automatic_failover_enabled: false, multi_az_enabled: false, snapshot_retention_limit: 0, apply_immediately: true,
          tags: { Name: "cache-app" },
          subnet_group_name: `lab-${id}-cache`,
        }),
        unknown: ["security_group_ids"],
        refs: { replication_group_id: ["var.name_prefix"], description: ["var.lab_id"], subnet_group_name: ref("aws_elasticache_subnet_group.data", "name"), security_group_ids: ref("aws_security_group.cache", "id") },
      },
      // app.tf
      {
        address: "aws_launch_template.app",
        values: tagged(c, {
          name: `lt-${c.prefix}`, image_id: "ami-0123456789abcdef0", instance_type: "t4g.micro", update_default_version: true,
          metadata_options: [{ http_tokens: "required", http_endpoint: "enabled" }],
          block_device_mappings: [{ device_name: "/dev/xvda", ebs: [{ volume_size: 8, volume_type: "gp3", delete_on_termination: "true" }] }],
          tag_specifications: [spec("instance"), spec("volume"), spec("network-interface")],
          tags: { Name: "lt-app" },
        }),
        // user_data names the database's and the cache's addresses, known only after apply.
        unknown: ["vpc_security_group_ids", "user_data"],
        sensitive: ["user_data"],
        refs: {
          name: ["var.name_prefix"],
          image_id: ["data.aws_ssm_parameter.al2023_arm64.insecure_value", "data.aws_ssm_parameter.al2023_arm64"],
          vpc_security_group_ids: ref("aws_security_group.vms", "id"),
          user_data: ["local.app_cloud_init", "local.app_page", "local.cloud_init_base", "aws_db_instance.app.address", "aws_db_instance.app", "aws_elasticache_replication_group.app.primary_endpoint_address", "aws_elasticache_replication_group.app"],
          "tag_specifications.0.tags": ["var.tags"],
          "tag_specifications.1.tags": ["var.tags"],
          "tag_specifications.2.tags": ["var.tags"],
        },
      },
      {
        address: "aws_autoscaling_group.web",
        values: {
          name: asg, min_size: 2, max_size: 4, desired_capacity: 2, health_check_type: "ELB", health_check_grace_period: 180, force_delete: true, wait_for_capacity_timeout: "10m",
          launch_template: [{}],
          tag: [{ key: "cloudlabs-lab", value: id, propagate_at_launch: true }, { key: "cloudlabs-session", value: c.tags["cloudlabs-session"], propagate_at_launch: true }, { key: "project", value: "cloudlabs", propagate_at_launch: true }, { key: "Name", value: "vm-app", propagate_at_launch: true }],
        },
        unknown: ["vpc_zone_identifier", "target_group_arns", "launch_template.0.id", "launch_template.0.version"],
        refs: {
          name: ["var.name_prefix"],
          // A splat (aws_subnet.private[*].id) is listed as the resource alone.
          vpc_zone_identifier: ["aws_subnet.private"],
          target_group_arns: ref("aws_lb_target_group.web", "arn"),
          "launch_template.0.id": ref("aws_launch_template.app", "id"),
          "launch_template.0.version": ref("aws_launch_template.app", "latest_version"),
          "tag.0.value": ["var.lab_id"],
          "tag.1.value": ['var.tags["cloudlabs-session"]', "var.tags"],
          "tag.2.value": ['var.tags["project"]', "var.tags"],
        },
      },
    ],
  };
};
