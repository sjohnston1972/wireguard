// scripts/test/fixtures/labs/plans/labs/soa-05-rds.mjs
//
// Plain English: lab soa-05's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then database.tf (the db security group and its two rules, subnet
// group, parameter group, the Multi-AZ primary and the read replica) and
// client.tf (vm-client). Identifiers built from var.name_prefix are known at
// plan; ids, ARNs and anything built from them are unknown. The password is
// the session's (sensitive).

import { AWS_PROVIDER_CONFIG, GATEWAY_CIDR, al2023Instance, awsData, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("soa-05-rds", "05");
  const id = c.id;
  const primaryId = `db-${c.prefix}`;
  const param = (name, value) => ({ name, value });
  // Its cloud-init writes ~/.my.cnf with the databases' addresses, known only after apply: user_data is unknown.
  const instance = al2023Instance(c, { key: "client", name: "vm-client", type: "t4g.nano", userDataUnknown: true });
  instance.refs.user_data = ["local.cloud_init_base", "local.my_cnf"];
  const shared = {
    instance_class: "db.t4g.micro", storage_type: "gp2", publicly_accessible: false, skip_final_snapshot: true, deletion_protection: false,
    delete_automated_backups: true, copy_tags_to_snapshot: true, performance_insights_enabled: false, auto_minor_version_upgrade: true, apply_immediately: true,
  };
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: awsData(),
    resources: [
      ...templateResources(c),
      // database.tf
      { address: "aws_security_group.db", values: tagged(c, { name: "lab-db", description: "MySQL from the lab instances and, when peered, the gateway", tags: { Name: "sg-db" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      {
        address: "aws_vpc_security_group_ingress_rule.db_from_vms",
        values: tagged(c, { ip_protocol: "tcp", from_port: 3306, to_port: 3306 }),
        unknown: ["security_group_id", "referenced_security_group_id"],
        refs: { security_group_id: ref("aws_security_group.db", "id"), referenced_security_group_id: ref("aws_security_group.vms", "id") },
      },
      {
        address: "aws_vpc_security_group_ingress_rule.db_from_gateway",
        values: tagged(c, { cidr_ipv4: GATEWAY_CIDR, ip_protocol: "tcp", from_port: 3306, to_port: 3306 }),
        unknown: ["security_group_id"],
        refs: { security_group_id: ref("aws_security_group.db", "id"), cidr_ipv4: ["var.gateway_cidr"] },
      },
      {
        address: "aws_db_subnet_group.db",
        values: tagged(c, { name: `lab-${id}-db`, tags: { Name: "lab-db" } }),
        unknown: ["subnet_ids"],
        refs: { name: ["var.lab_id"], subnet_ids: ["aws_subnet.private"] },
      },
      {
        address: "aws_db_parameter_group.mysql",
        values: tagged(c, { name: `lab-${id}-mysql84`, family: "mysql8.4", parameter: [param("slow_query_log", "1"), param("long_query_time", "1"), param("log_output", "FILE")], tags: { Name: "lab-mysql84" } }),
        refs: { name: ["var.lab_id"] },
      },
      {
        address: "aws_db_instance.primary",
        values: tagged(c, {
          ...shared, identifier: primaryId, engine: "mysql", engine_version: "8.4", allocated_storage: 20, storage_encrypted: true, multi_az: true,
          db_name: "labdb", username: "labadmin", password: "(the session's admin password)", backup_retention_period: 1, tags: { Name: "db-primary" },
          // Both groups' names are set literally in their own blocks: known at plan (the real plan, 2026-10-15).
          db_subnet_group_name: `lab-${id}-db`, parameter_group_name: `lab-${id}-mysql84`,
        }),
        unknown: ["vpc_security_group_ids"],
        refs: {
          identifier: ["var.name_prefix"], password: ["var.admin_password"], db_subnet_group_name: ref("aws_db_subnet_group.db", "name"),
          vpc_security_group_ids: ref("aws_security_group.db", "id"), parameter_group_name: ref("aws_db_parameter_group.mysql", "name"),
        },
      },
      {
        address: "aws_db_instance.replica",
        values: tagged(c, { ...shared, identifier: `${primaryId}-replica`, replicate_source_db: primaryId, multi_az: false, backup_retention_period: 0, parameter_group_name: `lab-${id}-mysql84`, tags: { Name: "db-replica" } }),
        unknown: ["vpc_security_group_ids"],
        refs: {
          identifier: ["var.name_prefix"], replicate_source_db: ref("aws_db_instance.primary", "identifier"),
          vpc_security_group_ids: ref("aws_security_group.db", "id"), parameter_group_name: ref("aws_db_parameter_group.mysql", "name"),
        },
      },
      // client.tf
      instance,
    ],
  };
};
