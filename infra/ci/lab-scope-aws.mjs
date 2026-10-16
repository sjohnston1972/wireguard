// infra/ci/lab-scope-aws.mjs
//
// Plain English: the border guard for AWS labs (AWS labs spec §7.3), the
// sister of lab-scope.mjs with the same command line and output. Before
// anything is built, lab-aws.yml shows it the lab's Terraform plan and it
// refuses the plan if any resource would land, or reach, outside the lab:
//
//   node infra/ci/lab-scope-aws.mjs --plan plan.json --lab <id>   (terraform show -json)
//   node infra/ci/lab-scope-aws.mjs --hcl  lab.json  --lab <id>   (hcl2json of the .tf files; CI's early warning)
//
// Exit 0: every resource stays inside the lab. Exit 1: one "rule: address
// (why)" line per refused resource. Exit 2: bad arguments (an Azure lab id
// too: this is the AWS check) or unreadable input.
//
// An AWS lab owns what is tagged cloudlabs-lab = <id>; IAM roles, instance
// profiles and policies at path /cloudlabs-lab/ named lab-<id>-*; and
// untaggable things named lab-<id>-* (ruling A4). The rules, in the order
// they are reported (one per resource, the first that applies):
//   provider     a provider (or a resource's) source not hashicorp's aws, random, time,
//                tls or archive; an aws provider with anything but region, alias and
//                default_tags (credentials, profiles, assume_role, endpoints); a region
//                other than var.region, var.secondary_region (alias "secondary", and in
//                a plan only when secondary_region is set and differs from region), or
//                us-east-1 / us-west-2 (AWS_GLOBAL_LABS only), the provider's or a
//                resource's own (aws provider 6's per-resource region); default_tags
//                other than tags = var.tags; (plan) a resource whose own region is a
//                global one but not on GLOBAL_REGION_TYPES (us-east-1: a WAF web ACL
//                for CloudFront; us-west-2: Global Accelerator; ruling P7); a secret's
//                replica or a multi-Region KMS key (copies outside the lab's regions);
//                (plan, batch 3) a DynamoDB replica anywhere but the session's secondary
//                region (P3), and an AMI copy's source region, a health check's alarm
//                region or a private zone's vpc_region that is not a lab region (P4, P6)
//   provisioner  any provisioner (it would run commands with the pipeline's keys)
//   import       adopting an object that already exists: a lab only ever creates
//   type         a resource type not on AWS_TYPES, a data source not on AWS_DATA or
//                breaking its condition (no lookups of VPCs, subnets, route tables,
//                security groups or instances), a Config recorder or delivery channel
//                outside AWS_CONFIG_LABS (one per region per account), a VPC's untagged
//                defaults or aws_ec2_tag (UNTAGGED_DEFAULT_TYPES, ruling A48); an Access
//                Analyzer analyzer outside ACCESS_ANALYZER_LABS or of a type other than
//                ACCOUNT (ruling P14)
//   never        what a lab only explains in its readme (NEVER_TYPES; dedicated or host
//                tenancy; StackSets and registered CloudFormation types)
//   template     a CloudFormation stack (ruling P4) from a template_url, not named
//                lab-<id>-*, with capabilities (or capabilities or parameters not known at
//                plan), without the lab's own service role by reference, with a
//                template_body not known at plan or not JSON, or whose
//                template (cfnTemplateProblems) makes a type off CFN_TYPES, has a
//                Transform, Fn::Transform or Fn::ImportValue, keeps anything after
//                tear-down, names its topics, queues or alarms, or puts a log group or
//                parameter outside /cloudlabs/<id>/, names an existing resource by id or
//                ARN, or gives an alarm an EC2 action; judged by its shape (re-review
//                N-1): no function but Ref and Fn::GetAtt, no {{resolve:...}}, String
//                or Number parameters only, every alarm action a Ref to the template's
//                own SNS topic, and every parameter value known at plan (and scanned)
//   tag          (plan) tags_all without cloudlabs-lab = <id>, or not known at plan;
//                an instance's volume_tags (ruling A49), a launch template's tag specifications, an Auto
//                Scaling group's propagated tag, ECS and RDS tag copying and Backup
//                recovery point tags without it; a DynamoDB replica without propagate_tags (P3)
//   untaggable   a type that cannot carry tags not named lab-<id>-* (UNTAGGABLE); a log
//                group outside /cloudlabs/<id>/ (A56); a DynamoDB table or an AMI copy not
//                named lab-<id>-*, a Glue database not named lab_<id with _> (batch 3:
//                the safety net also finds them by name; P3, P4, P15)
//   iam          roles, instance profiles and policies off /cloudlabs-lab/ or not named
//                lab-<id>-*; roles and users without the wg-admin-lab-boundary boundary;
//                IAM users outside AWS_IAM_USER_LABS; attachments of policies other than
//                MANAGED_POLICIES and the lab's own; policy documents with "*", iam: or
//                NotAction; trust policies naming anyone but AWS services and the lab's
//                own roles in the lab's own account (no wildcard; ruling A52); a
//                document not known at plan (ruling A42); a login profile for a user
//                not the lab's own or with password_reset_required (ruling P5); a Lambda
//                function or ECS task running as a role not the lab's own, by reference;
//                (batch 3, P14) the same for every role passed: a state machine's, an
//                EventBridge target's, a crawler's, an EKS cluster's and node group's, an
//                S3 replication's and a Firehose stream's; an EKS cluster other than
//                authentication_mode API without the creator's admin (P7); an API Gateway
//                integration's or authoriser's credentials role not the lab's own (review M-4)
//   gateway      the VPN server's names (vpc-wg, vm-wg, ...: GATEWAY_NAME_LIST), the wg-admin
//                key or value, a peering accepter, a peering not between the lab's own VPCs,
//                and (plan) an id of an existing AWS resource under an id-holding key, or an
//                instance target selecting every instance (a wildcard id, tag-key, a wildcard
//                tag value; ruling A50); an instance target off the allow-list (ruling P9:
//                InstanceIds or WindowTargetIds of the lab's own by reference, tag:cloudlabs-lab
//                = the lab id, another tag valued lab-<id>-*, resource-groups:Name = lab-<id>);
//                lab 09's public zone not named <name_prefix>.labs.clydeford.net (ruling A27)
//                or on a delegation set, and records, health checks and distributions that
//                name anything but the lab's own zone, distribution, bucket or load balancer
//                by reference (ruling P8); (plan) the lab's resource group other than
//                lab-<id> with one tag query known at plan selecting exactly
//                cloudlabs-lab = <id> (what resource-groups:Name selects); an alarm's EC2
//                action (stop, terminate, reboot, recover), or an action not known at plan
//                that is not the lab's own topic by reference; (plan) a written value not
//                known at plan and built from no reference where an id goes (an id key,
//                alarm dimensions, an SSM association's parameters, an EventBridge
//                target's input; re-review N-2); batch 3 (P4, P6, P12, P14, P18), each by
//                reference where it is not a known value: an EventBridge target that is not
//                the lab's own topic, queue, function, state machine, stream or log group;
//                a subscription other than sqs or lambda to the lab's own; a Step Functions
//                definition not known at plan or calling anything but lambda:invoke,
//                sns:publish and sqs:sendMessage on lab-<id>-* items (workflowProblem); a
//                Firehose source or destination off the lab's own stream and bucket; a crawler's targets off s3://cloudlabs-<name_prefix>- or its
//                database not lab_<id>; an Athena result location off the lab's bucket; a
//                private zone not *.internal or on a VPC not the lab's own; a CLOUDWATCH_METRIC
//                health check on an alarm not lab-<id>-*; an endpoint policy not on the
//                lab's own endpoint; an AMI copy not of the public SSM parameter's AMI; a
//                bucket key not the lab's own; an imported or quick-created HTTP API, an
//                integration other than AWS_PROXY to the lab's function, an authoriser
//                trusting another pool, and routes, stages, Cognito clients and users, EFS
//                mount targets and EKS pieces not on the lab's own API, pool, file system,
//                subnets or cluster; (Task 3 fix round 1) a workflow item in another account
//                or region, an SNS TargetArn or PhoneNumber, a target chosen at run time
//                (".$", JSONata) or Credentials; a Firehose backup, processor, format
//                conversion or other destination; a database, replica or cache not in the
//                lab's own subnet group (or from the lab's own source database): unset or
//                default is the default VPC; a block not known at plan (a dynamic block)
//                where elements are read (DynamoDB replicas, private zone VPCs, crawler
//                targets, EKS remote networks); data from outside the lab (a table's
//                import or restore, a cache's snapshot, a linked Glue database; review M-5)
//   address      (plan) a VPC, secondary CIDR or subnet outside the slot (var.address_space)
//                or overlapping another; a route other than the slot, var.gateway_cidr or
//                0.0.0.0/0 (::/0 for IPv6); an IPv6 IPAM pool outside ans-20-vpc-design
//   public       a public IPv4 on an instance, launch template or Elastic IP outside
//                PUBLIC_INSTANCE_LABS (spec §7.4); a subnet mapping public IPs; SSH (TCP
//                22) admitted from the internet; a resource policy (RESOURCE_POLICIES, and
//                a topic's, secret's or bucket's own policy) not known at plan or whose
//                Allow names everyone or another account; a Lambda permission for anything
//                but an AWS service known at plan, or a function URL with auth other than
//                AWS_IAM; ECS tasks with public IPs
//                (ruling P10); batch 3: a publicly accessible database (P16), a Lambda
//                permission whose source_arn is not the lab's own API, rule, topic, bucket
//                or secret by reference (P13), an endpoint policy not known at plan or
//                allowing more than the lab's buckets and Amazon Linux's repositories
//                (endpointPolicyProblem, P18), SSH to EKS nodes (remote_access, P7); a
//                queue's own policy, read like any resource policy (fix round 1, I-1)
//   lingering    a resource that would outlive tear-down: deletion protection, final
//                snapshots, retained buckets, keys, vaults, log groups and locks; an IAM
//                user without force_destroy (ruling P6); batch 3: an Athena workgroup
//                without force_destroy, a Kinesis stream without enforce_consumer_deletion,
//                an ElastiCache final snapshot, EKS control-plane logs or deletion
//                protection, Firehose error logging, Cognito deletion protection
//   size         instance types, database classes, disks, group sizes and counts above
//                the labs' caps (ECS tasks, Lambda memory and timeout, CloudFront's
//                price class, Route 53 health check extras); batch 3: a table not on
//                demand, an unthrottled API stage (20 burst, 10 a second), a PLUS Cognito
//                pool, a crawler schedule, an Athena workgroup without an enforced scan
//                cut-off of at most 1 GiB, more than 2 cache nodes or 1 node group,
//                provisioned EFS throughput, EKS extended support or Auto Mode, EKS node
//                types off AWS_INSTANCE_TYPES; a route's own throttle above the cap; an Auto
//                Scaling override by instance_requirements. Each value rule here also refuses
//                a value built from references and not known at plan (fix round 1, I-6)
//
// Every JSON document read from a string (policies, a group's query, a template) is refused when one object
// holds the same key twice (re-review N-3: which one AWS reads is not certain).
//
// In HCL mode the tag and address rules and the known-id part of gateway are left
// out (values are not known); the others read literal values where the HCL has them.
// A third mode, "mock" (labs-tf on terraform test's mocked plan, where the provider
// never computes tags_all and the stream has no provider configuration), is plan mode
// without the tag rule and without the provider configuration checks, and with an unknown policy_arn on an
// IAM policy attachment accepted when it has no references to read (no configuration in the stream).
//
// It is plain Node with no packages (the runner has Node; npm ci is not run),
// and it never prints a value Terraform marks sensitive.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeSource } from "./lab-lint.mjs";
import { hclResources, planResources, Unknown } from "./lab-scope.mjs";

// ── The contract's copies (a test keeps them equal to scripts/lib/labs.mjs) ──

export const LAB_ID_RE = /^(az(104|305|700)|soa|saa|ans)-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/;
/** The labs whose provider may also be us-east-1 or us-west-2 (CloudFront's WAF, Global Accelerator). */
export const AWS_GLOBAL_LABS = ["soa-09-route53-cloudfront", "ans-26-edge"];
/** Ruling P5: labs with Route 53 items listed in us-east-1 that are not global labs (a copy of the contract's). */
export const AWS_DNS_LABS = ["saa-16-dr-pilot-light"];
/** The one lab that may make the account's Config recorder (one per region per account). */
export const AWS_CONFIG_LABS = ["soa-02-systems-manager"];
/** The one lab that may make IAM users. */
export const AWS_IAM_USER_LABS = ["soa-07-iam-kms"];
export const AWS_INSTANCE_TYPES = ["t4g.nano", "t4g.micro", "t4g.small", "t3.micro", "t3.small", "t4g.medium"];
/** The labs that may use t4g.medium. */
export const AWS_MEDIUM_LABS = ["saa-19-eks"];

// ── This check's own lists ───────────────────────────────────────────────

