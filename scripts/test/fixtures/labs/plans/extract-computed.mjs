// scripts/test/fixtures/labs/plans/extract-computed.mjs
//
// Plain English: makes computed.json, the part of the azurerm, azuread and
// aws provider schemas the realistic plan fixtures need: for every resource type
// the labs (and the scope fixtures) use, which attributes the provider
// computes. Terraform cannot plan a lab offline (it needs Azure), so the
// fixtures are written by hand, and this keeps their "known after apply"
// parts (after_unknown) true to the real providers: an attribute the
// provider computes and the configuration leaves unset is unknown at plan,
// exactly as `terraform show -json` prints it (azuread_group.mail_nickname,
// azurerm_management_group.subscription_ids, ...). It also lists which
// attributes the schema calls sensitive: Terraform marks each of those in
// after_sensitive whether it is set or not (batch 3's real plans).
//
// Regenerate after a provider upgrade (no cloud calls; terraform init only
// downloads the providers). Pin the versions the labs' lock files hold
// (batch 3: azurerm 4.81.0, azuread 3.10.0, and what "~> 0.13" and "~> 3.7"
// resolve to for time and random, 0.14.2 and 3.9.1 on 2026-10-05; AWS labs
// batch 1: what "~> 6.0", "~> 4.0" and "~> 2.0" resolved to for aws, tls and
// archive on 2026-10-15, 6.69.0, 4.4.1 and 2.8.1), in a scratch folder:
//
//   mkdir /tmp/s && cd /tmp/s && printf '%s\n' 'terraform {' ' required_providers {' \
//     '  azurerm = { source = "hashicorp/azurerm", version = "4.81.0" }' \
//     '  azuread = { source = "hashicorp/azuread", version = "3.10.0" }' \
//     '  time    = { source = "hashicorp/time", version = "0.14.2" }' \
//     '  random  = { source = "hashicorp/random", version = "3.9.1" }' \
//     '  aws     = { source = "hashicorp/aws", version = "6.69.0" }' \
//     '  tls     = { source = "hashicorp/tls", version = "4.4.1" }' \
//     '  archive = { source = "hashicorp/archive", version = "2.8.1" }' ' }' '}' > versions.tf
//   terraform init -backend=false && terraform providers schema -json > schema.json
//   node scripts/test/fixtures/labs/plans/extract-computed.mjs /tmp/s/schema.json
//
// It also writes schema-facts.json: for each resource type, whether it takes
// resource_group_name and tags as arguments ({ rg, tags }), which the content
// suite's test 3 reads instead of a hand-kept list.
//
// A type missing here throws in realisticPlan. Content areas never edit this
// file, computed.json or schema-facts.json: they ask the integrator, who adds
// the type and regenerates them.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TYPES = [
  // the labs (batch 1)
  "azuread_group", "azuread_user", "azurerm_consumption_budget_resource_group", "azurerm_linux_virtual_machine",
  "azurerm_management_group", "azurerm_management_group_policy_assignment", "azurerm_management_lock", "azurerm_monitor_action_group",
  "azurerm_network_interface", "azurerm_network_security_group", "azurerm_policy_definition", "azurerm_private_dns_zone",
  "azurerm_private_dns_zone_virtual_network_link", "azurerm_private_endpoint", "azurerm_resource_group",
  "azurerm_resource_group_policy_assignment", "azurerm_role_assignment", "azurerm_role_definition", "azurerm_storage_account",
  "azurerm_storage_blob", "azurerm_storage_container", "azurerm_storage_management_policy", "azurerm_storage_share",
  "azurerm_subnet", "azurerm_virtual_network",
  // batch 2 (labs 8-19): compute
  "azurerm_linux_virtual_machine_scale_set", "azurerm_monitor_autoscale_setting", "azurerm_service_plan", "azurerm_linux_web_app",
  "azurerm_linux_web_app_slot", "azurerm_container_group", "azurerm_container_app", "azurerm_container_app_environment",
  "azurerm_container_registry", "azurerm_virtual_machine_extension", "azurerm_managed_disk", "azurerm_virtual_machine_data_disk_attachment",
  "azurerm_resource_group_template_deployment",
  // batch 2: networking
  "azurerm_application_security_group", "azurerm_network_interface_application_security_group_association", "azurerm_network_security_rule",
  "azurerm_network_interface_security_group_association", "azurerm_subnet_network_security_group_association", "azurerm_route_table",
  "azurerm_route", "azurerm_subnet_route_table_association", "azurerm_virtual_network_peering", "azurerm_dns_zone", "azurerm_dns_a_record",
  "azurerm_dns_cname_record", "azurerm_private_dns_a_record", "azurerm_public_ip", "azurerm_lb", "azurerm_lb_backend_address_pool",
  "azurerm_lb_probe", "azurerm_lb_rule", "azurerm_network_interface_backend_address_pool_association", "azurerm_application_gateway",
  // batch 2: monitor and backup
  "azurerm_log_analytics_workspace", "azurerm_monitor_data_collection_rule", "azurerm_monitor_data_collection_rule_association",
  "azurerm_monitor_metric_alert", "azurerm_monitor_activity_log_alert", "azurerm_recovery_services_vault", "azurerm_backup_policy_vm",
  "azurerm_backup_protected_vm",
  // batch 3 (labs 20-27): identity and governance
  "azurerm_key_vault", "azurerm_key_vault_secret", "azurerm_user_assigned_identity", "azurerm_policy_set_definition",
  "azurerm_management_group_policy_set_definition",
  // batch 3: data
  "azurerm_mssql_server", "azurerm_mssql_database", "azurerm_mssql_failover_group", "azurerm_cosmosdb_account", "azurerm_cosmosdb_sql_database",
  "azurerm_cosmosdb_sql_container", "azurerm_storage_container_immutability_policy",
  // batch 3: continuity and multi-region
  "azurerm_site_recovery_fabric", "azurerm_site_recovery_protection_container", "azurerm_site_recovery_replication_policy",
  "azurerm_site_recovery_protection_container_mapping", "azurerm_site_recovery_network_mapping", "azurerm_site_recovery_replicated_vm",
  "azurerm_traffic_manager_profile", "azurerm_traffic_manager_external_endpoint", "azurerm_cdn_frontdoor_profile", "azurerm_cdn_frontdoor_endpoint",
  "azurerm_cdn_frontdoor_origin_group", "azurerm_cdn_frontdoor_origin", "azurerm_cdn_frontdoor_route",
  // batch 3: hashicorp/time and hashicorp/random
  "time_sleep", "random_password",
  // AZ-700 (labs 31-44, AZ-700 plan Z0.4): core networking and routing
  "azurerm_public_ip_prefix", "azurerm_nat_gateway", "azurerm_nat_gateway_public_ip_prefix_association", "azurerm_nat_gateway_public_ip_association",
  "azurerm_subnet_nat_gateway_association", "azurerm_lb_outbound_rule", "azurerm_lb_nat_rule", "azurerm_lb_backend_address_pool_address",
  "azurerm_private_dns_resolver", "azurerm_private_dns_resolver_inbound_endpoint", "azurerm_private_dns_resolver_outbound_endpoint",
  "azurerm_private_dns_resolver_dns_forwarding_ruleset", "azurerm_private_dns_resolver_forwarding_rule", "azurerm_private_dns_resolver_virtual_network_link",
  "azurerm_network_manager", "azurerm_network_manager_network_group", "azurerm_network_manager_static_member",
  "azurerm_network_manager_connectivity_configuration", "azurerm_network_manager_security_admin_configuration",
  "azurerm_network_manager_admin_rule_collection", "azurerm_network_manager_admin_rule", "azurerm_network_manager_deployment",
  "azurerm_route_server", "azurerm_route_server_bgp_connection",
  // AZ-700: hybrid connectivity and hubs
  "azurerm_firewall", "azurerm_firewall_policy", "azurerm_firewall_policy_rule_collection_group", "azurerm_virtual_network_gateway",
  "azurerm_local_network_gateway", "azurerm_virtual_network_gateway_connection", "azurerm_virtual_wan", "azurerm_virtual_hub",
  "azurerm_virtual_hub_connection", "azurerm_virtual_hub_routing_intent",
  // AZ-700: delivery, private access and monitoring
  "azurerm_web_application_firewall_policy", "azurerm_key_vault_certificate", "azurerm_key_vault_access_policy", "azurerm_cdn_frontdoor_firewall_policy",
  "azurerm_cdn_frontdoor_security_policy", "azurerm_cdn_frontdoor_rule_set", "azurerm_cdn_frontdoor_rule", "azurerm_private_link_service",
  "azurerm_subnet_service_endpoint_storage_policy", "azurerm_network_watcher_flow_log", "azurerm_bastion_host", "azurerm_monitor_diagnostic_setting",
  // AZ-700: what the scope tests plan in order to refuse (S1's other AVNM types, the never rule's types, a second watcher, a policy assignment)
  "azurerm_network_manager_scope_connection", "azurerm_network_manager_subscription_connection", "azurerm_network_manager_management_group_connection",
  "azurerm_network_manager_routing_configuration", "azurerm_network_manager_routing_rule_collection", "azurerm_network_ddos_protection_plan",
  "azurerm_express_route_circuit", "azurerm_express_route_port", "azurerm_express_route_gateway", "azurerm_custom_ip_prefix", "azurerm_network_watcher",
  "azurerm_resource_group_policy_assignment",
  // AZ-305 batch 4: lab 29's AKS cluster
  "azurerm_kubernetes_cluster",
  // AZ-305 batch 4, lab 30 (messaging and events): Service Bus, Event Grid, a Container Apps job
  "azurerm_servicebus_namespace", "azurerm_servicebus_namespace_authorization_rule", "azurerm_servicebus_queue", "azurerm_servicebus_topic",
  "azurerm_servicebus_subscription", "azurerm_servicebus_subscription_rule", "azurerm_eventgrid_system_topic",
  "azurerm_eventgrid_system_topic_event_subscription", "azurerm_container_app_job",
  // AWS labs batch 1 (AWS labs spec §7.3): every type on lab-scope-aws.mjs's AWS_TYPES
  "aws_resourcegroups_group", "aws_vpc", "aws_subnet", "aws_route_table", "aws_route_table_association", "aws_route", "aws_internet_gateway",
  "aws_security_group", "aws_vpc_security_group_ingress_rule", "aws_vpc_security_group_egress_rule", "aws_vpc_endpoint",
  "aws_ec2_instance_connect_endpoint", "aws_instance", "aws_launch_template", "aws_ebs_volume", "aws_volume_attachment", "aws_ebs_snapshot",
  "aws_autoscaling_group", "aws_autoscaling_policy", "aws_autoscaling_schedule", "aws_autoscaling_lifecycle_hook", "aws_lb", "aws_lb_target_group",
  "aws_lb_listener", "aws_iam_role", "aws_iam_instance_profile", "aws_iam_policy", "aws_iam_role_policy_attachment", "aws_cloudwatch_log_group",
  "aws_cloudwatch_log_metric_filter", "aws_cloudwatch_metric_alarm", "aws_cloudwatch_dashboard", "aws_cloudwatch_query_definition",
  "aws_cloudwatch_event_rule", "aws_cloudwatch_event_target", "aws_sns_topic", "aws_sns_topic_policy", "aws_ssm_patch_baseline", "aws_ssm_patch_group",
  "aws_ssm_association", "aws_config_configuration_recorder", "aws_config_delivery_channel", "aws_config_configuration_recorder_status",
  "aws_config_config_rule", "aws_config_remediation_configuration", "aws_s3_bucket", "aws_s3_bucket_versioning", "aws_s3_bucket_lifecycle_configuration",
  "aws_s3_bucket_replication_configuration", "aws_s3_bucket_public_access_block", "aws_s3_bucket_policy", "aws_s3_object", "aws_backup_vault",
  "aws_backup_plan", "aws_backup_selection", "aws_db_instance", "aws_db_subnet_group", "aws_db_parameter_group",
  // AWS labs batch 1: the engine's other types (peering, public addresses, NAT, IAM users)
  "aws_vpc_peering_connection", "aws_eip", "aws_nat_gateway", "aws_iam_user",
  // AWS labs batch 1: what the AWS scope tests plan in order to refuse
  "aws_lambda_function", "aws_dx_gateway", "aws_iam_access_key", "aws_vpc_peering_connection_accepter",
  // AWS labs batch 3 fix round 1 (review M-6): a type no lab will ever be allowed (Lightsail lives outside the lab's VPC)
  "aws_lightsail_instance",
  // AWS labs batch 1, ruling A48: the untagged VPC defaults and aws_ec2_tag the scope check refuses
  "aws_default_security_group", "aws_default_network_acl", "aws_default_route_table", "aws_ec2_tag",
  // AWS labs batch 2
  "aws_cloudformation_stack", "aws_cloudformation_stack_set", "aws_iam_user_login_profile", "aws_iam_user_policy_attachment", "aws_kms_key",
  "aws_kms_alias", "aws_secretsmanager_secret", "aws_secretsmanager_secret_version", "aws_secretsmanager_secret_rotation", "aws_lambda_permission",
  "aws_accessanalyzer_analyzer", "aws_network_acl", "aws_network_acl_rule", "aws_network_acl_association", "aws_flow_log", "aws_route53_zone",
  "aws_route53_record", "aws_route53_health_check", "aws_cloudfront_distribution", "aws_cloudfront_origin_access_control", "aws_ecr_repository",
  "aws_ecr_lifecycle_policy", "aws_ecs_cluster", "aws_ecs_task_definition", "aws_ecs_service", "aws_sqs_queue_policy", "aws_eks_cluster",
  "aws_wafv2_web_acl",
  // AWS labs batch 3 (labs 11-19; aws_eks_cluster and aws_lambda_permission are listed above)
  "aws_elasticache_subnet_group", "aws_elasticache_replication_group", "aws_apigatewayv2_api", "aws_apigatewayv2_authorizer",
  "aws_apigatewayv2_integration", "aws_apigatewayv2_route", "aws_apigatewayv2_stage", "aws_cognito_user_pool", "aws_cognito_user_pool_client",
  "aws_cognito_user", "aws_dynamodb_table", "aws_sqs_queue", "aws_sns_topic_subscription", "aws_cloudwatch_event_bus", "aws_sfn_state_machine",
  "aws_efs_file_system", "aws_efs_mount_target", "aws_s3_bucket_intelligent_tiering_configuration",
  "aws_s3_bucket_server_side_encryption_configuration", "aws_vpc_endpoint_policy", "aws_ami_copy", "aws_kinesis_stream",
  "aws_kinesis_firehose_delivery_stream", "aws_glue_catalog_database", "aws_glue_crawler", "aws_athena_workgroup", "aws_eks_node_group",
  // AWS labs batch 1: the data sources on AWS_DATA (realisticPlan needs every aws_ one), and the one the scope tests refuse
  "data.aws_ssm_parameter", "data.aws_ami", "data.aws_availability_zones", "data.aws_caller_identity", "data.aws_region", "data.aws_partition",
  "data.aws_iam_policy_document", "data.aws_ec2_managed_prefix_list", "data.archive_file", "data.aws_vpc",
  // data sources
  "data.azurerm_subscription", "data.azurerm_client_config", "data.azurerm_resource_group",
  // AZ-700: what the S1 and S2 scope tests read to show a VNet outside the lab is refused
  "data.azurerm_virtual_network",
];

