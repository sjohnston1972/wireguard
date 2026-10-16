// scripts/test/fixtures/labs/plans/labs/saa-19-eks.mjs
//
// Plain English: lab saa-19's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then public.tf (as soa-03's), nat.tf (as soa-10's: the Elastic IP,
// the NAT gateway and the private default route) and eks.tf: the cluster role
// with AmazonEKSClusterPolicy and the lab's deny-load-balancers policy, the
// node role with its three AWS managed policies (one attachment each,
// pre-flight C3), the cluster, the node launch template and the managed node
// group. Names built from var.lab_id and var.name_prefix are known at plan, as
// are the cluster's access_config, upgrade_policy and endpoint flags, the
// launch template's tag specifications and the node group's cluster_name
// (lab-saa-19-eks: the cluster's name is known from local.cluster_name). Role
// ARNs, subnet ids and the launch template's id and latest version are not
// known, so they carry references.

import { AWS_PROVIDER_CONFIG, BOUNDARY, awsData, cidrsubnet, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("saa-19-eks", "19");
  const id = c.id;
  const VPC = "aws_vpc.lab";
  const cluster = `lab-${id}`;
  const policyDoc = (statements) => JSON.stringify({ Version: "2012-10-17", Statement: statements });
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
  const role = (key, service, action) => ({
    address: `aws_iam_role.${key}`,
    values: tagged(c, {
      name: `lab-${id}-${key}`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY,
      assume_role_policy: policyDoc([{ Effect: "Allow", Principal: { Service: service }, Action: action }]),
    }),
    refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"] },
  });
  const managed = (key, roleKey, policy) => ({
    address: `aws_iam_role_policy_attachment.${key}`,
    values: { role: `lab-${id}-${roleKey}`, policy_arn: `arn:aws:iam::aws:policy/${policy}` },
    refs: { role: ref(`aws_iam_role.${roleKey}`, "name") },
  });
  const spec = (type) => ({ resource_type: type, tags: { ...c.tags, Name: "node-eks" } });
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
      // eks.tf: the cluster role, AmazonEKSClusterPolicy and the lab's deny on load balancers (ruling P8)
      role("cluster", "eks.amazonaws.com", ["sts:AssumeRole", "sts:TagSession"]),
      managed("cluster", "cluster", "AmazonEKSClusterPolicy"),
      {
        address: "aws_iam_policy.no_load_balancers",
        values: tagged(c, {
          name: `lab-${id}-no-lb`, path: "/cloudlabs-lab/",
          policy: policyDoc([{ Sid: "NoLoadBalancerServices", Effect: "Deny", Action: ["elasticloadbalancing:CreateLoadBalancer", "ec2:CreateSecurityGroup"], Resource: "*" }]),
        }),
        refs: { name: ["var.lab_id"] },
      },
      {
        address: "aws_iam_role_policy_attachment.cluster_no_lb",
        values: { role: `lab-${id}-cluster` },
        unknown: ["policy_arn"],
        refs: { role: ref("aws_iam_role.cluster", "name"), policy_arn: ref("aws_iam_policy.no_load_balancers", "arn") },
      },
      // the node role and its three AWS managed policies (pre-flight C3)
      role("node", "ec2.amazonaws.com", "sts:AssumeRole"),
      managed("node_worker", "node", "AmazonEKSWorkerNodePolicy"),
      managed("node_cni", "node", "AmazonEKS_CNI_Policy"),
      managed("node_ecr", "node", "AmazonEC2ContainerRegistryReadOnly"),
      {
        address: "aws_eks_cluster.lab",
        values: tagged(c, {
          name: cluster, bootstrap_self_managed_addons: true,
          vpc_config: [{ endpoint_private_access: true, endpoint_public_access: true }],
          access_config: [{ authentication_mode: "API", bootstrap_cluster_creator_admin_permissions: false }],
          upgrade_policy: [{ support_type: "STANDARD" }],
          tags: { Name: "eks-lab" },
        }),
        unknown: ["role_arn", "vpc_config.0.subnet_ids"],
        refs: {
          name: ["local.cluster_name"],
          role_arn: ref("aws_iam_role.cluster", "arn"),
          // A splat (aws_subnet.private[*].id) is listed as the resource alone.
          "vpc_config.0.subnet_ids": ["aws_subnet.private"],
        },
      },
      {
        address: "aws_launch_template.node",
        values: tagged(c, {
          name: `lt-${c.prefix}`, update_default_version: true,
          metadata_options: [{ http_tokens: "required", http_endpoint: "enabled", http_put_response_hop_limit: 2 }],
          block_device_mappings: [{ device_name: "/dev/xvda", ebs: [{ volume_size: 20, volume_type: "gp3", delete_on_termination: "true" }] }],
          tag_specifications: [spec("instance"), spec("volume"), spec("network-interface")],
          tags: { Name: "lt-node" },
        }),
        refs: {
          name: ["var.name_prefix"],
          "tag_specifications.0.tags": ["var.tags"],
          "tag_specifications.1.tags": ["var.tags"],
          "tag_specifications.2.tags": ["var.tags"],
        },
      },
      {
        address: "aws_eks_node_group.lab",
        values: tagged(c, {
          cluster_name: cluster, node_group_name: `lab-${id}-ng`, ami_type: "AL2023_ARM_64_STANDARD", instance_types: ["t4g.medium"], capacity_type: "ON_DEMAND",
          scaling_config: [{ desired_size: 1, min_size: 1, max_size: 2 }],
          update_config: [{ max_unavailable: 1 }],
          launch_template: [{}],
          tags: { Name: "ng-lab" },
        }),
        unknown: ["node_role_arn", "subnet_ids", "launch_template.0.id", "launch_template.0.version"],
        refs: {
          cluster_name: ref("aws_eks_cluster.lab", "name"),
          node_group_name: ["var.lab_id"],
          node_role_arn: ref("aws_iam_role.node", "arn"),
          subnet_ids: ["aws_subnet.private"],
          "launch_template.0.id": ref("aws_launch_template.node", "id"),
          "launch_template.0.version": ref("aws_launch_template.node", "latest_version"),
        },
      },
    ],
  };
};