/** One character AWS allows in a security group or rule description. */
export const SG_DESCRIPTION_CHAR = /^[a-zA-Z0-9. _:/()#,@\[\]+=&;{}!$*-]$/;
export const AWS_RULES = ["provider", "provisioner", "import", "type", "never", "template", "tag", "untaggable", "iam", "gateway", "address", "public", "lingering", "size", "description"];
export const AWS_PROVIDER_SOURCES = ["registry.terraform.io/hashicorp/aws", "registry.terraform.io/hashicorp/random", "registry.terraform.io/hashicorp/time", "registry.terraform.io/hashicorp/tls", "registry.terraform.io/hashicorp/archive"];
const AWS_SOURCE = AWS_PROVIDER_SOURCES[0];
/** The only settings an aws provider block may carry (AWS labs spec §4). */
const AWS_PROVIDER_KEYS = ["region", "alias", "default_tags"];
const GLOBAL_REGIONS = ["us-east-1", "us-west-2"];
const AWS_ID_PREFIX = /^(soa|saa|ans)-/;

/**
 * The resource types an AWS lab may make, each with why it stays inside the lab. A lab that needs another adds it here
 * with its reason (labs spec §17, ruling 21); the other rules still check it.
 */
export const AWS_TYPES = new Map([
  ["time_sleep", "a wait for something to settle (hashicorp/time), e.g. cloud-init before a snapshot"],
  ["aws_resourcegroups_group", "the lab's own console group, a tag query on its own id"],
  ...["aws_vpc", "aws_subnet", "aws_route_table", "aws_route_table_association", "aws_route", "aws_internet_gateway"].map((t) => [t, "the lab's own network inside its slot"]),
  ...["aws_security_group", "aws_vpc_security_group_ingress_rule", "aws_vpc_security_group_egress_rule"].map((t) => [t, "the lab's own firewall rules"]),
  ["aws_vpc_endpoint", "S3 gateway endpoint and interface endpoints inside the lab VPC"],
  ["aws_ec2_instance_connect_endpoint", "console SSH into the lab's private instances"],
  ...["aws_instance", "aws_launch_template", "aws_ebs_volume", "aws_volume_attachment", "aws_ebs_snapshot"].map((t) => [t, "the lab's compute and disks"]),
  ...["aws_autoscaling_group", "aws_autoscaling_policy", "aws_autoscaling_schedule", "aws_autoscaling_lifecycle_hook"].map((t) => [t, "lab 03's group and its scaling settings"]),
  ...["aws_lb", "aws_lb_target_group", "aws_lb_listener"].map((t) => [t, "lab 03's load balancer"]),
  ...["aws_iam_role", "aws_iam_instance_profile", "aws_iam_policy", "aws_iam_role_policy_attachment"].map((t) => [t, "lab identities under the boundary, path /cloudlabs-lab/"]),
  ...["aws_cloudwatch_log_group", "aws_cloudwatch_log_metric_filter", "aws_cloudwatch_metric_alarm", "aws_cloudwatch_dashboard", "aws_cloudwatch_query_definition"].map((t) => [t, "lab 01's monitoring"]),
  ...["aws_cloudwatch_event_rule", "aws_cloudwatch_event_target", "aws_sns_topic", "aws_sns_topic_policy"].map((t) => [t, "lab 01's notifications"]),
  ...["aws_ssm_patch_baseline", "aws_ssm_patch_group", "aws_ssm_association"].map((t) => [t, "lab 02's Systems Manager settings"]),
  ...["aws_config_configuration_recorder", "aws_config_delivery_channel", "aws_config_configuration_recorder_status", "aws_config_config_rule", "aws_config_remediation_configuration"].map((t) => [t, "lab 02's Config (recorder only in AWS_CONFIG_LABS)"]),
  ...["aws_s3_bucket", "aws_s3_bucket_versioning", "aws_s3_bucket_lifecycle_configuration", "aws_s3_bucket_replication_configuration", "aws_s3_bucket_public_access_block", "aws_s3_bucket_policy", "aws_s3_object"].map((t) => [t, "lab buckets named cloudlabs-<name_prefix>-*"]),
  ...["aws_backup_vault", "aws_backup_plan", "aws_backup_selection"].map((t) => [t, "lab 04's backups"]),
  ...["aws_db_instance", "aws_db_subnet_group", "aws_db_parameter_group"].map((t) => [t, "lab 05's database"]),
  ["random_password", "a lab secret's first value (hashicorp/random), never leaves the lab's state"],
  ["aws_cloudformation_stack", "lab 06's stack: its template is read against CFN_TYPES (rule template) and it runs as the lab's own bounded service role"],
  ...["aws_iam_user", "aws_iam_user_login_profile", "aws_iam_user_policy_attachment"].map((t) => [t, "lab 07's console user under the boundary (AWS_IAM_USER_LABS only, rule iam)"]),
  ...["aws_kms_key", "aws_kms_alias"].map((t) => [t, "a lab key (7-day deletion window, the account root granted kms:*) and its alias/lab-<id>-* name"]),
  ...["aws_secretsmanager_secret", "aws_secretsmanager_secret_version", "aws_secretsmanager_secret_rotation"].map((t) => [t, "a lab secret, deleted without recovery, rotated by the lab's own function"]),
  ...["aws_lambda_function", "aws_lambda_permission"].map((t) => [t, "a lab function writing to the lab's own log group, invoked only by AWS services (rule public)"]),
  ["aws_accessanalyzer_analyzer", "lab 07's account analyzer (ACCESS_ANALYZER_LABS only: one per region per account)"],
  ["aws_vpc_peering_connection", "peering between two of the lab's own VPCs, by reference (rule gateway)"],
  ...["aws_network_acl", "aws_network_acl_rule", "aws_network_acl_association"].map((t) => [t, "the lab's own network ACLs on its own subnets"]),
  ["aws_flow_log", "flow logs of the lab's VPCs to the lab's own log group (rule lingering)"],
  ...["aws_route53_zone", "aws_route53_record", "aws_route53_health_check"].map((t) => [t, "lab 09's public zone <name_prefix>.labs.clydeford.net (never delegated, A27), its records and a health check of its own site"]),
  ...["aws_cloudfront_distribution", "aws_cloudfront_origin_access_control"].map((t) => [t, "lab 09's distribution in front of the lab's own private bucket"]),
  ...["aws_eip", "aws_nat_gateway"].map((t) => [t, "a lab NAT gateway and its address (public by nature, §7.4); at most 2 (rule size)"]),
  ...["aws_ecr_repository", "aws_ecr_lifecycle_policy"].map((t) => [t, "lab 10's image repository, deleted with its images"]),
  ...["aws_ecs_cluster", "aws_ecs_task_definition", "aws_ecs_service"].map((t) => [t, "lab 10's Fargate cluster, task and service (0.5 vCPU a task, at most 4 tasks)"]),
  // Batch 3 (labs 11–19).
  ...["aws_elasticache_subnet_group", "aws_elasticache_replication_group"].map((t) => [t, "lab 11's cache: one Valkey node in the lab's own subnets (rules size, lingering; ruling P17)"]),
  ...["aws_apigatewayv2_api", "aws_apigatewayv2_authorizer", "aws_apigatewayv2_integration", "aws_apigatewayv2_route", "aws_apigatewayv2_stage"].map((t) => [t, "lab 12's HTTP API: public by nature (§7.4), throttled, invoking only the lab's own function, trusting only the lab's own user pool (ruling P12)"]),
  ...["aws_cognito_user_pool", "aws_cognito_user_pool_client", "aws_cognito_user"].map((t) => [t, "lab 12's sign-in: a Lite-tier pool of the lab's own users, no hosted domain (ruling P12)"]),
  ["aws_dynamodb_table", "a lab table named lab-<id>-*, on demand; a replica only in the session's secondary region (rulings P3, P12)"],
  ...["aws_sqs_queue", "aws_sqs_queue_policy", "aws_sns_topic_subscription"].map((t) => [t, "lab 13's queues and its topic's subscriptions to them (ruling P14)"]),
  ["aws_cloudwatch_event_bus", "lab 13's own event bus"],
  ["aws_sfn_state_machine", "lab 13's workflow, calling only the lab's own function, topic and queues (ruling P14)"],
  ...["aws_efs_file_system", "aws_efs_mount_target"].map((t) => [t, "lab 14's file system, mounted in the lab's own subnets"]),
  ...["aws_s3_bucket_intelligent_tiering_configuration", "aws_s3_bucket_server_side_encryption_configuration"].map((t) => [t, "lab buckets named cloudlabs-<name_prefix>-*"]),
  ["aws_vpc_endpoint_policy", "a policy on the lab's own endpoint allowing only the lab's buckets and Amazon Linux's repositories (ruling P18)"],
  ["aws_ami_copy", "a copy of AWS's own AMI, named lab-<id>-* (ruling P4)"],
  ...["aws_kinesis_stream", "aws_kinesis_firehose_delivery_stream"].map((t) => [t, "lab 17's stream (one shard) and its delivery to the lab's own bucket (ruling P15)"]),
  ...["aws_glue_catalog_database", "aws_glue_crawler"].map((t) => [t, "lab 17's catalogue, lab_<id>, crawled by hand from the lab's own bucket (ruling P15)"]),
  ["aws_athena_workgroup", "lab 17's workgroup: results in the lab's own bucket, a scan cut-off (ruling P15)"],
  ...["aws_eks_cluster", "aws_eks_node_group"].map((t) => [t, "lab 19's cluster and its one-node group (ruling P7)"]),
]);

/** The data sources an AWS lab may read, each with why (and the condition dataProblem checks). None looks up a lab-made-elsewhere VPC, subnet, route table, security group or instance. */
export const AWS_DATA = new Map([
  ["aws_ssm_parameter", "AWS's public parameters only: name must start /aws/service/ (the Amazon Linux AMI)"],
  ["aws_ami", "Amazon's own images only: owners exactly [\"amazon\"]"],
  ["aws_availability_zones", "the region's zones"],
  ["aws_caller_identity", "the account id, for ARNs"],
  ["aws_region", "the region's name"],
  ["aws_partition", "the partition, for ARNs"],
  ["aws_iam_policy_document", "a policy document built in Terraform (the iam rule reads the result)"],
  ["aws_ec2_managed_prefix_list", "AWS-managed prefix lists only: name must start com.amazonaws."],
  ["archive_file", "a zip of the lab's own files (lab-lint keeps it inside path.module)"],
]);

/** never: what costs too much, needs a contract or reaches beyond the account, so a lab only explains it (AWS labs spec §7.3 rule 5). */
export const NEVER_TYPES = [
  /^aws_dx_/, /^aws_networkmanager_/, /^aws_organizations_/, /^aws_ram_/, /^aws_fms_/, /^aws_shield_/, /^aws_verifiedaccess_/, /^aws_acmpca_/,
  /^aws_route53domains_/, /^aws_ec2_host$/, /^aws_ec2_capacity_reservation$/, /^aws_ec2_capacity_block_reservation$/, /^aws_guardduty_/,
  /^aws_securityhub_/, /^aws_macie2_/, /^aws_iam_service_linked_role$/, /^aws_iam_access_key$/, /^aws_iam_account_/, /^aws_budgets_/, /^aws_ce_/,
  /^aws_ec2_byoip_/, /^aws_vpc_ipam_pool_cidr$/,
  // StackSets are readme-only (spec §12.2); registering a CloudFormation type changes the whole account.
  /^aws_cloudformation_stack_set/, /^aws_cloudformation_stack_instances$/, /^aws_cloudformation_type$/,
];
/** The one lab that may make an IPAM pool CIDR and an IPv6 pool of its own. */
const IPAM_LAB = "ans-20-vpc-design";
/** Types the type rule leaves to a later rule, which says more (preflight ruling C1). */
/**
 * Ruling A48: what AWS makes untagged with every VPC (its default security group, network ACL and main route table), and
 * tags put on an item that is already there. wg-admin-labs may not change them, so a lab is told so at plan time.
 */
export const UNTAGGED_DEFAULT_TYPES = new Map([
  ["aws_default_security_group", "a VPC's default security group"],
  ["aws_default_network_acl", "a VPC's default network ACL"],
  ["aws_default_route_table", "a VPC's main route table"],
  ["aws_ec2_tag", "a tag on an item that is already there"],
]);
const DEFERRED = { aws_vpc_peering_connection_accepter: "gateway" };
const CONFIG_TYPES = new Set(["aws_config_configuration_recorder", "aws_config_delivery_channel", "aws_config_configuration_recorder_status"]);
/** Ruling P14: the one lab that may make an Access Analyzer analyzer (one account analyzer per region per account). */
export const ACCESS_ANALYZER_LABS = ["soa-07-iam-kms"];
/** Ruling P7: in AWS_GLOBAL_LABS, the only types whose own region may be a global one. */
export const GLOBAL_REGION_TYPES = { "us-east-1": [/^aws_wafv2_/], "us-west-2": [/^aws_globalaccelerator_/] };
/** Ruling A27: lab 09's public zone is <name_prefix> under this, never delegated. */
export const LAB_ZONE_SUFFIX = ".labs.clydeford.net";
/** Ruling P4: what a lab's CloudFormation stack may make, each with why it stays inside the lab. */
export const CFN_TYPES = new Map([
  ["AWS::SNS::Topic", "named by CloudFormation from the stack's name, lab-<id>-..."],
  ["AWS::SQS::Queue", "named by CloudFormation from the stack's name"],
  ["AWS::CloudWatch::Alarm", "named by CloudFormation from the stack's name"],
  ["AWS::Logs::LogGroup", "named /cloudlabs/<id>/..., kept at most 7 days (A56)"],
  ["AWS::SSM::Parameter", "named /cloudlabs/<id>/..."],
]);
/** Ruling P10: resource policy documents a lab may write (type -> attribute), read for who they let in. */
export const RESOURCE_POLICIES = new Map([["aws_s3_bucket_policy", "policy"], ["aws_sns_topic_policy", "policy"], ["aws_sqs_queue_policy", "policy"], ["aws_ecr_repository_policy", "policy"], ["aws_secretsmanager_secret_policy", "policy"], ["aws_kms_key", "policy"], ["aws_dynamodb_resource_policy", "policy"]]);
/**
 * Preflight C12 and Task 3 fix round 1 (I-1): a resource's own inline policy (type -> attribute), read as a resource
 * policy when the lab writes one (left unset it is computed: AWS's default). aws_dynamodb_table has no inline policy
 * in aws 6.69 (aws_dynamodb_resource_policy, above, is not on AWS_TYPES).
 */
const INLINE_POLICIES = new Map([["aws_sns_topic", "policy"], ["aws_secretsmanager_secret", "policy"], ["aws_s3_bucket", "policy"], ["aws_sqs_queue", "policy"]]);
/** An AWS service principal (events.amazonaws.com). */
const SERVICE_PRINCIPAL = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.amazonaws\.com(\.cn)?$/;
/** Ruling P9: the resources whose { key, values } blocks select instances. */
const TARGET_ATTRS = { aws_ssm_association: ["targets"], aws_ssm_maintenance_window_target: ["targets"], aws_ssm_maintenance_window_task: ["targets"], aws_cloudwatch_event_target: ["run_command_targets"] };

/** untaggable: types that cannot carry tags, owned by name instead (ruling A4): type -> the attribute that must start lab-<id>-. */
export const UNTAGGABLE = new Map([
  ["aws_cloudwatch_dashboard", "dashboard_name"],
  ["aws_cloudwatch_query_definition", "name"],
  ["aws_config_configuration_recorder", "name"],
  ["aws_config_delivery_channel", "name"],
  ["aws_config_configuration_recorder_status", "name"],
  ["aws_ssm_patch_group", "patch_group"],
  ["aws_kms_alias", "name"],
  ["aws_cloudfront_function", "name"],
  ["aws_cloudfront_origin_access_control", "name"],
  ["aws_cloudfront_cache_policy", "name"],
  ["aws_cloudfront_origin_request_policy", "name"],
]);

/** The AWS managed policies a lab role may have attached (AWS labs spec §7.1); Task 17's controller checks each exists. */
export const MANAGED_POLICIES = [
  "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
  "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
  "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
  "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
  "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
  "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
  "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
  "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole",
  "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
  "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores",
  "arn:aws:iam::aws:policy/service-role/AmazonSSMAutomationRole",
  "arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole",
];
/** The permissions boundary every lab role and user carries (AWS labs spec §7.2). */
export const BOUNDARY_RE = /^arn:aws:iam::\d{12}:policy\/wg-admin-lab-boundary$/;
/** Public by nature (AWS labs spec §7.4): the labs whose instance may have a public IPv4 (lab 22's "on-prem" router). */
export const PUBLIC_INSTANCE_LABS = ["ans-22-s2s-vpn"];

const LAB_TAG = "cloudlabs-lab";
const IAM_PATH = "/cloudlabs-lab/";
/**
 * The VPN server's own names (infra/aws/main.tf's Name tags: its VPC, subnets, route tables, gateway, security groups,
 * interface, address, instances and their disks): a lab never names or reaches them (final review, Important 3: an SSM
 * association could otherwise target tag:Name = vm-wg).
 */
export const GATEWAY_NAME_LIST = ["vpc-wg", "snet-wg", "rt-wg", "sg-wg", "igw-wg", "nic-wg", "pip-wg", "vm-wg", "osdisk-wg", "rt-workloads", "snet-workloads", "sg-workloads", "vm-test", "osdisk-test"];
const GATEWAY_NAMES = new RegExp(String.raw`\b(${GATEWAY_NAME_LIST.join("|")})\b`, "i");
/**
 * An id of an existing EC2 resource: a lab names its own only by reference, so a known one is someone else's. acl- since
 * ruling A82 (the role may move a subnet's ACL association, so a lab's association names its own ACL by reference).
 */
const EC2_ID = "(?:vpc|subnet|rtb|sg|igw|nat|pcx|tgw|tgw-attach|eni|i|eipalloc|vpce|lt|eigw|pl|vol|snap|acl)-[0-9a-f]{8,17}";
const KNOWN_ID_RE = new RegExp(`^${EC2_ID}$`);
/** An EC2 ARN that embeds a known id (arn:aws:ec2:<region>:<account>:instance/i-…), anywhere in a string (JSON documents too). */
const EC2_ARN_RE = new RegExp(String.raw`arn:aws[a-z-]*:ec2:[^:"\s]*:[^:"\s]*:[a-z-]+/(${EC2_ID})(?![0-9a-z-])`);
/** A CloudWatch alarm's EC2 action (stop, terminate, reboot, recover): it acts on the instance its dimensions name (review I-1). */
const EC2_ACTION_RE = /^arn:aws[a-z-]*:automate:|AWS_EC2\.InstanceId\./i;
/**
 * The keys that hold ids (preflight ruling C4, as amended by the controller in review round 1): snake case (vpc_id,
 * subnet_ids) and camel case (InstanceId, InstanceIds, as CloudWatch dimensions spell them), never a name, name_prefix,
 * identifier or tag value.
 */
const ID_KEY = (k) => /(^|_)ids?$/i.test(k) || /[a-z]Ids?$/.test(k) || ["vpc_zone_identifier", "subnets", "security_groups", "route_table_ids"].includes(k);
/**
 * A { key, values } target (an SSM association's targets, an EventBridge target's run_command_targets) whose values are
 * ids: any key but a tag or resource-group selector (InstanceIds, WindowTargetIds, ...).
 */
const ID_TARGET_KEY = (k) => typeof k === "string" && !/^(tag:|tag-key$|resource-groups:)/i.test(k);
/** A target by tag key alone (every instance carrying the key: Name, say), and one by a tag's value. */
const TARGET_TAG_KEY = (k) => typeof k === "string" && /^tag-key$/i.test(k);
const TARGET_TAG = (k) => typeof k === "string" && /^tag:/i.test(k);
/** count.index and each.key: an instance's own key (Terraform lists them among the references). */
const INDEX_REF = /^(count\.index|each\.key)(\.|\[|$)/;
/** The private ranges: SSH from anything wider is from the internet. */
const PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

// ── Small helpers ────────────────────────────────────────────────────────

const stripIndex = (address) => address.replace(/\[[^\]]*\]/g, "");
const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Unknown);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nonEmpty = (v) => typeof v === "string" && v !== "";
/** A known string starts with p, or an Unknown's known start does (HCL: lab-${var.lab_id}-${...}). */
const startsKnown = (v, p) => (typeof v === "string" ? v.startsWith(p) : v instanceof Unknown ? v.prefix.startsWith(p) : false);

/** An IPv4 CIDR as [first, last] address numbers, or null. */
function cidr4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(s));
  if (!m || m.slice(1, 5).some((x) => Number(x) > 255) || Number(m[5]) > 32) return null;
  const ip = m.slice(1, 5).reduce((a, x) => a * 256 + Number(x), 0);
  const size = 2 ** (32 - Number(m[5]));
  const start = Math.floor(ip / size) * size;
  return [start, start + size - 1];
}
const inside = (a, b) => {
  const x = cidr4(a);
  const y = cidr4(b);
  return Boolean(x && y && x[0] >= y[0] && x[1] <= y[1]);
};
const overlaps = (a, b) => {
  const x = cidr4(a);
  const y = cidr4(b);
  return Boolean(x && y && x[0] <= y[1] && y[0] <= x[1]);
};
/** A CIDR that reaches beyond the private ranges (IPv4), or all of IPv6. */
const fromInternet = (c) => (typeof c !== "string" ? false : c.includes(":") ? /\/0$/.test(c) : Boolean(cidr4(c)) && !PRIVATE.some((p) => inside(c, p)));

/** A JSON document from a value: { doc }, { unknown: true } or { bad: true }. */
function jsonDoc(v) {
  if (v instanceof Unknown) return { unknown: true };
  if (isObj(v)) return { doc: v };
  try {
    const text = String(v);
    const doc = JSON.parse(text);
    // Re-review N-3: JSON.parse keeps a duplicate key's last value; AWS may read the first. Refuse either way.
    const dup = duplicateKey(text);
    if (dup !== null) return { bad: true, why: `the key ${JSON.stringify(dup)} appears twice in one object` };
    return isObj(doc) ? { doc } : { bad: true };
  } catch {
    return { bad: true };
  }
}