/** { rg, tags }: whether a resource type takes resource_group_name and tags as arguments (the content suite's test 3). */
function facts(block) {
  const arg = (k) => Boolean(block.attributes?.[k] && (block.attributes[k].required || block.attributes[k].optional));
  return { rg: arg("resource_group_name"), tags: arg("tags") };
}

/**
 * { attrs: [computed attribute names], blocks: { name: tree }, sensitive?: [sensitive attribute names] } for one
 * schema block. Terraform marks a sensitive attribute in after_sensitive whether it is set or not (lab 23's real
 * plan: administrator_login_password_wo, never set), so realisticPlan marks every one.
 */
function tree(block) {
  const attrs = Object.entries(block.attributes ?? {}).filter(([, a]) => a.computed).map(([k]) => k).sort();
  const sensitive = Object.entries(block.attributes ?? {}).filter(([, a]) => a.sensitive).map(([k]) => k).sort();
  const blocks = {};
  for (const [k, b] of Object.entries(block.block_types ?? {})) {
    const t = tree(b.block);
    if (t.attrs.length || t.sensitive?.length || Object.keys(t.blocks).length) blocks[k] = t;
  }
  return { attrs, blocks, ...(sensitive.length ? { sensitive } : {}) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const schema = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const out = { providers: {}, types: {} };
  const schemaFacts = {};
  for (const [name, p] of Object.entries(schema.provider_schemas)) {
    out.providers[name] = true;
    for (const t of TYPES) {
      const data = t.startsWith("data.");
      const s = (data ? p.data_source_schemas : p.resource_schemas)?.[data ? t.slice(5) : t];
      if (s) out.types[t] = tree(s.block);
      if (s && !data) schemaFacts[t] = facts(s.block);
    }
  }
  const missing = TYPES.filter((t) => !out.types[t]);
  if (missing.length) throw new Error(`not in the schema: ${missing.join(", ")}`);
  const sorted = Object.fromEntries(Object.keys(schemaFacts).sort().map((t) => [t, schemaFacts[t]]));
  writeFileSync(new URL("./computed.json", import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
  writeFileSync(new URL("./schema-facts.json", import.meta.url), `${JSON.stringify(sorted, null, 1)}\n`);
  console.log(`computed.json: ${Object.keys(out.types).length} types from ${Object.keys(out.providers).join(", ")}; schema-facts.json: ${Object.keys(sorted).length} resource types`);
}