/** The first key that appears twice in one object of valid JSON text, or null (re-review N-3). */
function duplicateKey(text) {
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const top = stack[stack.length - 1];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (top && top.expectKey) {
        const k = JSON.parse(text.slice(i, j + 1));
        if (top.keys.has(k)) return k;
        top.keys.add(k);
        top.expectKey = false;
      }
      i = j;
    } else if (ch === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (ch === "[") stack.push(null);
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === "," && top) top.expectKey = true;
  }
  return null;
}

/** An IAM action pattern that could match an iam: action (the service part as a glob), or "*". */
function reachesIam(action) {
  if (typeof action !== "string") return true;
  if (action.trim() === "*") return true;
  const i = action.indexOf(":");
  const service = i < 0 ? action : action.slice(0, i);
  const glob = new RegExp(`^${service.split("").map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : escapeRe(ch))).join("")}$`, "i");
  return glob.test("iam") || (i < 0 && action.includes("*"));
}

/** Why an identity policy document is refused, or null. */
function permissionProblem(doc) {
  for (const s of list(doc.Statement)) {
    if (!isObj(s)) return "it has a statement this check cannot read";
    if ("NotAction" in s) return "it uses NotAction (it grants everything but a list)";
    const bad = list(s.Action).find(reachesIam);
    if (bad !== undefined) return `it allows ${typeof bad === "string" ? bad : "an action this check cannot read"} (no "*" and no iam: actions)`;
  }
  return null;
}

/**
 * Why a role's trust policy is refused, or null: only AWS services and the lab's own roles, in the lab's own account
 * (final review, Important 4: account is the plan's caller identity, else the role's boundary's; null when neither is
 * known, and then no role principal passes), may assume it. No wildcard: not in the account, not in the name.
 */
function trustProblem(doc, labId, account) {
  const ownRole = account ? new RegExp(`^arn:aws:iam::${account}:role/cloudlabs-lab/lab-${escapeRe(labId)}-[A-Za-z0-9+=,.@_-]+$`) : null;
  for (const s of list(doc.Statement)) {
    if (!isObj(s)) return "it has a statement this check cannot read";
    if ("NotPrincipal" in s) return "it uses NotPrincipal";
    const p = s.Principal;
    if (p === undefined) continue;
    if (!isObj(p)) return `it trusts ${JSON.stringify(p)}`;
    for (const [k, v] of Object.entries(p)) {
      if (k === "Service" && list(v).every((x) => typeof x === "string" && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.amazonaws\.com(\.cn)?$/.test(x))) continue;
      if (k === "AWS" && ownRole && list(v).every((x) => typeof x === "string" && ownRole.test(x))) continue;
      // Never an account id in the output: the lab's own is masked in CI, another's is no business of the log.
      const shown = JSON.stringify(v).replace(/\d{12}/g, "<account>");
      return `it trusts ${k} ${shown}: only AWS services and the lab's own roles in the lab's own account (arn:aws:iam::<this account>:role/cloudlabs-lab/lab-${labId}-<name>)${ownRole ? "" : "; this plan does not show the lab's own account (data.aws_caller_identity or the role's boundary)"}`;
    }
  }
  return null;
}

/**
 * Ruling P14: why a Step Functions definition reaches outside the lab, or null. Task 3 fix round 1 (I-2): a function,
 * topic or queue is the lab's own by name AND, when `account` / `regions` are given, in the lab's own account and
 * regions (an account of null or "" matches none: fail closed); no other SNS target (TargetArn, PhoneNumber), no
 * target chosen at run time (a ".$" target key, a JSONata {% … %} expression, QueryLanguage other than JSONPath), and
 * no Credentials (a task run as another account's role).
 */
export function workflowProblem(doc, labId, { account, regions } = {}) {
  const integrations = new Set(["arn:aws:states:::lambda:invoke", "arn:aws:states:::sns:publish", "arn:aws:states:::sqs:sendMessage"]);
  const name = String.raw`lab-${escapeRe(labId)}-[A-Za-z0-9_.-]+`;
  const acct = account === undefined ? String.raw`\d{12}` : /^\d{12}$/.test(account ?? "") ? account : "(?!)";
  const reg = regions === undefined ? "[a-z0-9-]+" : `(?:${regions.map(escapeRe).join("|") || "(?!)"})`;
  const fnArn = new RegExp(`^arn:aws:lambda:${reg}:${acct}:function:${name}$`);
  const own = {
    FunctionName: (s) => fnArn.test(s) || new RegExp(`^${name}$`).test(s),
    TopicArn: (s) => new RegExp(`^arn:aws:sns:${reg}:${acct}:${name}$`).test(s),
    QueueUrl: (s) => new RegExp(String.raw`^https://sqs\.${reg}\.amazonaws\.com/${acct}/${name}$`).test(s),
  };
  const runTime = ["Resource.$", "FunctionName.$", "TopicArn.$", "QueueUrl.$", "TargetArn", "TargetArn.$", "PhoneNumber", "PhoneNumber.$", "Arguments.$"];
  /** Fix round 2, R2-4: the keys this check reads, matched without case (a key in another case is refused). */
  const known = ["Resource", "FunctionName", "TopicArn", "QueueUrl", "QueryLanguage", "Arguments", ...runTime];
  const visit = (v, path) => {
    if (typeof v === "string") return v.trimStart().startsWith("{%") ? `${path.join(".")}: a JSONata expression chooses its value at run time` : null;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const w = visit(v[i], [...path, i]);
        if (w) return w;
      }
      return null;
    }
    if (v === null || typeof v !== "object") return null;
    for (const [k, x] of Object.entries(v)) {
      const where = [...path, k].join(".");
      const canon = known.find((c) => c.toLowerCase() === k.toLowerCase());
      if (canon && canon !== k) return `${where}: written ${canon} in another case (this check reads the exact key)`;
      if (k.toLowerCase().startsWith("credentials")) return `${where}: a task runs as the state machine's own role, never another's`;
      if (k === "QueryLanguage" && x !== "JSONPath") return `${where}: only JSONPath (JSONata can choose a target at run time)`;
      if (k.startsWith("Credentials")) return `${where}: a task runs as the state machine's own role, never another's`;
      if (runTime.includes(k)) return `${where}: a target chosen at run time, or an SNS target other than the lab's own topic, could be anything`;
      if (k === "Resource" && !(typeof x === "string" && (integrations.has(x) || fnArn.test(x)))) return `${where}: ${typeof x === "string" ? x : "(not a string)"} is neither the lab's own function nor a lambda:invoke, sns:publish or sqs:sendMessage integration (no aws-sdk:)`;
      if (k in own && !(typeof x === "string" && own[k](x))) return `${where}: ${k} must be one of the lab's own, named lab-${labId}-*, in the lab's own account and region`;
      const w = visit(x, [...path, k]);
      if (w) return w;
    }
    return null;
  };
  return visit(doc, []);
}

/** Ruling P18: why an endpoint policy lets the endpoint reach more than the lab's buckets and Amazon Linux's repositories, or null. */
export function endpointPolicyProblem(doc, namePrefix, region) {
  const okArn = (a) => typeof a === "string" && ((nonEmpty(namePrefix) && a.startsWith(`arn:aws:s3:::cloudlabs-${namePrefix}-`)) || (nonEmpty(region) && a.startsWith(`arn:aws:s3:::al2023-repos-${region}-`)));
  for (const s of list(doc.Statement)) {
    if (!isObj(s)) return "it has a statement this check cannot read";
    if (s.Effect === "Deny") continue;
    if ("NotResource" in s || "NotAction" in s) return "an Allow with NotResource or NotAction reaches everything else";
    const res = list(s.Resource);
    const bad = res.find((a) => !okArn(a));
    if (!res.length || bad !== undefined) return `it allows ${JSON.stringify(bad ?? "no resource")}: only the lab's own buckets (cloudlabs-<name_prefix>-*) and Amazon Linux's repositories (al2023-repos-<region>-*)`;
  }
  return null;
}

/** Ruling P10: why a resource policy lets in too much, or null. An Allow never names everyone or another account. */
function resourcePolicyProblem(doc, account) {
  for (const s of list(doc.Statement)) {
    if (!isObj(s)) return "it has a statement this check cannot read";
    // Anything but a Deny is read as an Allow (review M-1: an odd casing fails closed).
    if (s.Effect === "Deny") continue;
    if ("NotPrincipal" in s) return "an Allow with NotPrincipal lets in everyone else";
    const p = s.Principal;
    if (p === "*") return 'it allows Principal "*"';
    if (!isObj(p)) return "it has a principal this check cannot read";
    for (const [k, v] of Object.entries(p)) {
      if (k === "Service" && list(v).every((x) => typeof x === "string" && SERVICE_PRINCIPAL.test(x))) continue;
      if (k === "AWS" && account && list(v).every((x) => typeof x === "string" && (x === account || x.startsWith(`arn:aws:iam::${account}:`)))) continue;
      return `it allows ${k} ${JSON.stringify(v).replace(/\d{12}/g, "<account>")}: only AWS services and the lab's own account`;
    }
  }
  return null;
}

/** Whether a key policy grants the account root kms:* (so the account can always delete the key). */
function grantsRoot(doc) {
  return list(doc.Statement).some(
    (s) => isObj(s) && s.Effect === "Allow" && isObj(s.Principal) && list(s.Principal.AWS).some((a) => typeof a === "string" && /^arn:aws:iam::\d{12}:root$/.test(a)) && list(s.Action).includes("kms:*"),
  );
}

/**
 * Ruling P4: why a lab's CloudFormation template (as JSON) may not run, as sentences. Types only from CFN_TYPES; no
 * Transform, Fn::Transform or Fn::ImportValue; nothing kept after tear-down; no names CloudFormation would otherwise
 * make from the stack; log groups and parameters under /cloudlabs/<id>/ (a literal, or a Ref to a stack parameter).
 */
export function cfnTemplateProblems(doc, { labId, parameters = {} }) {
  if (!isObj(doc)) return ["the template is not a JSON object"];
  const out = [];
  const own = `/cloudlabs/${labId}/`;
  if ("Transform" in doc) out.push("Transform runs a macro (SAM and the like) this check never sees");
  /** A literal, or a Ref to a parameter: the stack's value for it, else the parameter's default. */
  const value = (x) => (isObj(x) && Object.keys(x).length === 1 && typeof x.Ref === "string" ? (parameters[x.Ref] ?? doc.Parameters?.[x.Ref]?.Default) : x);
  for (const [name, res] of Object.entries(isObj(doc.Resources) ? doc.Resources : {})) {
    if (!isObj(res)) {
      out.push(`${name}: not a resource this check can read`);
      continue;
    }
    const t = res.Type;
    if (!CFN_TYPES.has(t)) out.push(`${name}: ${t} is not on CFN_TYPES (${[...CFN_TYPES.keys()].join(", ")}); nested stacks, custom resources, macros and IAM never are`);
    for (const p of ["DeletionPolicy", "UpdateReplacePolicy"]) if (res[p] !== undefined && res[p] !== "Delete") out.push(`${name}: ${p} ${JSON.stringify(res[p])} would keep it after tear-down (only Delete)`);
    const props = isObj(res.Properties) ? res.Properties : {};
    for (const k of ["TopicName", "QueueName", "AlarmName"]) if (k in props) out.push(`${name}: ${k} is set: leave it out, so CloudFormation names it from the stack (lab-${labId}-...)`);
    if (t === "AWS::Logs::LogGroup") {
      const n = value(props.LogGroupName);
      if (typeof n !== "string" || !n.startsWith(own)) out.push(`${name}: LogGroupName must start ${own} (a literal or a Ref to a stack parameter; ruling A56)`);
      const d = Number(value(props.RetentionInDays));
      if (!(d >= 1 && d <= 7)) out.push(`${name}: RetentionInDays must be 1 to 7`);
      if (props.DeletionProtectionEnabled !== undefined && value(props.DeletionProtectionEnabled) !== false && value(props.DeletionProtectionEnabled) !== "false") out.push(`${name}: DeletionProtectionEnabled would keep the log group after tear-down (only false, or leave it out)`);
    }
    if (t === "AWS::SSM::Parameter") {
      const n = value(props.Name);
      if (typeof n !== "string" || !n.startsWith(own)) out.push(`${name}: Name must start ${own}`);
    }
  }
  // Re-review N-1: judged by its shape, never by scanning strings that functions build. Parameters are strings or
  // numbers (no SSM-typed or list parameters); an alarm acts only on a topic of the template's own.
  for (const [name, p] of Object.entries(isObj(doc.Parameters) ? doc.Parameters : {})) {
    if (!isObj(p) || (p.Type !== "String" && p.Type !== "Number")) out.push(`Parameters.${name}: Type ${JSON.stringify(isObj(p) ? p.Type : p)}: only String or Number (an SSM-typed or list parameter brings in what this check never sees)`);
  }
  const resources = isObj(doc.Resources) ? doc.Resources : {};
  for (const [name, res] of Object.entries(resources)) {
    if (!isObj(res) || res.Type !== "AWS::CloudWatch::Alarm") continue;
    const props = isObj(res.Properties) ? res.Properties : {};
    for (const k of ["AlarmActions", "OKActions", "InsufficientDataActions"]) {
      list(props[k]).forEach((a, i) => {
        const ok = isObj(a) && Object.keys(a).length === 1 && typeof a.Ref === "string" && isObj(resources[a.Ref]) && resources[a.Ref].Type === "AWS::SNS::Topic";
        if (!ok) out.push(`${name}.${k}.${i}: an alarm acts only on a topic of this template's own ({ Ref: <an AWS::SNS::Topic> })`);
      });
    }
  }
  walk(doc, [], (kind, path, s) => {
    const where = path.slice(0, kind === "key" ? -1 : undefined).join(".");
    if (kind === "key" && (s === "Fn::ImportValue" || s === "Fn::Transform")) out.push(`${where}: ${s} reaches outside this template`);
    else if (kind === "key" && s.startsWith("Fn::") && s !== "Fn::GetAtt") out.push(`${where}: ${s}: a lab's template uses only Ref and Fn::GetAtt, so every value it holds can be read`);
    else if (kind === "string" && s.includes("{{resolve:")) out.push(`${where}: a dynamic reference ({{resolve:...}}) brings in what this check never sees`);
  });
  return [...new Set(out)];
}

/** Every Unknown under a value, as [path, unknown]. */
function unknownLeaves(v, path, out = []) {
  if (v instanceof Unknown) out.push([path, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => unknownLeaves(x, [...path, i], out));
  else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) unknownLeaves(x, [...path, k], out);
  return out;
}

/** Every string and object key under a value: visit(kind, path, text). */
function walk(v, path, visit) {
  if (v instanceof Unknown || v === null || v === undefined) return;
  if (typeof v === "string") visit("string", path, v);
  else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i], visit));
  else if (typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      visit("key", [...path, k], k);
      walk(x, [...path, k], visit);
    }
  }
}

// ── The rules ────────────────────────────────────────────────────────────

/** A region as written: "var.region", "var.secondary_region", a literal, or null (anything else). */
function planRegion(e) {
  if (!e || typeof e !== "object") return null;
  if (e.constant_value !== undefined) return typeof e.constant_value === "string" ? e.constant_value : null;
  const refs = e.references ?? [];
  if (refs.length === 1 && (refs[0] === "var.region" || refs[0] === "var.secondary_region")) return refs[0];
  return null;
}
function hclRegion(v) {
  if (typeof v !== "string") return null;
  const m = /^\$\{\s*(var\.region|var\.secondary_region)\s*\}$/.exec(v);
  if (m) return m[1];
  return v.includes("${") ? null : v;
}

/**
 * Check an AWS lab's resources (planResources or hclResources, plus { configKeys, providerConfigs } from a plan or
 * { providerBlocks } from HCL). Returns [{ rule, address, message }], at most one per resource. `mode` is "plan",
 * "hcl" (CI's early warning: unknown values are left to the plan) or "mock" (labs-tf's mocked plan: no tag rule, no
 * provider configuration in the stream).
 */
export function scopeProblemsAws(input, labId, { mode = "plan" } = {}) {
  const { resources = [], imports = [], variables = {}, configKeys = {}, providerConfigs = {}, providerBlocks = {} } = input ?? {};
  const plan = mode !== "hcl";
  const prefix = `lab-${labId}-`;
  /** Ruling P15: a lab's Glue database name (Glue and Athena take no hyphens). */
  const glueName = `lab_${labId.replace(/-/g, "_")}`;
  const importing = new Set(imports.map(stripIndex));
  const out = [];

  const managed = new Map();
  for (const r of resources) if (r.mode === "managed" && !managed.has(stripIndex(r.address))) managed.set(stripIndex(r.address), r);
  const data = resources.filter((r) => r.mode === "data");
  /** The lab's own account: the caller identity the plan read (main.tf's data.aws_caller_identity.current), if known. */
  const callerAccount = data.filter((d) => d.type === "aws_caller_identity").map((d) => d.values?.account_id).find((a) => typeof a === "string" && /^\d{12}$/.test(a)) ?? null;
  /** The account in the lab's roles' and users' known permission boundary, if any (a mocked plan's stand-in for callerAccount). */
  const boundaryAccount = [...managed.values()].map((m) => m.values?.permissions_boundary).filter((b) => typeof b === "string" && BOUNDARY_RE.test(b)).map((b) => /^arn:aws:iam::(\d{12}):/.exec(b)[1])[0] ?? null;
  /** The managed resource a reference names, if it is in this configuration. */
  const target = (ref) => (ref.startsWith("data.") ? null : managed.get(ref.replace(/\[[^\]]*\]/g, "").split(".").slice(0, 2).join(".")) ?? null);
  /** References (instance keys aside) that all name resources of `types` in this configuration, and at least one. */
  const ownRefs = (refs, types) => {
    const rest = (refs ?? []).filter((x) => !INDEX_REF.test(x));
    return rest.length > 0 && rest.every((x) => types.includes(target(x)?.type));
  };
  /** An Unknown's references: its own (plan, HCL) or, failing that, its whole attribute's. */
  const refsOf = (v, r, attr) => (v instanceof Unknown && v.refs?.length ? v.refs : (r.refs?.[attr] ?? []));
  /** A plan value built from something not known until apply (not a provider-computed default). */
  const opaque = (v) => plan && v instanceof Unknown && (v.refs?.length ?? 0) > 0;
  /**
   * Task 3 fix round 1, I-3: a block a plan cannot read element by element (a dynamic block whose for_each is not
   * known at plan is planned as one unknown, and a plan's configuration leaves dynamic blocks out). Fail closed.
   */
  const blockUnknown = (x) => plan && (x instanceof Unknown || list(x).some((e) => !isObj(e)));
  /** HCL leaves expressions to the plan; a plan refuses what it cannot see where the rule needs a value. */
  const skip = (v) => (!plan && v instanceof Unknown) || (plan && v instanceof Unknown && !(v.refs?.length > 0));
  /**
   * A KMS key left on AWS's default policy (it grants the account root only): unset, or computed (unknown with no
   * references) where the lab writes no policy. A written policy not known until apply is read, so refused (review I-2).
   */
  const kmsDefaultPolicy = (x, res) => x === undefined || (skip(x) && !(plan && res.configured?.has("policy")));

  // Regions (rule provider), as the plan's variables give them.
  const secondaryOk = mode === "hcl" || (nonEmpty(variables.secondary_region) && variables.secondary_region !== variables.region);
  const globalLab = AWS_GLOBAL_LABS.includes(labId);
  const regionWhy = (region, alias) => {
    if (region === "var.region") return null;
    if (region === "var.secondary_region") {
      if (alias !== "secondary") return 'region var.secondary_region only under alias = "secondary"';
      return secondaryOk ? null : "region var.secondary_region, but the plan's secondary_region is empty or equal to region";
    }
    if (GLOBAL_REGIONS.includes(region) && globalLab) return null;
    return `region ${region === null ? "(an expression)" : JSON.stringify(region)}: only var.region, var.secondary_region (alias "secondary"), or us-east-1 and us-west-2 in ${AWS_GLOBAL_LABS.join(", ")}`;
  };
  /** A resource's own known region (aws provider 6): the session's, the secondary, or a global one in a global lab. */
  const knownRegions = new Set([variables.region, ...(secondaryOk && plan ? [variables.secondary_region] : []), ...(globalLab ? GLOBAL_REGIONS : [])].filter(nonEmpty));

  // Every string a data source read: an id equal to one is AWS's own (a managed prefix list), not someone's resource.
  const dataStrings = new Set();
  for (const d of data) walk(d.values, [], (kind, _p, s) => kind === "string" && dataStrings.add(s));
  /** Review M-1: the AMI ids the public SSM parameter (or an Amazon-owned AMI lookup) read: an AMI copy's only sources. */
  const amiStrings = new Set();
  for (const d of data) if (d.type === "aws_ssm_parameter" || d.type === "aws_ami") walk(d.values, [], (kind, _p, s) => kind === "string" && amiStrings.add(s));

  // Rule address: the lab's VPC ranges in order, to find overlaps.
  const vpcRanges = [];
  let natGateways = 0;

  for (const r of resources) {
    const v = r.values ?? {};
    const type = r.type;
    const found = [];
    const refuse = (rule, message) => found.push({ rule, address: r.address, message });
    const isManaged = r.mode === "managed";

    // 1. provider
    if (!AWS_PROVIDER_SOURCES.includes(r.provider)) refuse("provider", `${r.provider} is not an allowed provider (${AWS_PROVIDER_SOURCES.join(", ")})`);
    else if (plan) {
      const pc = providerConfigs?.[configKeys?.[stripIndex(r.address)]];
      if (pc && !AWS_PROVIDER_SOURCES.includes(normalizeSource(pc.full_name ?? pc.name))) refuse("provider", `its provider configuration is ${pc.full_name}, which is not allowed`);
    }
    // A resource's own region (aws provider 6), judged only where the lab sets it: left unset it is the provider's
    // (checked below), and a mocked plan fills computed strings with made-up values.
    if (r.provider === AWS_SOURCE && r.configured?.has("region")) {
      const reg = v.region;
      if (plan) {
        if (typeof reg === "string" && !knownRegions.has(reg)) refuse("provider", `its own region ${reg} is not the session's (${[...knownRegions].join(", ") || "the plan has no region variable"})`);
        else if (opaque(reg)) {
          const refs = refsOf(reg, r, "region");
          const why = refs.length === 1 ? regionWhy(refs[0], refs[0] === "var.secondary_region" ? "secondary" : null) : "region (an expression)";
          if (why) refuse("provider", `its own ${why}`);
        } else if (reg instanceof Unknown) refuse("provider", "its own region is not known at plan (review M-4): region = var.region or var.secondary_region");
      } else {
        const reg2 = reg instanceof Unknown ? hclRegion(reg.raw) : hclRegion(reg);
        const why = regionWhy(reg2, reg2 === "var.secondary_region" ? "secondary" : null);
        if (why) refuse("provider", `its own ${why}`);
      }
    }
    // Ruling P7: what may live in a global region, judged per resource (a plan knows each resource's own region).
    if (mode === "plan" && isManaged && r.provider === AWS_SOURCE && GLOBAL_REGIONS.includes(v.region)) {
      const ok = globalLab && GLOBAL_REGION_TYPES[v.region].some((re) => re.test(type)) && (type !== "aws_wafv2_web_acl" || v.scope === "CLOUDFRONT");
      if (!ok) refuse("provider", `${type} in ${v.region}: only ${v.region === "us-east-1" ? "a WAF web ACL for CloudFront (aws_wafv2_*, scope CLOUDFRONT)" : "Global Accelerator (aws_globalaccelerator_*)"} lives there, and only in ${AWS_GLOBAL_LABS.join(", ")} (ruling P7)`);
    }
    // A replica written in the configuration, or one the plan shows (an unset replica block is computed: unknown).
    if (isManaged && type === "aws_secretsmanager_secret" && (r.configured?.has("replica") || list(v.replica).some(isObj))) refuse("provider", "replica: a secret copied to another region is outside the lab's regions");
    if (isManaged && type === "aws_kms_key" && v.multi_region === true) refuse("provider", "multi_region: a key's replicas live outside the lab's regions");
    // Ruling P3: a table's replica only in the session's secondary region; P4, P6: a region a resource names is a lab one.
    const labRegion = (x) => typeof x === "string" && knownRegions.has(x) && !GLOBAL_REGIONS.includes(x);
    if (plan && isManaged && type === "aws_dynamodb_table") {
      // Fix round 1, I-3: a replica block not known at plan (dynamic, for_each unknown) could be in any region.
      if (blockUnknown(v.replica)) refuse("provider", "replica is not known at plan (a dynamic block): write each replica, in the session's secondary region (ruling P3)");
      list(v.replica).forEach((rep, i) => {
        if (isObj(rep) && !(secondaryOk && rep.region_name === variables.secondary_region)) refuse("provider", `replica.${i}: a table's replica lives only in the session's secondary region (ruling P3)`);
      });
      // Fix round 2, R2-1: the witness block is Optional and Computed (planned wholly unknown when unset), so only one the
      // lab writes is refused; strong consistency, which needs a witness or a third replica, is refused with it.
      if (r.configured?.has("global_table_witness") || list(v.global_table_witness).some(isObj)) refuse("provider", "global_table_witness: a witness is a third region, outside the lab's (ruling P3)");
      list(v.replica).forEach((rep, i) => {
        if (isObj(rep) && (rep.consistency_mode === "STRONG" || opaque(rep.consistency_mode))) refuse("provider", `replica.${i}.consistency_mode: strong consistency needs a third region (ruling P3)`);
      });
    }
    for (const [t, attr] of [["aws_ami_copy", "source_ami_region"], ["aws_route53_health_check", "cloudwatch_alarm_region"]]) {
      if (plan && isManaged && type === t && v[attr] != null && !labRegion(v[attr])) refuse("provider", `${attr}: only the session's region or its secondary`);
    }
    if (plan && isManaged && type === "aws_route53_zone") list(v.vpc).forEach((z, i) => {
      if (isObj(z) && !labRegion(z.vpc_region)) refuse("provider", `vpc.${i}.vpc_region: only the session's region or its secondary, written in the configuration (ruling P6)`);
    });

    // 2. provisioner, 3. import
    if (r.provisioners > 0) refuse("provisioner", "a provisioner would run commands with the pipeline's keys");
    if (importing.has(stripIndex(r.address))) refuse("import", "a lab only creates: importing would adopt an object that already exists");

    // 4. type, 5. never
    const never = isManaged && NEVER_TYPES.some((re) => re.test(type)) && !(type === "aws_vpc_ipam_pool_cidr" && labId === IPAM_LAB);
    if (isManaged) {
      if (never) refuse("never", `${type} is only explained in a readme (Not built here)`);
      else if (UNTAGGED_DEFAULT_TYPES.has(type)) refuse("type", `${type}: ${UNTAGGED_DEFAULT_TYPES.get(type)} carries no lab tag, and wg-admin-labs may change VPC network items and add tags only on what carries cloudlabs-lab (ruling A48); make the lab's own security group, network ACL or route table instead`);
      else if (!DEFERRED[type] && !AWS_TYPES.has(type)) refuse("type", `${type} is not on AWS_TYPES: add it with its reason (ruling 21)`);
      else if (CONFIG_TYPES.has(type) && !AWS_CONFIG_LABS.includes(labId)) refuse("type", `${type} only in ${AWS_CONFIG_LABS.join(", ")} (one Config recorder per region per account)`);
      else if (type === "aws_accessanalyzer_analyzer" && !ACCESS_ANALYZER_LABS.includes(labId)) refuse("type", `an Access Analyzer analyzer only in ${ACCESS_ANALYZER_LABS.join(", ")} (one account analyzer per region per account; ruling P14)`);
      else if (type === "aws_accessanalyzer_analyzer" && typeof v.type === "string" && v.type !== "ACCOUNT") refuse("type", `analyzer type ${v.type}: only ACCOUNT (organization analyzers need Organizations; unused-access analyzers are paid; ruling P14)`);
      const tenancies = [v.tenancy, v.instance_tenancy, ...list(v.placement).map((p) => (isObj(p) ? p.tenancy : undefined))];
      if (tenancies.some((t) => t === "dedicated" || t === "host")) refuse("never", "dedicated or host tenancy is only explained in a readme (Not built here)");
    } else {
      const why = dataProblem(r);
      if (why) refuse("type", why);
    }

    // template (ruling P4)
    if (isManaged && type === "aws_cloudformation_stack") stackProblems(r, v);

    // 6. tag (plan mode only: tags_all and the rest are known only in a real plan)
    if (mode === "plan" && isManaged) tagProblems(r, v, labId, refuse);

    // 7. untaggable
    if (isManaged && UNTAGGABLE.has(type)) {
      const attr = UNTAGGABLE.get(type);
      const want = type === "aws_kms_alias" ? `alias/${prefix}` : prefix;
      if (!startsKnown(v[attr], want)) refuse("untaggable", `${type} cannot carry the lab tag, so its ${attr} must start ${want}`);
    }
    // Ruling A56: IAM knows a new log group by its name (its tag cannot be read for its first seconds).
    if (isManaged && type === "aws_cloudwatch_log_group" && !startsKnown(v.name, `/cloudlabs/${labId}/`)) refuse("untaggable", `a log group's name must start /cloudlabs/${labId}/ (IAM cannot read a new group's tag for its first seconds, so it knows the lab's groups by name)`);
    // Rulings P3, P4, P15: what the safety net also finds by name.
    if (isManaged && (type === "aws_dynamodb_table" || type === "aws_ami_copy") && !startsKnown(v.name, prefix)) refuse("untaggable", `${type}'s name must start ${prefix}: the safety net also finds it by name (rulings P3, P4)`);
    // Preflight C2: in HCL a name built by a function (lab_${replace(...)}) is only an expression, left to the plan.
    if (isManaged && type === "aws_glue_catalog_database" && !(!plan && v.name instanceof Unknown) && !startsKnown(v.name, glueName)) refuse("untaggable", `a Glue database is named ${glueName}... (Glue takes no hyphens; ruling P15)`);

    // 8. iam
    if (isManaged) iamProblems(r, v);

    // 9. gateway
    {
      let hit = null;
      const scanned = isManaged ? v : Object.fromEntries(Object.entries(v).filter(([k]) => r.configured?.has(k)));
      walk(scanned, [], (kind, path, s) => {
        if (hit) return;
        if (GATEWAY_NAMES.test(s)) hit = `${path.join(".")} names the VPN server's ${s.match(GATEWAY_NAMES)[0]}`;
        else if (kind === "key" ? s.toLowerCase().includes("wg-admin") : s.toLowerCase().includes("wg-admin") && !BOUNDARY_RE.test(s)) hit = `${path.join(".")} holds wg-admin, the VPN server's own name`;
      });
      if (hit) refuse("gateway", hit);
      if (type === "aws_vpc_peering_connection_accepter") refuse("gateway", "a lab never accepts a peering: the pipeline peers the lab to the VPN server");
      if (type === "aws_vpc_peering_connection") {
        for (const attr of ["vpc_id", "peer_vpc_id"]) {
          if (!(v[attr] instanceof Unknown && (ownRefs(refsOf(v[attr], r, attr), ["aws_vpc"]) || (mode === "mock" && !refsOf(v[attr], r, attr).length)))) refuse("gateway", `${attr} must be one of the lab's own VPCs, by reference (aws_vpc.<name>.id)`);
        }
        for (const attr of ["peer_owner_id", "peer_region"]) if (r.configured?.has(attr)) refuse("gateway", `a lab's peering stays in this account and region: no ${attr}`);
      }
      // Review I-1: an alarm's EC2 action acts on instances; a lab's alarms notify (its topics) and never act on one.
      if (type === "aws_cloudwatch_metric_alarm" || type === "aws_cloudwatch_composite_alarm") {
        for (const a of ["alarm_actions", "ok_actions", "insufficient_data_actions"]) {
          for (const x of list(v[a])) {
            if (typeof x === "string" && EC2_ACTION_RE.test(x)) refuse("gateway", `${a}: an EC2 alarm action (stop, terminate, reboot, recover) acts on an instance; a lab's alarm notifies its own topic (review I-1)`);
            else if (plan && x instanceof Unknown) {
              // Re-review N-2: an action not known at plan is the lab's own topic, by reference.
              const refs = refsOf(x, r, a);
              if (!((mode === "mock" && !refs.length) || ownRefs(refs, ["aws_sns_topic"]))) refuse("gateway", `${a}: an action not known at plan must be the lab's own topic, by reference (aws_sns_topic.<name>.arn; re-review N-2)`);
            } else if (typeof x !== "string" && !(x instanceof Unknown)) refuse("gateway", `${a}: an action this check cannot read`);
          }
        }
      }
      if (plan && isManaged) {
        // A known id under an id-holding key (a list inherits its key), a target's values when its key selects ids, or an
        // EC2 ARN with a known id in it anywhere. The lab's own resources are unknown at plan, so never match.
        const named = (path, s) => refuse("gateway", `${path.join(".")} names an existing AWS resource the lab did not make${r.sensitive?.has(path[0]) ? "" : ` (${s})`}`);
        // A wildcard id, or a target selecting by tag key alone or a wildcard tag value, selects every instance, the VPN
        // server's too (final review, Important 3): a lab targets its own by reference or by its own tag values.
        const every = (path, why) => refuse("gateway", `${path.join(".")} ${why}: it would select every instance, the VPN server's too; target the lab's own by reference or by tag (tag:cloudlabs-lab = the lab id)`);
        const scan = (x, path, ids) => {
          if (typeof x === "string") {
            if (ids && x.includes("*")) every(path, `is a wildcard (${x})`);
            else if (ids && KNOWN_ID_RE.test(x) && !dataStrings.has(x)) named(path, x);
            else {
              const m = EC2_ARN_RE.exec(x);
              if (m && !dataStrings.has(m[1])) named(path, m[1]);
            }
          } else if (Array.isArray(x)) x.forEach((y, i) => scan(y, [...path, i], ids));
          else if (isObj(x)) {
            if (TARGET_TAG_KEY(x.key) && "values" in x) every([...path, "key"], `is ${x.key}`);
            else if (TARGET_TAG(x.key) && list(x.values).some((y) => typeof y === "string" && y.includes("*"))) every([...path, "values"], "is a wildcard tag value");
            for (const [k, y] of Object.entries(x)) scan(y, [...path, k], ID_KEY(k) || (k === "values" && ID_TARGET_KEY(x.key)));
          }
        };
        for (const [k, y] of Object.entries(v)) scan(y, [k], ID_KEY(k));
        // Re-review N-2: where an id goes, a value not known until apply and built from no reference (timestamp(),
        // uuid()) could hide anything; the lab's own items are always references. Only what the lab writes is read
        // (computed attributes are unknown with no references too).
        for (const k of Object.keys(v)) {
          if (!r.configured?.has(k)) continue;
          const blind = unknownLeaves(v[k], [k]).filter(([, x]) => !(x.refs?.length > 0));
          const idMap = k === "dimensions" || k === "metric_query" || (type === "aws_ssm_association" && k === "parameters");
          const input = type === "aws_cloudwatch_event_target" && (k === "input" || k === "input_transformer");
          for (const [p] of blind) {
            const last = [...p].reverse().find((x) => typeof x === "string");
            if (ID_KEY(k) || input || (idMap && (p.length === 1 || last === "dimensions" || ID_KEY(last)))) {
              refuse("gateway", `${p.join(".")} is not known at plan and built from no reference: where an id goes, a lab names its own items by reference (re-review N-2)`);
              break;
            }
          }
        }
        // Ruling P9: the instance-target allow-list.
        for (const attr of TARGET_ATTRS[type] ?? []) list(v[attr]).forEach((t, i) => {
          const why = targetWhy(t);
          if (why) refuse("gateway", `${attr}.${i}: ${why} (ruling P9)`);
        });
        // Review C-1: resource-groups:Name = lab-<id> is only as narrow as that group's query, so the lab's group is
        // lab-<id>, one tag query known at plan, selecting exactly cloudlabs-lab = the lab id.
        if (type === "aws_resourcegroups_group") {
          const why = groupWhy(v, r);
          if (why) refuse("gateway", `${why} (review C-1)`);
        }
        if (type === "aws_ssm_association" && (r.configured?.has("instance_id") || nonEmpty(v.instance_id)) && !(v.instance_id instanceof Unknown && (ownRefs(refsOf(v.instance_id, r, "instance_id"), ["aws_instance"]) || (mode === "mock" && !refsOf(v.instance_id, r, "instance_id").length)))) refuse("gateway", "instance_id must be one of the lab's own instances, by reference (ruling P9)");
        // Ruling P8: lab 09's zone, records, health checks and distributions name only the lab's own.
        const ownRef = (attr, types) => v[attr] instanceof Unknown && (ownRefs(refsOf(v[attr], r, attr), types) || (mode === "mock" && !refsOf(v[attr], r, attr).length));
        // A private zone has a vpc block (an object); anything else is public and must be the lab's own name.
        if (type === "aws_route53_zone" && !list(v.vpc).some(isObj)) {
          const want = nonEmpty(variables.name_prefix) ? `${variables.name_prefix}${LAB_ZONE_SUFFIX}` : null;
          if (!(typeof v.name === "string" && want && v.name.replace(/\.$/, "") === want)) refuse("gateway", `a public zone is named ${want ?? `<name_prefix>${LAB_ZONE_SUFFIX}`} only (never delegated; ruling A27): another name could answer for a domain someone else owns`);
        }
        if (type === "aws_route53_zone" && (r.configured?.has("delegation_set_id") || nonEmpty(v.delegation_set_id))) refuse("gateway", "delegation_set_id: a reusable delegation set outlives the lab");
        if (type === "aws_route53_record" && !ownRef("zone_id", ["aws_route53_zone"])) refuse("gateway", "zone_id must be the lab's own zone, by reference (ruling P8)");
        if (type === "aws_route53_health_check") {
          if (r.configured?.has("ip_address") || nonEmpty(v.ip_address)) refuse("gateway", "a health check probes the lab's own endpoint by name, never an address (ruling P8)");
          // Ruling P6: a CloudWatch-metric check names its alarm instead (batch3Problems reads it).
          else if (v.type !== "CALCULATED" && v.type !== "CLOUDWATCH_METRIC" && !ownRef("fqdn", ["aws_cloudfront_distribution", "aws_lb"])) refuse("gateway", "fqdn must be the lab's own distribution or load balancer, by reference (ruling P8)");
        }
        if (type === "aws_cloudfront_distribution") {
          list(v.origin).forEach((o, i) => {
            const d = isObj(o) ? o.domain_name : undefined;
            // Preflight C2: the domain's own references (origin is a set block: its whole-block references hold the
            // origin access control's too).
            const refs = d instanceof Unknown ? (d.refs ?? []) : [];
            // A known domain is the lab's own bucket's S3 name, anchored (review M-3: never a look-alike host).
            const ownBucketDomain = nonEmpty(variables.name_prefix) && new RegExp(String.raw`^cloudlabs-${escapeRe(variables.name_prefix)}-[a-z0-9.-]*\.s3\.[a-z0-9-]+\.amazonaws\.com$`);
            const ok = d instanceof Unknown ? (mode === "mock" && !refs.length) || ownRefs(refs, ["aws_s3_bucket", "aws_lb"]) : typeof d === "string" && Boolean(ownBucketDomain) && ownBucketDomain.test(d);
            if (!ok) refuse("gateway", `origin ${i}: a distribution fronts only the lab's own bucket or load balancer, by reference (ruling P8)`);
          });
        }
      }
    }

    // 10. address
    if (plan && isManaged) addressProblems(r, v, refuse);

    // 11. public
    if (isManaged) publicProblems(r, v, refuse);

    // 12. lingering
    if (isManaged) lingeringProblems(r, v, refuse);

    // 13. size
    if (isManaged) sizeProblems(r, v, refuse);

    // 14. description (AWS rejects a security group or rule description outside its character set at apply)
    if (isManaged) descriptionProblems(r, v, refuse);

    // Batch 3's reference and value rules (rules provider to size, by type; preflight C14: before the report below).
    if (isManaged) batch3Problems(r, v);

    if (found.length) out.push(found.sort((a, b) => AWS_RULES.indexOf(a.rule) - AWS_RULES.indexOf(b.rule))[0]);

    // ── the rules' details, closing over this resource's context ──

    function iamProblems(res, val) {
      if (["aws_iam_role", "aws_iam_instance_profile", "aws_iam_policy", "aws_iam_user"].includes(type)) {
        if (!skip(val.path) && val.path !== IAM_PATH) refuse("iam", `${type} must be at path ${IAM_PATH} (it is ${val.path instanceof Unknown ? "not known at plan" : JSON.stringify(val.path ?? "/")})`);
        if (!startsKnown(val.name, prefix)) refuse("iam", `${type}'s name must start ${prefix}`);
      }
      if (type === "aws_iam_role" || type === "aws_iam_user") {
        const pb = val.permissions_boundary;
        if (!(!plan && pb instanceof Unknown) && !(typeof pb === "string" && BOUNDARY_RE.test(pb))) refuse("iam", `${type} must have permissions_boundary = the wg-admin-lab-boundary policy (arn:aws:iam::<account>:policy/wg-admin-lab-boundary)${pb instanceof Unknown ? ", known at plan" : ""}`);
      }
      if (["aws_iam_user", "aws_iam_user_login_profile", "aws_iam_user_policy_attachment"].includes(type) && !AWS_IAM_USER_LABS.includes(labId)) refuse("iam", `${type} only in ${AWS_IAM_USER_LABS.join(", ")}`);
      if (type === "aws_iam_role_policy_attachment" || type === "aws_iam_user_policy_attachment") {
        const arn = val.policy_arn;
        // A mocked plan has no configuration, so an unknown policy_arn has no references to read: the plan and HCL modes check it.
        const mockUnread = mode === "mock" && arn instanceof Unknown && !(refsOf(arn, res, "policy_arn").length > 0);
        const ok = typeof arn === "string" ? MANAGED_POLICIES.includes(arn) : mockUnread || (arn instanceof Unknown && ownRefs(refsOf(arn, res, "policy_arn"), ["aws_iam_policy"]));
        if (!ok) refuse("iam", `policy_arn ${typeof arn === "string" ? arn : "(not known)"} is neither on MANAGED_POLICIES nor one of the lab's own aws_iam_policy`);
        const [who, whoType] = type === "aws_iam_role_policy_attachment" ? ["role", "aws_iam_role"] : ["user", "aws_iam_user"];
        const w = val[who];
        const own = typeof w === "string" ? w.startsWith(prefix) : w instanceof Unknown && ownRefs(refsOf(w, res, who), [whoType]);
        if (!own) refuse("iam", `${who} must be one of the lab's own (${whoType}.<name>.name, named ${prefix}*)`);
      }
      // aws_iam_role.managed_policy_arns (deprecated, still in aws 6.69) attaches policies too: each entry as policy_arn.
      // Left unset it is computed (unknown with no references) and attaches nothing the lab chose.
      const arns = val.managed_policy_arns;
      if (type === "aws_iam_role" && (res.configured?.has("managed_policy_arns") || (Array.isArray(arns) && arns.length > 0))) {
        const entryOk = (a) => (typeof a === "string" ? MANAGED_POLICIES.includes(a) : a instanceof Unknown && ownRefs(refsOf(a, res, "managed_policy_arns"), ["aws_iam_policy"]));
        const bad = arns instanceof Unknown ? (entryOk(arns) ? undefined : arns) : list(arns).find((a) => !entryOk(a));
        if (bad !== undefined) refuse("iam", `managed_policy_arns: ${typeof bad === "string" ? bad : "(not known)"} is neither on MANAGED_POLICIES nor one of the lab's own aws_iam_policy`);
      }
      if (type === "aws_iam_user_login_profile") {
        const u = val.user;
        const ownUser = typeof u === "string" ? u.startsWith(prefix) : u instanceof Unknown && (ownRefs(refsOf(u, res, "user"), ["aws_iam_user"]) || (mode === "mock" && !refsOf(u, res, "user").length));
        if (!ownUser) refuse("iam", `user must be one of the lab's own (aws_iam_user.<name>.name, named ${prefix}*)`);
        if (val.password_reset_required === true) refuse("iam", "password_reset_required: the boundary allows the user no IAM, so it could never set a new password (ruling P5)");
      }
      // A lab function, task, workflow, target, crawler, cluster, node group or replication runs as a lab role, by
      // reference (ruling P14).
      for (const [t, attr] of [["aws_lambda_function", "role"], ["aws_ecs_task_definition", "execution_role_arn"], ["aws_ecs_task_definition", "task_role_arn"], ["aws_sfn_state_machine", "role_arn"], ["aws_cloudwatch_event_target", "role_arn"], ["aws_glue_crawler", "role"], ["aws_eks_cluster", "role_arn"], ["aws_eks_node_group", "node_role_arn"], ["aws_s3_bucket_replication_configuration", "role"], ["aws_apigatewayv2_integration", "credentials_arn"], ["aws_apigatewayv2_authorizer", "authorizer_credentials_arn"]]) {
        if (type !== t || (val[attr] == null && !res.configured?.has(attr))) continue;
        const x = val[attr];
        const refs = x instanceof Unknown ? refsOf(x, res, attr) : [];
        if (!(x instanceof Unknown && (mode === "hcl" || (mode === "mock" && !refs.length) || ownRefs(refs, ["aws_iam_role"])))) refuse("iam", `${attr} must be one of the lab's own roles, by reference (aws_iam_role.<name>.arn)`);
      }
      // Identity policy documents.
      const docs = [];
      if (["aws_iam_policy", "aws_iam_role_policy", "aws_iam_user_policy"].includes(type)) docs.push(["policy", val.policy]);
      if (type === "aws_iam_role") list(val.inline_policy).forEach((p, i) => isObj(p) && p.policy !== undefined && docs.push([`inline_policy.${i}.policy`, p.policy]));
      for (const [where, d] of docs) {
        const j = jsonDoc(d);
        if (j.unknown) {
          if (plan) refuse("iam", `${where}: the policy must be known at plan: write it with jsonencode, ruling A42`);
        } else if (j.bad) refuse("iam", `${where} is not a policy document this check can read`);
        else {
          const why = permissionProblem(j.doc);
          if (why) refuse("iam", `${where}: ${why}`);
        }
      }
      if (type === "aws_iam_role") {
        const j = jsonDoc(val.assume_role_policy);
        if (j.unknown) {
          if (plan) refuse("iam", "assume_role_policy: the policy must be known at plan: write it with jsonencode, ruling A42");
        } else if (j.bad) refuse("iam", "assume_role_policy is not a policy document this check can read");
        else {
          const pb = typeof val.permissions_boundary === "string" ? /^arn:aws:iam::(\d{12}):/.exec(val.permissions_boundary)?.[1] : null;
          const why = trustProblem(j.doc, labId, callerAccount ?? pb ?? null);
          if (why) refuse("iam", `assume_role_policy: ${why}`);
        }
      }
    }

    /** Batch 3's reference and value rules (rulings P6, P7, P12–P18), one switch by type. */
    function batch3Problems(res, val) {
      /** The lab's own item of `types`, by reference (an Unknown's own references; a mocked plan has none to read). */
      const own = (x, types, attr) => {
        if (!(x instanceof Unknown)) return false;
        const refs = x.refs?.length ? x.refs : refsOf(x, res, attr);
        return (mode === "mock" && !refs.length) || ownRefs(refs, types);
      };
      const first = (x) => list(x).find(isObj) ?? {};
      const ownBucket = (s) => typeof s === "string" && nonEmpty(variables.name_prefix) && s.startsWith(`s3://cloudlabs-${variables.name_prefix}-`);
      const needOwn = (attr, types, rule, why) => {
        if (plan && !own(val[attr], types, attr)) refuse(rule, `${attr} must be ${why}, by reference`);
      };
      /** Fix round 1, I-5: a known name of one of the lab's own `t` in this configuration, or one by reference. */
      const ownNamed = (x, t, nameAttr, attr) => (typeof x === "string" ? nonEmpty(x) && [...managed.values()].some((m) => m.type === t && m.values?.[nameAttr] === x) : own(x, [t], attr));
      /**
       * Fix round 2, R2-3: a subnet group the lab makes, by its known name or by reference, and named lab-<id>-* (a lab
       * group named "default" could lose the race to the account's own default group).
       */
      const ownGroup = (x, t, attr) => {
        const named = (m) => m?.type === t && typeof m.values?.name === "string" && m.values.name.startsWith(prefix);
        if (typeof x === "string") return x.startsWith(prefix) && [...managed.values()].some((m) => named(m) && m.values.name === x);
        if (!own(x, [t], attr)) return false;
        const refs = (x.refs?.length ? x.refs : refsOf(x, res, attr)).filter((y) => !INDEX_REF.test(y));
        return refs.every((y) => named(target(y)));
      };
      /**
       * Fix round 1, I-6: a value that is `bad`, or built from references and not known at plan; fix round 2 (R2-2): for
       * a top-level `attr` the lab writes, any value not known at plan (an apply-time function has no references).
       */
      const badOr = (x, bad, attr) => bad(x) || opaque(x) || (plan && x instanceof Unknown && attr !== undefined && Boolean(res.configured?.has(attr)));
      /** A setting that brings in data from outside the lab (review M-5): set at all. */
      const outside = (attrs) => {
        for (const a of attrs) if (res.configured?.has(a) || (val[a] != null && !(val[a] instanceof Unknown) && list(val[a]).length > 0)) refuse("gateway", `${a}: a lab's ${type} starts empty, never from data outside the lab (review M-5)`);
      };
      switch (type) {
        case "aws_db_instance": {
          if (badOr(val.publicly_accessible, (x) => x === true, "publicly_accessible")) refuse("public", "publicly_accessible: a lab database is reached from the lab's own instances or the VPN, never the internet, known at plan (ruling P16)");
          // Fix round 1, I-5: unset or "default", RDS uses the default VPC; a replica in the region takes its source's group.
          const replica = val.replicate_source_db != null || res.configured?.has("replicate_source_db");
          if (plan && replica && !ownNamed(val.replicate_source_db, "aws_db_instance", "identifier", "replicate_source_db")) refuse("gateway", "replicate_source_db must be the lab's own database (its identifier, or by reference)");
          if (plan && !(replica && !res.configured?.has("db_subnet_group_name")) && !ownGroup(val.db_subnet_group_name, "aws_db_subnet_group", "db_subnet_group_name")) refuse("gateway", "db_subnet_group_name must be the lab's own subnet group (unset or default is the default VPC)");
          break;
        }
        case "aws_lambda_permission":
          needOwn("source_arn", ["aws_apigatewayv2_api", "aws_cloudwatch_event_rule", "aws_sns_topic", "aws_s3_bucket", "aws_secretsmanager_secret"], "public", "built from the lab's own API, rule, topic, bucket or secret (ruling P13)");
          break;
        case "aws_cloudwatch_event_target":
          needOwn("arn", ["aws_sns_topic", "aws_sqs_queue", "aws_lambda_function", "aws_sfn_state_machine", "aws_kinesis_stream", "aws_cloudwatch_log_group"], "gateway", "the lab's own topic, queue, function, state machine, stream or log group (ruling P14)");
          break;
        case "aws_sns_topic_subscription":
          if (!["sqs", "lambda"].includes(val.protocol)) refuse("gateway", `protocol ${JSON.stringify(val.protocol ?? null)}: a subscription delivers only to the lab's own queue or function (ruling P14)`);
          needOwn("endpoint", ["aws_sqs_queue", "aws_lambda_function"], "gateway", "the lab's own queue or function (ruling P14)");
          needOwn("topic_arn", ["aws_sns_topic"], "gateway", "the lab's own topic");
          break;
        case "aws_sfn_state_machine": {
          const j = jsonDoc(val.definition);
          if (j.unknown) {
            if (plan) refuse("gateway", "definition must be known at plan, so what it calls can be read (ruling P14)");
          } else if (j.bad) refuse("gateway", `definition is not JSON this check can read${j.why ? ` (${j.why})` : ""}`);
          else {
            // Fix round 1, I-2: the lab's own account (the caller identity; a mocked plan's, its roles' boundary's) and regions.
            const account = callerAccount ?? (mode === "mock" ? (boundaryAccount ?? undefined) : null);
            const why = workflowProblem(j.doc, labId, plan ? { account, regions: [...knownRegions].filter((x) => !GLOBAL_REGIONS.includes(x)) } : {});
            if (why) refuse("gateway", `definition: ${why} (ruling P14)`);
          }
          break;
        }
        case "aws_kinesis_firehose_delivery_stream": {
          if (val.destination !== "extended_s3") refuse("gateway", `destination ${JSON.stringify(val.destination ?? null)}: only extended_s3, the lab's own bucket (ruling P14)`);
          const src = first(val.kinesis_source_configuration);
          const s3 = first(val.extended_s3_configuration);
          if (plan && !(own(src.kinesis_stream_arn, ["aws_kinesis_stream"], "kinesis_source_configuration") && own(s3.bucket_arn, ["aws_s3_bucket"], "extended_s3_configuration"))) refuse("gateway", "the source stream and the destination bucket must be the lab's own, by reference (ruling P14)");
          for (const [blk, b] of [["kinesis_source_configuration", src], ["extended_s3_configuration", s3]]) if (plan && !own(b.role_arn, ["aws_iam_role"], blk)) refuse("iam", `${blk}.role_arn must be one of the lab's own roles, by reference`);
          if (badOr(first(s3.cloudwatch_logging_options).enabled, (x) => x === true)) refuse("lingering", "cloudwatch_logging_options.enabled: Firehose would make its own log group outside /cloudlabs/, known at plan (ruling P15)");
          // Fix round 1, I-4: nothing else may receive the records: no backup copy, no processor, no format conversion
          // (its schema role and catalogue), no other destination block.
          for (const [blk, v2] of [["extended_s3_configuration.s3_backup_configuration", s3.s3_backup_configuration], ...["elasticsearch_configuration", "http_endpoint_configuration", "iceberg_configuration", "msk_source_configuration", "opensearch_configuration", "opensearchserverless_configuration", "redshift_configuration", "snowflake_configuration", "splunk_configuration"].map((k) => [k, val[k]])]) {
            if (list(v2).length || blockUnknown(v2)) refuse("gateway", `${blk}: a lab's stream delivers only to the lab's own bucket (ruling P14)`);
          }
          const pc = list(s3.processing_configuration);
          if (blockUnknown(s3.processing_configuration) || pc.some((p) => isObj(p) && (list(p.processors).length > 0 || blockUnknown(p.processors)))) refuse("gateway", "extended_s3_configuration.processing_configuration: a processor (another function) would see every record (ruling P14)");
          const dfc = list(s3.data_format_conversion_configuration);
          if (blockUnknown(s3.data_format_conversion_configuration) || dfc.some((d) => isObj(d) && d.enabled !== false)) refuse("gateway", "extended_s3_configuration.data_format_conversion_configuration: its schema role and catalogue reach outside the lab (ruling P14)");
          break;
        }
        case "aws_glue_crawler": {
          for (const t of ["jdbc_target", "dynamodb_target", "catalog_target", "mongodb_target", "delta_target", "iceberg_target", "hudi_target"]) if (list(val[t]).some(isObj) || blockUnknown(val[t])) refuse("gateway", `${t}: a lab's crawler reads only the lab's own bucket (ruling P14)`);
          const paths = list(val.s3_target).map((t) => (isObj(t) ? t.path : undefined));
          if (plan && !(paths.length > 0 && paths.every(ownBucket))) refuse("gateway", `every s3_target path must start s3://cloudlabs-${variables.name_prefix ?? "<name_prefix>"}- (ruling P14)`);
          if (list(val.lake_formation_configuration).some((x) => isObj(x) && x.account_id != null)) refuse("gateway", "lake_formation_configuration.account_id: another account's lake (review M-5)");
          if (badOr(val.schedule, nonEmpty, "schedule")) refuse("size", "schedule: every crawler run is billed; a lab's crawler runs by hand, known at plan (ruling P15)");
          // Preflight C2: in HCL a name that is only an expression is left to the plan.
          if (!(!plan && val.database_name instanceof Unknown) && !startsKnown(val.database_name, glueName) && !(plan && own(val.database_name, ["aws_glue_catalog_database"], "database_name"))) refuse("gateway", `database_name must be the lab's own database (${glueName})`);
          break;
        }
        case "aws_athena_workgroup": {
          const cfg = first(val.configuration);
          if (plan && !ownBucket(first(cfg.result_configuration).output_location)) refuse("gateway", "configuration.result_configuration.output_location must be in the lab's own bucket (ruling P14)");
          const cut = cfg.bytes_scanned_cutoff_per_query;
          if (!(typeof cut === "number" && cut <= 1073741824)) refuse("size", "configuration.bytes_scanned_cutoff_per_query must be set, at most 1 GiB (ruling P15)");
          if (cfg.enforce_workgroup_configuration !== true) refuse("size", "configuration.enforce_workgroup_configuration must be true, so no query skips the cut-off (ruling P15)");
          break;
        }
        case "aws_route53_zone":
          // Fix round 1, I-3: a vpc block not known at plan could make any zone private on any VPC.
          if (blockUnknown(val.vpc)) refuse("gateway", "vpc is not known at plan (a dynamic block): write each of the lab's own VPCs (ruling P6)");
          if (list(val.vpc).some(isObj)) {
            // Review M-3: a name not known at plan cannot be read.
            if (badOr(val.name, () => false, "name")) refuse("gateway", "a private zone's name must be known at plan, *.internal (ruling P6)");
            if (typeof val.name === "string" && !/\.internal\.?$/.test(val.name)) refuse("gateway", `a private zone is named *.internal, never a real domain (it is ${JSON.stringify(val.name)}; ruling P6)`);
            list(val.vpc).forEach((z, i) => {
              if (plan && isObj(z) && !own(z.vpc_id, ["aws_vpc"], "vpc")) refuse("gateway", `vpc.${i}.vpc_id must be one of the lab's own VPCs, by reference (ruling P6)`);
            });
          }
          break;
        case "aws_route53_health_check":
          if (val.type === "CLOUDWATCH_METRIC") {
            const a = val.cloudwatch_alarm_name;
            if (!(typeof a === "string" ? a.startsWith(prefix) : !plan || own(a, ["aws_cloudwatch_metric_alarm"], "cloudwatch_alarm_name"))) refuse("gateway", `cloudwatch_alarm_name must be the lab's own alarm, named ${prefix}* (ruling P6)`);
          }
          break;
        case "aws_vpc_endpoint_policy": {
          needOwn("vpc_endpoint_id", ["aws_vpc_endpoint"], "gateway", "one of the lab's own endpoints (ruling P18)");
          const j = jsonDoc(val.policy);
          if (j.unknown) {
            if (plan) refuse("public", "policy must be known at plan (ruling P18)");
          } else if (j.bad) refuse("public", `policy is not a document this check can read${j.why ? ` (${j.why})` : ""}`);
          else {
            const why = endpointPolicyProblem(j.doc, variables.name_prefix, variables.region);
            if (why) refuse("public", `policy: ${why} (ruling P18)`);
          }
          break;
        }
        case "aws_ami_copy": {
          const src = val.source_ami_id;
          // Review M-1: a known id read by the public parameter (or an Amazon AMI lookup) only, or an expression built
          // only from the parameter.
          const srcRefs = src instanceof Unknown ? refsOf(src, res, "source_ami_id") : [];
          const fromParam = typeof src === "string" ? amiStrings.has(src) : srcRefs.length > 0 && srcRefs.every((x) => x.startsWith("data.aws_ssm_parameter."));
          // A mocked plan's stream holds no data sources, so the parameter's value cannot be read there (lab 16, Task 12):
          // a known id is left to the plan mode (lab-aws.yml) and the HCL mode, which refuses a literal id.
          const mockUnread = mode === "mock" && typeof src === "string" && !data.some((d) => d.type === "aws_ssm_parameter" || d.type === "aws_ami");
          if (!fromParam && !mockUnread && !(!plan && src instanceof Unknown)) refuse("gateway", "source_ami_id must be AWS's own AMI from the public SSM parameter (data.aws_ssm_parameter under /aws/service/; ruling P4)");
          break;
        }
        case "aws_dynamodb_table":
          if (val.billing_mode !== "PAY_PER_REQUEST") refuse("size", `billing_mode ${JSON.stringify(val.billing_mode ?? "PROVISIONED")}: only PAY_PER_REQUEST (ruling P12)`);
          outside(["import_table", "restore_source_name", "restore_source_table_arn", "restore_date_time", "restore_to_latest_time"]);
          break;
        case "aws_s3_bucket_server_side_encryption_configuration":
          for (const ru of list(val.rule)) for (const d of list(isObj(ru) ? ru.apply_server_side_encryption_by_default : [])) {
            if (isObj(d) && d.kms_master_key_id != null && plan && !own(d.kms_master_key_id, ["aws_kms_key"], "rule")) refuse("gateway", "kms_master_key_id must be the lab's own key, by reference");
          }
          break;
        case "aws_apigatewayv2_api":
          for (const k of ["body", "target", "route_key", "credentials_arn"]) if (res.configured?.has(k) || nonEmpty(val[k])) refuse("gateway", `${k}: a lab's API is built from its own routes and integrations, never imported or quick-created (ruling P12)`);
          break;
        case "aws_apigatewayv2_integration":
          if (val.integration_type !== "AWS_PROXY") refuse("gateway", `integration_type ${JSON.stringify(val.integration_type ?? null)}: only AWS_PROXY to the lab's own function (an HTTP proxy relays to anywhere; ruling P12)`);
          else needOwn("integration_uri", ["aws_lambda_function"], "gateway", "the lab's own function (ruling P12)");
          needOwn("api_id", ["aws_apigatewayv2_api"], "gateway", "the lab's own API");
          break;
        case "aws_apigatewayv2_authorizer": {
          const jwt = first(val.jwt_configuration);
          const aud = list(jwt.audience);
          // Review M-2: a type not known at plan would skip the JWT check.
          if (badOr(val.authorizer_type, () => false, "authorizer_type")) refuse("gateway", "authorizer_type must be known at plan (ruling P12)");
          if (val.authorizer_type === "JWT" && plan && !(own(jwt.issuer, ["aws_cognito_user_pool"], "jwt_configuration") && aud.length > 0 && aud.every((x) => own(x, ["aws_cognito_user_pool_client"], "jwt_configuration")))) refuse("gateway", "a JWT authoriser trusts only the lab's own user pool and app client, by reference (ruling P12)");
          if (val.authorizer_type === "REQUEST") needOwn("authorizer_uri", ["aws_lambda_function"], "gateway", "the lab's own function");
          needOwn("api_id", ["aws_apigatewayv2_api"], "gateway", "the lab's own API");
          break;
        }
        case "aws_apigatewayv2_route":
          needOwn("api_id", ["aws_apigatewayv2_api"], "gateway", "the lab's own API");
          if (val.target != null) needOwn("target", ["aws_apigatewayv2_integration"], "gateway", "the lab's own integration");
          break;
        case "aws_apigatewayv2_stage": {
          needOwn("api_id", ["aws_apigatewayv2_api"], "gateway", "the lab's own API");
          const s = first(val.default_route_settings);
          const capped = (x) => typeof x.throttling_burst_limit === "number" && x.throttling_burst_limit <= 20 && typeof x.throttling_rate_limit === "number" && x.throttling_rate_limit <= 10;
          if (!capped(s)) refuse("size", "default_route_settings must throttle the API to at most 20 burst and 10 requests a second (ruling P12)");
          // Review M-2: a route's own settings replace the default, so each is capped too (unset: the default holds).
          for (const x of list(val.route_settings)) {
            if (!isObj(x)) refuse("size", "route_settings must be known at plan (ruling P12)");
            else if ((x.throttling_burst_limit != null || x.throttling_rate_limit != null) && !capped(x)) refuse("size", `route_settings ${JSON.stringify(x.route_key ?? null)} must throttle at most 20 burst and 10 requests a second (ruling P12)`);
          }
          break;
        }
        case "aws_cognito_user_pool":
          if (badOr(val.user_pool_tier, (x) => x === "PLUS", "user_pool_tier")) refuse("size", "user_pool_tier PLUS is billed per user: LITE, known at plan (ruling P12)");
          if (badOr(val.deletion_protection, (x) => x === "ACTIVE", "deletion_protection")) refuse("lingering", "deletion_protection must be INACTIVE so tear-down can delete the pool, known at plan");
          break;
        case "aws_cognito_user_pool_client":
        case "aws_cognito_user":
          needOwn("user_pool_id", ["aws_cognito_user_pool"], "gateway", "the lab's own user pool");
          break;
        case "aws_efs_file_system":
          if (badOr(val.throughput_mode, (x) => x === "provisioned", "throughput_mode")) refuse("size", "provisioned throughput bills by the hour: bursting or elastic, known at plan");
          break;
        case "aws_efs_mount_target":
          needOwn("file_system_id", ["aws_efs_file_system"], "gateway", "the lab's own file system");
          break;
        case "aws_elasticache_cluster":
        case "aws_elasticache_replication_group":
          if (badOr(val.num_cache_clusters, (x) => typeof x === "number" && x > 2, "num_cache_clusters")) refuse("size", `num_cache_clusters ${JSON.stringify(val.num_cache_clusters instanceof Unknown ? "(not known at plan)" : val.num_cache_clusters)} is over 2 (ruling P17)`);
          if (badOr(val.num_node_groups, (x) => typeof x === "number" && x > 1, "num_node_groups")) refuse("size", "num_node_groups: one node group, known at plan (ruling P17)");
          if (badOr(val.final_snapshot_identifier, nonEmpty, "final_snapshot_identifier")) refuse("lingering", "final_snapshot_identifier keeps a snapshot after tear-down (ruling P17)");
          // Fix round 1, I-5: unset or "default", ElastiCache uses the default VPC's subnet group (a cluster in a
          // replication group takes the group's).
          if (plan && !(type === "aws_elasticache_cluster" && val.replication_group_id != null) && !ownGroup(val.subnet_group_name, "aws_elasticache_subnet_group", "subnet_group_name")) refuse("gateway", "subnet_group_name must be the lab's own subnet group (unset or default is the default VPC)");
          outside(["snapshot_arns", "snapshot_name"]);
          break;
        case "aws_eks_cluster": {
          const ac = first(val.access_config);
          if (ac.bootstrap_cluster_creator_admin_permissions !== false || ac.authentication_mode !== "API") refuse("iam", "access_config: authentication_mode = API and bootstrap_cluster_creator_admin_permissions = false: the pipeline's role never holds Kubernetes admin (ruling P7)");
          if (list(val.enabled_cluster_log_types).length) refuse("lingering", "enabled_cluster_log_types: EKS would make /aws/eks/<cluster>/cluster, untagged and outside /cloudlabs/ (ruling P7)");
          if (first(val.upgrade_policy).support_type !== "STANDARD") refuse("size", "upgrade_policy.support_type must be STANDARD: extended support bills $0.60 an hour (ruling P7)");
          if (list(val.compute_config).some((x) => isObj(x) && badOr(x.enabled, (e) => e === true))) refuse("size", "compute_config: EKS Auto Mode bills per instance on top, known at plan (ruling P7)");
          if (blockUnknown(val.remote_network_config) || list(val.remote_network_config).some(isObj)) refuse("gateway", "remote_network_config reaches networks outside the lab");
          if (plan && !own(first(val.vpc_config).subnet_ids, ["aws_subnet"], "vpc_config")) refuse("gateway", "vpc_config.subnet_ids must be the lab's own subnets, by reference");
          break;
        }
        case "aws_glue_catalog_database":
          // Review M-5: a database linked to another catalogue or account.
          outside(["target_database", "federated_database"]);
          if (res.configured?.has("catalog_id")) refuse("gateway", "catalog_id: the lab's database is in the account's own catalogue (review M-5)");
          break;
        case "aws_eks_node_group":
          if (blockUnknown(val.remote_access) || list(val.remote_access).some(isObj)) refuse("public", "remote_access opens SSH to the nodes; reach them through the cluster (ruling P7)");
          // Preflight C2: in HCL aws_eks_cluster.lab.name is only an expression, left to the plan.
          if (!(!plan && val.cluster_name instanceof Unknown) && !(val.cluster_name === `lab-${labId}` || (plan && own(val.cluster_name, ["aws_eks_cluster"], "cluster_name")))) refuse("gateway", `cluster_name must be the lab's own cluster, lab-${labId}`);
          break;
        default:
      }
    }

    function stackProblems(res, val) {
      const no = (m) => refuse("template", m);
      if (res.configured?.has("template_url") || nonEmpty(val.template_url)) no('template_url: the template is the lab\'s own, template_body = jsonencode(yamldecode(file("${path.module}/cfn/stack.yaml")))');
      if (!startsKnown(val.name, prefix)) no(`the stack's name must start ${prefix} (CloudFormation names what it makes from it)`);
      const caps = list(val.capabilities).filter((x) => typeof x === "string");
      if (caps.length) no(`capabilities ${caps.join(", ")}: a lab's stack makes no IAM and runs no macros`);
      // Review I-4: what is not known at plan cannot be read, so it is refused (HCL leaves expressions to the plan).
      if (plan && (val.capabilities instanceof Unknown || list(val.capabilities).some((x) => typeof x !== "string"))) no("capabilities must be known at plan (none): a lab's stack makes no IAM and runs no macros");
      if (plan && val.parameters instanceof Unknown && (res.configured?.has("parameters") || opaque(val.parameters))) no("parameters must be known at plan: the template is judged with the values the stack gives it (review I-4)");
      if (plan && isObj(val.parameters) && Object.values(val.parameters).some((x) => x instanceof Unknown)) no("parameters: every value must be known at plan, so the template can be judged with it (re-review N-1)");
      const role = val.iam_role_arn;
      const roleRefs = role instanceof Unknown ? refsOf(role, res, "iam_role_arn") : [];
      const roleOk = role instanceof Unknown && (mode === "hcl" || (mode === "mock" && !roleRefs.length) || ownRefs(roleRefs, ["aws_iam_role"]));
      if (!roleOk) no("iam_role_arn must be the lab's own service role, by reference (aws_iam_role.<name>.arn; ruling P4)");
      const body = val.template_body;
      if (body instanceof Unknown) {
        if (plan) no("template_body must be known at plan: jsonencode(yamldecode(file(...)))");
        return;
      }
      const j = jsonDoc(body);
      if (j.bad) return no(`template_body is not JSON this check can read${j.why ? ` (${j.why})` : ""}: write template_body = jsonencode(yamldecode(file(...)))`);
      for (const m of cfnTemplateProblems(j.doc, { labId, parameters: isObj(val.parameters) ? val.parameters : {} })) no(m);
      // Review I-1: the template's strings, and the parameters' values (re-review N-1), get the known-id check
      // Terraform values get, and no EC2 alarm action.
      walk({ ...j.doc, "(parameters)": isObj(val.parameters) ? val.parameters : {} }, [], (kind, path, s) => {
        if (kind !== "string") return;
        const arn = EC2_ARN_RE.exec(s);
        if (KNOWN_ID_RE.test(s) && !dataStrings.has(s)) no(`${path.join(".")} names an existing AWS resource the lab did not make (${s})`);
        else if (arn && !dataStrings.has(arn[1])) no(`${path.join(".")} names an existing AWS resource the lab did not make (${arn[1]})`);
        else if (EC2_ACTION_RE.test(s)) no(`${path.join(".")}: an EC2 alarm action (stop, terminate, reboot, recover) acts on an instance; a lab's alarm notifies its own topic`);
      });
    }

    /** Review C-1: why the lab's resource group may not stand behind resource-groups:Name = lab-<id>, or null. */
    function groupWhy(val, res) {
      if (val.name !== `lab-${labId}`) return `a lab's resource group is lab-${labId} only, its name known at plan (instance targets select by it; ruling P9)`;
      if (res.configured?.has("configuration") || list(val.configuration).some(isObj)) return "a lab's resource group is a tag query, never a configuration group";
      const q = list(val.resource_query);
      if (q.length !== 1 || !isObj(q[0]) || q[0].type !== "TAG_FILTERS_1_0") return "resource_query must be one TAG_FILTERS_1_0 query";
      const j = jsonDoc(q[0].query);
      if (j.why) return `resource_query's query: ${j.why}`;
      const tf = j.doc?.TagFilters;
      const exact = Array.isArray(tf) && tf.length === 1 && isObj(tf[0]) && Object.keys(tf[0]).sort().join() === "Key,Values" && tf[0].Key === LAB_TAG && Array.isArray(tf[0].Values) && tf[0].Values.length === 1 && tf[0].Values[0] === labId;
      return exact ? null : `resource_query's TagFilters must be exactly [{ Key = "${LAB_TAG}", Values = [var.lab_id] }], known at plan`;
    }

    /** Ruling P9: why one { key, values } target may not be used, or null. */
    function targetWhy(t) {
      if (!isObj(t) || typeof t.key !== "string") return "a target this check cannot read";
      const key = t.key;
      const known = list(t.values).filter((x) => typeof x === "string");
      // A tag or group selector is read only when every value is known (one not known until apply could be anything).
      const allKnown = known.length > 0 && known.length === list(t.values).length;
      // Preflight C1: the values' own references (planResources keys r.refs by top-level attribute only).
      const vals = t.values;
      const refs = vals instanceof Unknown ? (vals.refs ?? []) : list(vals).flatMap((x) => (x instanceof Unknown ? (x.refs ?? []) : []));
      if (key === "InstanceIds" || key === "WindowTargetIds") {
        const own = key === "InstanceIds" ? ["aws_instance"] : ["aws_ssm_maintenance_window_target"];
        if (known.length) return `${key} must name the lab's own by reference, never a literal`;
        return (mode === "mock" && !refs.length) || ownRefs(refs, own) ? null : `${key} must name the lab's own ${own[0]} by reference`;
      }
      if (key === `tag:${LAB_TAG}`) return allKnown && known.every((x) => x === labId) ? null : `tag:${LAB_TAG} must be exactly the lab's id`;
      if (/^tag:/i.test(key)) return allKnown && known.every((x) => x.startsWith(prefix) && !/[*?]/.test(x)) ? null : `${key}'s values must each start ${prefix}, a tag value only the lab gives`;
      if (key === "resource-groups:Name") return allKnown && known.length === 1 && known[0] === `lab-${labId}` ? null : `resource-groups:Name must be the lab's own group, lab-${labId}`;
      return `${key} is not a target a lab may use: InstanceIds or WindowTargetIds by reference, tag:${LAB_TAG} = the lab id, a tag valued ${prefix}*, or resource-groups:Name = lab-${labId}`;
    }

    function addressProblems(res, val, no) {
      const slot = variables.address_space;
      const gw = variables.gateway_cidr;
      const inSlot = (c) => nonEmpty(slot) && inside(c, slot);
      const routeOk = (c) => c === "0.0.0.0/0" || inSlot(c) || (nonEmpty(gw) && inside(c, gw));
      if (["aws_vpc", "aws_vpc_ipv4_cidr_block_association", "aws_subnet"].includes(type)) {
        const cb = val.cidr_block;
        if (cb instanceof Unknown) no("address", "cidr_block is not known at plan: build it with cidrsubnet(var.address_space, …)");
        else if (cb == null) {
          if (type !== "aws_subnet") no("address", "a VPC's cidr_block must be set, from cidrsubnet(var.address_space, …)");
        } else if (!nonEmpty(slot)) no("address", "the plan has no address_space variable, so this range cannot be checked against the lab's slot");
        else if (!inSlot(cb)) no("address", `cidr_block ${cb} is outside the lab's slot ${slot}`);
        else if (type !== "aws_subnet") {
          const clash = vpcRanges.find((x) => overlaps(x.cidr, cb));
          if (clash) no("address", `cidr_block ${cb} overlaps ${clash.address}'s ${clash.cidr}`);
          vpcRanges.push({ address: res.address, cidr: cb });
        }
      }
      if (type === "aws_route") {
        const d = val.destination_cidr_block;
        if (typeof d === "string" && d !== "" && !routeOk(d)) no("address", `a route to ${d}: only the lab's slot, var.gateway_cidr or 0.0.0.0/0`);
        else if (opaque(d)) no("address", "destination_cidr_block is not known at plan");
        const d6 = val.destination_ipv6_cidr_block;
        if (nonEmpty(d6) && d6 !== "::/0") no("address", `an IPv6 route to ${d6}: only ::/0`);
      }
      if (type === "aws_route_table" && Array.isArray(val.route)) {
        for (const rt of val.route) {
          if (!isObj(rt)) continue;
          if (nonEmpty(rt.cidr_block) && !routeOk(rt.cidr_block)) no("address", `a route to ${rt.cidr_block}: only the lab's slot, var.gateway_cidr or 0.0.0.0/0`);
          if (nonEmpty(rt.ipv6_cidr_block) && rt.ipv6_cidr_block !== "::/0") no("address", `an IPv6 route to ${rt.ipv6_cidr_block}: only ::/0`);
        }
      }
      if ((res.configured?.has("ipv6_ipam_pool_id") || nonEmpty(val.ipv6_ipam_pool_id)) && labId !== IPAM_LAB) no("address", `an IPv6 IPAM pool only in ${IPAM_LAB}`);
    }

    function descriptionProblems(res, val, no) {
      const type = res.type;
      const check = (where, d) => {
        if (typeof d !== "string") return;
        const bad = [...new Set([...d].filter((ch) => !SG_DESCRIPTION_CHAR.test(ch)))];
        if (bad.length) no("description", `${where} ${JSON.stringify(d)} has ${bad.map((x) => JSON.stringify(x)).join(", ")}: AWS accepts only a-zA-Z0-9 and . _-:/()#,@[]+=&;{}!$* (no apostrophe), or the apply fails`);
        if (d.length >= 256) no("description", `${where} is ${d.length} characters: AWS accepts fewer than 256`);
      };
      if (type === "aws_security_group") {
        check("description", val.description);
        for (const dir of ["ingress", "egress"]) for (const b of list(val[dir])) if (isObj(b)) check(`${dir} description`, b.description);
      }
      if (["aws_security_group_rule", "aws_vpc_security_group_ingress_rule", "aws_vpc_security_group_egress_rule"].includes(type)) check("description", val.description);
    }

    function publicProblems(res, val, no) {
      const publicLab = PUBLIC_INSTANCE_LABS.includes(labId);
      const why = `a public IPv4 only in ${PUBLIC_INSTANCE_LABS.join(", ")} (AWS labs spec §7.4)`;
      if (!publicLab) {
        if (type === "aws_instance" && val.associate_public_ip_address === true) no("public", `associate_public_ip_address: ${why}`);
        if (type === "aws_launch_template" && list(val.network_interfaces).some((n) => isObj(n) && (n.associate_public_ip_address === true || n.associate_public_ip_address === "true"))) no("public", `network_interfaces.associate_public_ip_address: ${why}`);
        if (type === "aws_eip" && ["instance", "network_interface"].some((k) => res.configured?.has(k) || nonEmpty(val[k]))) no("public", `an Elastic IP on an instance or interface: ${why}`);
        if (type === "aws_eip_association") no("public", `an Elastic IP association: ${why}`);
      }
      if (type === "aws_subnet" && val.map_public_ip_on_launch === true) no("public", "map_public_ip_on_launch: a lab subnet never gives instances public addresses");
      // SSH from the internet (spec §7.4: never).
      const ssh = (proto, from, to) => {
        const p = String(proto ?? "").toLowerCase();
        if (p === "-1" || p === "all") return true;
        if (p !== "tcp" && p !== "6") return false;
        return !(typeof from === "number" && typeof to === "number") || (from <= 22 && 22 <= to);
      };
      const rules = [];
      if (type === "aws_vpc_security_group_ingress_rule") rules.push({ cidrs: [val.cidr_ipv4, val.cidr_ipv6], proto: val.ip_protocol, from: val.from_port, to: val.to_port });
      if (type === "aws_security_group") for (const i of list(val.ingress)) if (isObj(i)) rules.push({ cidrs: [...list(i.cidr_blocks), ...list(i.ipv6_cidr_blocks)], proto: i.protocol, from: i.from_port, to: i.to_port });
      if (type === "aws_security_group_rule" && val.type === "ingress") rules.push({ cidrs: [...list(val.cidr_blocks), ...list(val.ipv6_cidr_blocks)], proto: val.protocol, from: val.from_port, to: val.to_port });
      for (const x of rules) {
        const open = x.cidrs.find(fromInternet);
        if (open && ssh(x.proto, x.from, x.to)) no("public", `it admits SSH (TCP 22) from ${open}: never from the internet (AWS labs spec §7.4)`);
      }
      // Ruling P10: who a resource policy lets in, and who may invoke a lab function. A topic's or secret's own policy
      // is read too when the lab writes one (preflight C12; left unset it is computed). An unset key policy is AWS's
      // default (computed: unknown with no references), which grants the account root only.
      // Task 3 fix round 1, I-1: a queue's own policy too (batch 3 allows aws_sqs_queue).
      const inlineAttr = INLINE_POLICIES.get(type);
      const inline = inlineAttr && res.configured?.has(inlineAttr) ? inlineAttr : null;
      const docAttr = RESOURCE_POLICIES.get(type) ?? inline;
      // A mocked plan's stream holds no data sources (no caller identity): there the lab's own account is the one in
      // its roles' boundary. A real plan always reads the caller identity (the template's main.tf).
      const policyAccount = callerAccount ?? (mode === "mock" ? boundaryAccount : null);
      if (docAttr && !(type === "aws_kms_key" && kmsDefaultPolicy(val.policy, res))) {
        const j = jsonDoc(val[docAttr]);
        if (j.unknown) {
          if (plan) no("public", `${docAttr} must be known at plan, so who it lets in can be read (ruling P10)`);
        } else if (j.bad) no("public", `${docAttr} is not a policy document this check can read${j.why ? ` (${j.why})` : ""}`);
        else {
          const why = resourcePolicyProblem(j.doc, policyAccount);
          if (why) no("public", `${docAttr}: ${why} (ruling P10)`);
        }
      }
      if (type === "aws_lambda_permission") {
        // Review I-2: a principal or URL auth not known at plan cannot be read, so it is refused (HCL leaves it to the plan).
        const p = val.principal;
        if (typeof p === "string" ? !SERVICE_PRINCIPAL.test(p) : plan) no("public", "principal: a lab function is invoked only by AWS services, named at plan (ruling P10)");
        const fua = val.function_url_auth_type;
        if (fua === "NONE") no("public", "a function URL with no auth is open to the internet");
        else if ((fua != null || res.configured?.has("function_url_auth_type")) && fua !== "AWS_IAM" && !(!plan && fua instanceof Unknown)) no("public", "function_url_auth_type must be AWS_IAM, known at plan (review I-2)");
      }
      if (type === "aws_ecs_service" && list(val.network_configuration).some((n) => isObj(n) && n.assign_public_ip === true)) no("public", "assign_public_ip: tasks reach out through the lab's NAT gateway, never from a public address");
    }

    function lingeringProblems(res, val, no) {
      /** A setting that must be `want`; in HCL an absent one is the provider's default `dflt` (or left to the plan). */
      const must = (attr, want, dflt) => {
        let x = val[attr];
        if (!plan && x instanceof Unknown) return;
        if (!plan && x === undefined) {
          if (dflt === undefined) return;
          x = dflt;
        }
        if (x !== want) no("lingering", `${attr} must be ${JSON.stringify(want)} so tear-down leaves nothing behind (it is ${x instanceof Unknown ? "not known at plan" : JSON.stringify(x ?? null)})`);
      };
      /** A protection that must not be on (unset is off; a plan value built from unknowns cannot be shown off). */
      const off = (attr) => {
        const x = val[attr];
        if (x === true || x === "true" || opaque(x)) no("lingering", `${attr} must be off so tear-down can delete it`);
      };
      /** A log destination that is a log group this configuration declares. */
      const groups = [...managed.values()].filter((g) => g.type === "aws_cloudwatch_log_group");
      const groupNames = new Set(groups.map((g) => g.values?.name).filter(nonEmpty));
      const ownGroup = (x, attr) => (x instanceof Unknown ? ownRefs(refsOf(x, res, attr), ["aws_cloudwatch_log_group"]) : nonEmpty(x) && (groupNames.has(x) || groupNames.has(x.replace(/^arn:aws[a-z-]*:logs:[^:]*:\d{12}:log-group:/, "").replace(/:\*$/, ""))));
      switch (type) {
        case "aws_db_instance":
        case "aws_rds_cluster":
          must("skip_final_snapshot", true, false);
          must("deletion_protection", false);
          must("delete_automated_backups", true, true);
          break;
        case "aws_s3_bucket":
          must("force_destroy", true, false);
          if (val.object_lock_enabled === true) no("lingering", "object_lock_enabled: locked objects cannot be deleted");
          break;
        case "aws_secretsmanager_secret":
          must("recovery_window_in_days", 0, 30);
          break;
        case "aws_kms_key": {
          must("deletion_window_in_days", 7, 30);
          if (val.bypass_policy_lockout_safety_check === true) no("lingering", "bypass_policy_lockout_safety_check could lock the account out of the key");
          // Left unset, AWS's default key policy grants the account root kms:* (the grant this rule asks for).
          if (!kmsDefaultPolicy(val.policy, res)) {
            const j = jsonDoc(val.policy);
            if (j.unknown) {
              if (plan) no("lingering", "the key policy must be known at plan (it must grant the account root kms:*)");
            } else if (j.bad || !grantsRoot(j.doc)) no("lingering", "the key policy must grant the account root (arn:aws:iam::<account>:root) kms:*, so the key can always be deleted");
          }
          break;
        }
        case "aws_cloudwatch_log_group": {
          let days = val.retention_in_days;
          if (!plan && days === undefined) days = 0;
          if (!skip(days) && !(typeof days === "number" && days >= 1 && days <= 7)) no("lingering", `retention_in_days must be 1 to 7 (it is ${days instanceof Unknown ? "not known at plan" : JSON.stringify(days ?? 0)})`);
          off("skip_destroy");
          off("deletion_protection_enabled");
          break;
        }
        case "aws_lambda_function": {
          const name = val.function_name;
          const lc = list(val.logging_config).find(isObj);
          const ok = (lc && ownGroup(lc.log_group, "logging_config")) || (nonEmpty(name) && groupNames.has(`/aws/lambda/${name}`));
          if (!ok && !(!plan && name instanceof Unknown)) no("lingering", "a Lambda function must write to a log group declared here (logging_config.log_group, named /cloudlabs/<lab id>/...)");
          break;
        }
        case "aws_ecs_task_definition": {
          const cd = val.container_definitions;
          if (cd instanceof Unknown) {
            if (plan) no("lingering", "container_definitions must be known at plan (their log groups are checked)");
          } else {
            let defs = null;
            try {
              defs = JSON.parse(String(cd));
            } catch {
              // refused below
            }
            if (!Array.isArray(defs)) no("lingering", "container_definitions is not a list this check can read");
            else {
              for (const d of defs) {
                const lc = isObj(d) ? d.logConfiguration : null;
                if (!isObj(lc) || lc.logDriver !== "awslogs") continue;
                const o = isObj(lc.options) ? lc.options : {};
                if (String(o["awslogs-create-group"]).toLowerCase() === "true" || !groupNames.has(o["awslogs-group"])) no("lingering", "every awslogs log configuration must write to a log group declared here (and never awslogs-create-group)");
              }
            }
          }
          break;
        }
        case "aws_api_gateway_stage":
        case "aws_apigatewayv2_stage":
          for (const s of list(val.access_log_settings)) if (isObj(s) && !ownGroup(s.destination_arn, "access_log_settings")) no("lingering", "access logs must go to a log group declared here");
          break;
        case "aws_flow_log": {
          const t = val.log_destination_type;
          if (t === undefined || t === null || t === "cloud-watch-logs" || t instanceof Unknown) {
            const dest = val.log_destination ?? val.log_group_name;
            const attr = val.log_destination !== undefined ? "log_destination" : "log_group_name";
            if (!(!plan && dest instanceof Unknown) && !(mode === "mock" && dest instanceof Unknown && !refsOf(dest, res, attr).length) && !ownGroup(dest, attr)) no("lingering", "a flow log to CloudWatch must write to a log group declared here");
          }
          break;
        }
        case "aws_route53_query_log":
          if (!(!plan && val.cloudwatch_log_group_arn instanceof Unknown) && !ownGroup(val.cloudwatch_log_group_arn, "cloudwatch_log_group_arn")) no("lingering", "a query log must write to a log group declared here");
          break;
        case "aws_ecr_repository":
          must("force_delete", true, false);
          break;
        case "aws_backup_vault":
          must("force_destroy", true, false);
          break;
        case "aws_lb":
          off("enable_deletion_protection");
          break;
        case "aws_dynamodb_table":
          off("deletion_protection_enabled");
          break;
        case "aws_networkfirewall_firewall":
          off("delete_protection");
          break;
        case "aws_instance":
          off("disable_api_termination");
          off("disable_api_stop");
          break;
        case "aws_cloudfront_distribution":
          off("retain_on_delete");
          break;
        case "aws_route53_zone":
          must("force_destroy", true, false);
          break;
        case "aws_iam_user":
          // Ruling P6: a user with hand-made keys or devices can always be deleted.
          must("force_destroy", true, false);
          break;
        case "aws_athena_workgroup":
          must("force_destroy", true, false);
          break;
        case "aws_kinesis_stream":
          must("enforce_consumer_deletion", true, false);
          break;
        case "aws_eks_cluster":
          // Preflight C9: a learner may switch it on; Unblock turns it off, and a plan never asks for it.
          off("deletion_protection");
          break;
        case "aws_s3_bucket_object_lock_configuration":
        case "aws_backup_vault_lock_configuration":
        case "aws_glacier_vault_lock":
          no("lingering", `${type} locks data so that nothing can delete it`);
          break;
        default:
      }
    }

    function sizeProblems(res, val, no) {
      const typeOk = (t) => AWS_INSTANCE_TYPES.includes(t) && (t !== "t4g.medium" || AWS_MEDIUM_LABS.includes(labId));
      const instanceType = (x, where) => {
        if (typeof x === "string") {
          if (!typeOk(x)) no("size", `${where} ${x}: only ${AWS_INSTANCE_TYPES.filter((t) => t !== "t4g.medium").join(", ")}${AWS_MEDIUM_LABS.includes(labId) ? ", t4g.medium" : ""}`);
        } else if (opaque(x)) no("size", `${where} is not known at plan`);
      };
      const max = (x, cap, where) => {
        if (typeof x === "number" && x > cap) no("size", `${where} ${x} is over ${cap}`);
        else if (opaque(x)) no("size", `${where} is not known at plan`);
      };
      const disk = (d, where, sizeKey, typeKey) => {
        if (!isObj(d)) return;
        max(d[sizeKey], 30, `${where}${sizeKey} (GiB)`);
        if (d[typeKey] === "io2") max(d.iops, 500, `${where}iops`);
      };
      if (type === "aws_instance" || type === "aws_launch_template") instanceType(val.instance_type, "instance_type");
      if (type === "aws_autoscaling_group") {
        for (const m of list(val.mixed_instances_policy)) for (const lt of list(isObj(m) ? m.launch_template : [])) for (const o of list(isObj(lt) ? lt.override : [])) if (isObj(o)) {
          instanceType(o.instance_type, "override instance_type");
          // Review M-5: instance types chosen by attributes would get around the size cap.
          if (list(o.instance_requirements).length) no("size", "override instance_requirements: name each instance type (AWS_INSTANCE_TYPES)");
        }
        max(val.max_size, 4, "max_size");
      }
      if (type === "aws_db_instance") {
        const c = val.instance_class;
        if (typeof c === "string" && c !== "db.t4g.micro") no("size", `instance_class ${c}: only db.t4g.micro`);
        else if (opaque(c)) no("size", "instance_class is not known at plan");
        // A replica leaves allocated_storage unset (unknown at plan): only a known size is capped.
        if (typeof val.allocated_storage === "number" && val.allocated_storage > 30) no("size", `allocated_storage ${val.allocated_storage} GiB is over 30`);
        const m = val.max_allocated_storage;
        if ((typeof m === "number" && m !== 0) || opaque(m)) no("size", "max_allocated_storage must be unset or 0 (no storage autoscaling)");
      }
      if (type.startsWith("aws_elasticache_") && typeof val.node_type === "string" && val.node_type !== "cache.t4g.micro") no("size", `node_type ${val.node_type}: only cache.t4g.micro`);
      if (type === "aws_ebs_volume") disk(val, "", "size", "type");
      if (type === "aws_instance") {
        list(val.root_block_device).forEach((d) => disk(d, "root_block_device.", "volume_size", "volume_type"));
        list(val.ebs_block_device).forEach((d) => disk(d, "ebs_block_device.", "volume_size", "volume_type"));
      }
      if (type === "aws_launch_template") for (const b of list(val.block_device_mappings)) for (const e of list(isObj(b) ? b.ebs : [])) disk(e, "block_device_mappings.ebs.", "volume_size", "volume_type");
      if (type === "aws_eks_node_group") for (const s of list(val.scaling_config)) if (isObj(s)) max(s.max_size, 2, "scaling_config.max_size");
      if (type === "aws_eks_node_group") list(val.instance_types).forEach((t) => instanceType(t, "instance_types"));
      if (type === "aws_ecs_task_definition" && list(val.requires_compatibilities).includes("FARGATE") && Number(val.cpu) > 512) no("size", `cpu ${val.cpu} is over 512 (0.5 vCPU) per Fargate task`);
      if (type === "aws_kinesis_stream") {
        const mode2 = list(val.stream_mode_details).find(isObj)?.stream_mode;
        if (mode2 === "ON_DEMAND") no("size", "a Kinesis stream is provisioned with one shard, never on demand");
        else if (val.shard_count !== 1 && !skip(val.shard_count)) no("size", `shard_count ${JSON.stringify(val.shard_count ?? null)}: exactly 1`);
      }
      if (type === "aws_networkfirewall_firewall" && Array.isArray(val.subnet_mapping) && val.subnet_mapping.length !== 1) no("size", "a Network Firewall has one subnet_mapping");
      if (type === "aws_nat_gateway" && ++natGateways > 2) no("size", "at most 2 NAT gateways in a lab");
      if (type === "aws_ecs_service") max(val.desired_count, 4, "desired_count");
      if (type === "aws_lambda_function") {
        max(val.memory_size, 512, "memory_size (MB)");
        max(val.timeout, 300, "timeout (s)");
      }
      if (type === "aws_cloudfront_distribution" && !skip(val.price_class) && val.price_class !== "PriceClass_100") no("size", `price_class ${JSON.stringify(val.price_class ?? "PriceClass_All")}: only PriceClass_100 (ruling P8)`);
      if (type === "aws_route53_health_check") {
        if (typeof val.request_interval === "number" && val.request_interval !== 30) no("size", "request_interval: a 10-second check costs more; 30 only");
        if (val.measure_latency === true) no("size", "measure_latency costs more: leave it off");
      }
    }

    function dataProblem(res) {
      const val = res.values ?? {};
      if (!AWS_DATA.has(type)) return `data.${type} is not on AWS_DATA: a lab reads only ${[...AWS_DATA.keys()].join(", ")} (add it with its reason, ruling 21)`;
      if (type === "aws_ssm_parameter" && !startsKnown(val.name, "/aws/service/")) return "an SSM parameter lookup must be AWS's public one (name starting /aws/service/)";
      if (type === "aws_ami") {
        const owners = val.owners;
        if (!(Array.isArray(owners) && owners.length === 1 && owners[0] === "amazon")) return 'an AMI lookup must have owners = ["amazon"]';
      }
      if (type === "aws_ec2_managed_prefix_list" && !startsKnown(val.name, "com.amazonaws.")) return "a prefix list lookup must be an AWS-managed one (name starting com.amazonaws.)";
      return null;
    }
  }

  // An import whose target is not a resource of this configuration is still refused.
  const known = new Set(resources.map((r) => stripIndex(r.address)));
  for (const a of importing) if (!known.has(a)) out.push({ rule: "import", address: a, message: "a lab only creates: importing would adopt an object that already exists" });

  // Provider configurations: a plan's configuration.provider_config, or HCL's provider blocks. A mocked plan has none.
  if (mode === "plan") {
    const entries = Object.entries(providerConfigs ?? {});
    for (const [key, p] of entries) {
      const src = normalizeSource(p?.full_name ?? p?.name ?? key.split(".")[0]);
      const e = p?.expressions ?? {};
      const alias = p?.alias ?? e.alias?.constant_value ?? (key.includes(".") ? key.split(".").slice(1).join(".") : null);
      const dt = e.default_tags;
      const tagsOk = Array.isArray(dt) && dt.length === 1 && isObj(dt[0]) && Object.keys(dt[0]).join() === "tags" && dt[0].tags?.constant_value === undefined && (dt[0].tags?.references ?? []).join() === "var.tags";
      const why = providerWhy(src, Object.keys(e), alias, "region" in e ? planRegion(e.region) : undefined, tagsOk);
      if (why) out.push({ rule: "provider", address: `provider.${key}`, message: why });
    }
    if (resources.some((r) => r.provider === AWS_SOURCE) && !entries.some(([k, p]) => normalizeSource(p?.full_name ?? p?.name ?? k.split(".")[0]) === AWS_SOURCE)) {
      out.push({ rule: "provider", address: "provider.aws", message: "the plan has no aws provider configuration: configure it as AWS labs spec §4 (region = var.region, default_tags { tags = var.tags })" });
    }
  } else if (mode === "hcl") {
    for (const [name, blocks] of Object.entries(providerBlocks ?? {})) {
      for (const b of list(blocks)) {
        const block = isObj(b) ? b : {};
        const alias = typeof block.alias === "string" ? block.alias : null;
        const dt = block.default_tags;
        const tagsOk = Array.isArray(dt) && dt.length === 1 && isObj(dt[0]) && Object.keys(dt[0]).join() === "tags" && dt[0].tags === "${var.tags}";
        const why = providerWhy(normalizeSource(name), Object.keys(block), alias, "region" in block ? hclRegion(block.region) : undefined, tagsOk);
        if (why) out.push({ rule: "provider", address: `provider.${alias ? `${name}.${alias}` : name}`, message: why });
      }
    }
  }
  return out;

  /** Why a provider configuration is refused, or null. `region`: as written (undefined when unset). */
  function providerWhy(src, keys, alias, region, tagsOk) {
    if (!AWS_PROVIDER_SOURCES.includes(src)) return `${src} is not an allowed provider (${AWS_PROVIDER_SOURCES.join(", ")})`;
    if (src !== AWS_SOURCE) return keys.length ? `the ${src.split("/").pop()} provider takes no settings in a lab (${keys.join(", ")})` : null;
    const extra = keys.filter((k) => !AWS_PROVIDER_KEYS.includes(k));
    if (extra.length) return `an aws provider may set only region, alias and default_tags, not ${extra.join(", ")}: it uses the pipeline's own account and login`;
    if (region === undefined) return "region is not set: it must be var.region";
    const rw = regionWhy(region, alias);
    if (rw) return rw;
    if (!tagsOk) return "default_tags must be exactly tags = var.tags";
    return null;
  }
}

/** Rule 6 (plan mode): the lab tag where the plan shows tags, and where AWS copies tags onward. */
function tagProblems(r, v, labId, refuse) {
  const has = (tags) => isObj(tags) && tags[LAB_TAG] === labId;
  if ("tags_all" in v) {
    if (v.tags_all instanceof Unknown) refuse("tag", "tags_all is not known at plan: tag through default_tags and var.tags");
    else if (!has(v.tags_all)) refuse("tag", `tags_all has no ${LAB_TAG} = ${labId}: tag through default_tags and var.tags`);
  }
  switch (r.type) {
    case "aws_instance":
      // volume_tags go in with the launch (RunInstances), which wg-admin-labs refuses without the volume's lab tag;
      // root_block_device.tags are applied after launch, so they never stand in (final review, Important 1).
      if (!has(v.volume_tags)) refuse("tag", `volume_tags must carry ${LAB_TAG} = ${labId}: var.tags or merge(var.tags, …), so the launch tags the volumes`);
      break;
    case "aws_launch_template":
      for (const rt of ["instance", "volume", "network-interface"]) {
        if (!list(v.tag_specifications).some((s) => isObj(s) && s.resource_type === rt && has(s.tags))) refuse("tag", `tag_specifications must tag ${rt} with ${LAB_TAG} = ${labId}`);
      }
      break;
    case "aws_autoscaling_group":
      if (!list(v.tag).some((t) => isObj(t) && t.key === LAB_TAG && t.value === labId && t.propagate_at_launch === true)) refuse("tag", `an Auto Scaling group needs tag { key = "${LAB_TAG}", value = var.lab_id, propagate_at_launch = true }`);
      break;
    case "aws_ecs_service":
      if (v.propagate_tags !== "SERVICE") refuse("tag", 'propagate_tags must be "SERVICE"');
      break;
    case "aws_db_instance":
    case "aws_rds_cluster":
      if (v.copy_tags_to_snapshot !== true) refuse("tag", "copy_tags_to_snapshot must be true");
      break;
    case "aws_backup_plan": {
      const rules = list(v.rule);
      if (!rules.length || !rules.every((x) => isObj(x) && has(x.recovery_point_tags))) refuse("tag", `every rule's recovery_point_tags must carry ${LAB_TAG} = ${labId}`);
      break;
    }
    case "aws_dynamodb_table":
      if (v.replica instanceof Unknown || list(v.replica).some((x) => !isObj(x) || x.propagate_tags !== true)) refuse("tag", "every replica must have propagate_tags = true, so it carries the lab tag (ruling P3)");
      break;
    default:
  }
}

/** Each configured resource's provider configuration key, by address (modules prefixed as Terraform prints them). */
function configKeysOf(plan) {
  const out = {};
  const visit = (mod, prefix) => {
    for (const r of mod?.resources ?? []) out[prefix + r.address] = r.provider_config_key;
    for (const [name, call] of Object.entries(mod?.module_calls ?? {})) visit(call.module, `${prefix}module.${name}.`);
  };
  visit(plan?.configuration?.root_module, "");
  return out;
}

export const checkPlanAws = (plan, labId) =>
  scopeProblemsAws({ ...planResources(plan), configKeys: configKeysOf(plan), providerConfigs: plan?.configuration?.provider_config ?? {} }, labId, { mode: "plan" });
export const checkHclAws = (hcl, labId) => scopeProblemsAws({ ...hclResources(hcl, labId), providerBlocks: hcl?.provider ?? {} }, labId, { mode: "hcl" });

// ── Command line ─────────────────────────────────────────────────────────

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const planFile = arg("--plan");
  const hclFile = arg("--hcl");
  const lab = arg("--lab");
  if (!lab || !LAB_ID_RE.test(lab) || !AWS_ID_PREFIX.test(lab) || (!planFile) === (!hclFile)) {
    console.error("Usage: node infra/ci/lab-scope-aws.mjs (--plan <terraform show -json file> | --hcl <hcl2json file>) --lab <AWS lab id: soa-, saa- or ans->");
    return 2;
  }
  let json;
  try {
    json = JSON.parse(readFileSync(planFile ?? hclFile, "utf8"));
  } catch (e) {
    console.error(`lab-scope-aws: cannot read ${planFile ?? hclFile}: ${e.message}`);
    return 2;
  }
  const problems = planFile ? checkPlanAws(json, lab) : checkHclAws(json, lab);
  const n = (planFile ? planResources(json) : hclResources(json, lab)).resources.length;
  for (const p of problems) console.log(`${p.rule}: ${p.address} (${p.message})`);
  if (problems.length) {
    console.error(`lab-scope-aws: refused ${problems.length} of ${n} resource(s) for ${lab}; nothing was built`);
    return 1;
  }
  console.error(`lab-scope-aws: ${n} resource(s), all inside ${lab}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
