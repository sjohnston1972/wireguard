#!/usr/bin/env bash
# infra/ci/lab-aws-safety-net.sh <lab id>            lab-aws.yml step 13, "Safety net"
# infra/ci/lab-aws-safety-net.sh --verify <lab id>   lab-aws.yml step 14, "Verify clean"
#
# Plain English: what gets an AWS lab back to £0 when Terraform cannot (AWS
# labs spec §8.2, §8.3). It never reads Terraform state: it works from AWS's
# own lists, so it does the same job when the destroy failed, the state is
# missing or half-written, or the lab has left the catalogue (an orphan
# clean-up is just a destroy run). What it treats as the lab's (ruling A4):
#
#   tagged items     everything tag:GetResources lists for cloudlabs-lab = <id>
#                    in each of $LAB_REGIONS (Parse payload; default eu-west-2
#                    eu-west-1)
#   IAM              roles, instance profiles, customer policies and users under
#                    /cloudlabs-lab/ named lab-<id>-* (never a service-linked
#                    role, ruling A18, nor wg-admin-labs)
#   named items      in each lab region (never us-east-1 or us-west-2, where
#                    the role is refused these services: pre-flight C3), the
#                    types that take no tags, named lab-<id>-*: CloudWatch
#                    dashboards, Config recorders and delivery channels, Logs
#                    query definitions, KMS aliases; and in us-east-1 (a global
#                    lab's) CloudFront origin access controls
#   owned by name    in each lab region too (rulings P3, P4, P15): DynamoDB
#                    tables named lab-<id>-* (a global table's replica before
#                    its tags arrive), AMIs of its own named lab-<id>-* (a copy
#                    is tagged only after it is made) and Glue databases named
#                    lab_<id with _ for -> (Glue takes no hyphens)
#
# Never the VPN server's: an item carrying the wg-admin tag is skipped even
# when it carries the lab's tag too, and so is anything inside a VPC tagged
# wg-admin = vpn (looked up per region; when that lookup fails, nothing inside
# a VPC is deleted in that region). Verify clean still names such an item when
# it carries the lab's tag (a person must look), but never scans inside it.
#
# Sweep mode deletes, in dependency order (§8.2; batches 1 to 3's handlers,
# ruling A36: any other type is a warning, "no handler for <type> yet", left
# for Verify clean to report):
#
#   1 workloads      CloudFormation stacks (ruling P4: deleted and waited for;
#                    one that ends DELETE_FAILED deleted again with
#                    FORCE_DELETE_STACK, what it leaves going by its own
#                    handler), EKS node groups, then clusters (their access
#                    entries go with them), ECS services (scaled to 0,
#                    deleted), tasks stopped, clusters, task definitions
#                    (ruling P12: deregistered and deleted), Lambda functions,
#                    HTTP APIs (their stages, routes and integrations go with
#                    them), Step Functions state machines, Auto Scaling groups
#                    (force; their EC2 Fleets go with them), EventBridge rules
#                    (targets first), then buses, Firehose streams before the
#                    Kinesis streams they read, Glue crawlers (ruling P21: a
#                    running one stopped and waited for), Glue databases (with
#                    their tables), Athena workgroups (with their saved
#                    queries), Config rules (remediation first), the lab's
#                    Config recorder stopped, its delivery channel and recorder
#   2 edge and DNS   CloudFront distributions (disabled, waited for until
#                    Deployed, deleted with their newest ETag), then the lab's
#                    origin access controls; Route 53 zones (every record but
#                    the zone's own NS and SOA first), then health checks
#   3 network        load balancers, then listener rules and listeners still
#                    there (most go with their load balancer), then target
#                    groups; RDS replicas, then
#                    instances, subnet groups, parameter groups, snapshots
#                    (never an automated one: it goes with its database);
#                    ElastiCache replication groups, clusters of their own
#                    (never a group's member), subnet groups, snapshots; EFS
#                    file systems (every mount target first, waited for);
#                    instances terminated; launch templates; NAT gateways;
#                    Elastic IPs; VPC peering; VPC endpoints; Instance Connect
#                    Endpoints; volumes; flow logs
#   4 VPC fabric     detached network interfaces, security groups (rules that
#                    name another lab group revoked first; never "default"),
#                    subnets, route tables (non-main associations first),
#                    network ACLs (not the default), internet gateways
#                    (detached first), egress-only gateways, prefix lists, VPCs;
#                    then security group rules still there (most go with their
#                    group), revoked by id, never in the VPN server's VPC
#   5 data           buckets (every version and delete marker), SNS topics, SQS
#                    queues, SSM parameters, log groups, alarms, dashboards,
#                    query definitions, SSM associations, patch baselines
#                    (their patch groups first), Backup plans (selections
#                    first) and vaults, KMS aliases, then keys (ruling P11:
#                    scheduled for deletion in 7 days), Secrets Manager secrets
#                    (no recovery window), ECR repositories (with their
#                    images), Access Analyzer analyzers, DynamoDB tables
#                    (ruling P21: a global table's replicas in other regions
#                    removed and waited for first), Cognito user pools (their
#                    domains first; deletion protection off if Unblock could
#                    not), AMIs (ruling P4: then the snapshots each names),
#                    then snapshots, resource groups
#   6 IAM            instance profiles (roles removed), roles (policies detached
#                    and deleted), users (login profile, then hand-made access
#                    keys, MFA devices, SSH keys, signing certificates and
#                    service credentials, ruling P6, then policies), customer
#                    policies (old versions first)
#
# CloudFormation stacks, EKS node groups and clusters, ECS services and
# clusters, CloudFront distributions, Auto Scaling groups, Firehose and Kinesis
# streams, load balancers, RDS instances, ElastiCache groups and clusters, EFS
# file systems, instances, NAT gateways, VPC endpoints, Instance Connect
# Endpoints and DynamoDB tables are polled after the delete,
# every LAB_DELETE_POLL_SECONDS (30), until gone or LAB_JOB_DEADLINE less 420 s
# (what is left then is a warning, "left behind: <name>"). VPC fabric deletes
# are synchronous (pre-flight ruling C15): one AWS refuses with
# DependencyViolation (an interface still being released) is tried again in
# a later pass, at most 5 passes, by the same deadline. Sweep mode always
# exits 0 (Verify clean is the verdict).
#
# --verify deletes nothing. The tagging API keeps listing deleted items for
# about an hour, so it only finds candidates: each one is judged by its own
# describe (an instance terminated, a NAT gateway or VPC endpoint deleted, an
# Instance Connect Endpoint or prefix list delete-complete, a volume deleted,
# an RDS snapshot being deleted (automated ones are waited for first, up to
# 15 minutes),
# an AMI deregistered, a dead peering connection, anything AWS answers "not
# found" for (a security group rule, listener or listener rule gone with its
# group or load balancer too), a stack DELETE_COMPLETE, an ECS cluster or
# service INACTIVE, a task STOPPED, a task definition DELETE_IN_PROGRESS (an
# INACTIVE one is a leftover, ruling P12), a secret deleted, a KMS key
# pending deletion (ruling P11; an enabled one is a leftover), a DynamoDB
# table or a state machine DELETING (ruling P21), an EFS file system deleted,
# an EC2 Fleet deleted, and an EKS access entry whose cluster is gone, are
# clean; every other batch 3 type only once AWS no longer has it). A
# type with no handler is never clean ("no handler for <type>: <name>"). While a lab VPC
# still exists, every instance (not terminated) and every network interface
# (not requester-managed, not attached to an instance, which is judged
# itself) inside it without the lab's tag is "untagged inside lab VPC: <id>"
# (ruling A26). A list that cannot be read is "could not list <what>":
# not knowing is never clean. It prints, and appends to $GITHUB_OUTPUT,
#
#   clean=true|false
#   leftovers=["ec2:vpc vpc-0a (vpc-lab)","untagged inside lab VPC: i-0b",...]
#
# and exits 0 when clean, 1 otherwise. A name is "<service:type> <id>", plus
# " (<Name tag>)" when it has one; IAM's are the role, profile, policy or user
# name. Never an account id: AWS's error text is cut to its code, and ARNs are
# never printed. AWS CLI v2 and jq only; every call names its region (IAM's
# none) and every read asks for JSON. Exit 2 for a bad lab id, before any call.

set -uo pipefail

MODE=sweep
if [ "${1:-}" = "--verify" ]; then
  MODE=verify
  shift
fi
LAB_ID="${1:-}"
LAB_ID_RE='^(az(104|305|700)|soa|saa|ans)-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$'
if ! [[ "$LAB_ID" =~ $LAB_ID_RE ]] || [ "${#LAB_ID}" -gt 30 ]; then
  echo "::error::lab-aws-safety-net: refusing lab id '${LAB_ID}'"
  exit 2
fi
PREFIX="lab-$LAB_ID-"
GLUE_DB="lab_${LAB_ID//-/_}"   # ruling P15: Glue takes no hyphens
IAM_PATH=/cloudlabs-lab/
REGIONS="${LAB_REGIONS:-eu-west-2 eu-west-1}"
num() { [[ "${1:-}" =~ ^[0-9]+$ ]] && echo "$1" || echo "$2"; }
POLL_S="$(num "${LAB_DELETE_POLL_SECONDS:-}" 30)"
FABRIC_PASSES=5
# The polls stop in time for Verify clean, Back up state and the report.
if [[ "${LAB_JOB_DEADLINE:-}" =~ ^[0-9]+$ ]]; then UNTIL=$((LAB_JOB_DEADLINE - 420)); else UNTIL=$(($(date +%s) + 1800)); fi
past_until() { [ "$(date +%s)" -ge "$UNTIL" ]; }

TMPD="$(mktemp -d)"
ERRF="$TMPD/err"
trap 'rm -rf "$TMPD"' EXIT
warn() { echo "::warning::safety net: $*" >&2; }
# Every aws call: its error text goes to a file, of which only the code is ever shown.
awsx() { aws "$@" 2>"$ERRF"; }
errcode() { sed -n 's/.*An error occurred (\([A-Za-z0-9._]*\)).*/\1/p' "$ERRF" | head -n1; }
code() { local c; c="$(errcode)"; echo "${c:-refused}"; }
# The last call failed because AWS has no such item.
gone_err() {
  case "$(errcode)" in
    *NotFound* | NoSuch* | *DoesNotExist* | *NonExistentQueue* | 404) return 0 ;;
  esac
  return 1
}
# A read in region $1 (IAM's "region" is iam): the answer's JSON.
awsq() {
  local r="$1"
  shift
  if [ "$r" = iam ]; then awsx "$@" --output json; else awsx "$@" --region "$r" --output json; fi
}

# ── Candidates ───────────────────────────────────────────────────────────
# One row per item: region (iam for IAM), type key, id, extra (ARN, query
# definition id, KMS key id or a profile's roles; never printed), the Name tag
# from the tagging API, and 1 when it carries the VPN server's wg-admin tag.
C_R=() C_T=() C_I=() C_A=() C_N=() C_W=()
declare -A SEEN=()
LIST_FAILED=()
add() {
  local key="$1|$2|$3"
  [ "$2" = s3:bucket ] && key="s3|$3"
  [ -n "${SEEN[$key]:-}" ] && return
  SEEN[$key]=1
  C_R+=("$1") C_T+=("$2") C_I+=("$3") C_A+=("$4") C_N+=("$5") C_W+=("$6")
}
list_failed() {
  LIST_FAILED+=("could not list $1")
  [ "$MODE" = sweep ] && warn "could not list $1 ($(code))"
}
# "<type> <id> (<Name>)"
label() {
  local n="${C_T[$1]} ${C_I[$1]}"
  [ -n "${C_N[$1]}" ] && n+=" (${C_N[$1]})"
  echo "$n"
}

# split_arn <arn>: TYPE ("service:type") and ID (the resource part after the type).
split_arn() {
  local service rest head
  IFS=: read -r _ _ service _ _ rest <<<"$1"
  # Ruling P2: arn:aws:apigateway:<r>::/apis/<id>[/stages/<name>]: the last collection named is the type.
  if [ "$service" = apigateway ]; then
    rest="${rest#/}"
    case "$rest" in
      apis/*/stages/*) TYPE=apigateway:stages; head="${rest#apis/}"; ID="${head%%/*}/${rest##*/}" ;;
      *) TYPE="apigateway:${rest%%/*}"; ID="${rest#*/}" ;;
    esac
    return
  fi
  head="${rest%%[/:]*}"
  if [ "$head" = "$rest" ]; then
    # arn:aws:s3:::<bucket>, arn:aws:sns:<r>:<a>:<topic>: no type part.
    case "$service" in s3) head=bucket ;; sns) head=topic ;; sqs) head=queue ;; *) head=resource ;; esac
    ID="$rest"
  else
    ID="${rest:${#head}+1}"
  fi
  TYPE="$service:$head"
  case "$TYPE" in
    autoscaling:autoScalingGroup) ID="${ID##*autoScalingGroupName/}" ;;
    logs:log-group) ID="${ID%:\*}" ;;
    iam:*) ID="${ID##*/}" ;;
  esac
}

discover() {
  local r json n x w
  for r in $REGIONS; do
    if json="$(awsq "$r" resourcegroupstaggingapi get-resources --tag-filters "Key=cloudlabs-lab,Values=$LAB_ID")"; then
      while IFS=$'\x1f' read -r x n w; do
        [ -z "$x" ] && continue
        split_arn "$x"
        # IAM is found by path and prefix only (below).
        [[ "$TYPE" == iam:* ]] && continue
        add "$r" "$TYPE" "$ID" "$x" "$n" "$w"
      done < <(jq -r '.ResourceTagMappingList[]? | (.Tags // []) as $t | [.ResourceARN // "", ($t | map(select(.Key == "Name"))[0].Value // ""), (if any($t[]; .Key == "wg-admin") then "1" else "0" end)] | join("\u001f")' <<<"$json")
    else
      list_failed "tagged resources in $r"
    fi
    # The lab-service listings run in the lab regions only (pre-flight C3): a global lab's us-east-1 and us-west-2
    # hold CloudFront, Route 53 and Global Accelerator only, and the role is refused the rest there.
    if [ "$r" != us-east-1 ] && [ "$r" != us-west-2 ]; then
      if json="$(awsq "$r" cloudwatch list-dashboards --dashboard-name-prefix "$PREFIX")"; then
        while IFS= read -r n; do [ -n "$n" ] && add "$r" cloudwatch:dashboard "$n" "" "" 0; done < <(jq -r --arg p "$PREFIX" '.DashboardEntries[]?.DashboardName // empty | select(startswith($p))' <<<"$json")
      else
        list_failed "CloudWatch dashboards in $r"
      fi
      if json="$(awsq "$r" configservice describe-configuration-recorders)"; then
        while IFS= read -r n; do [ -n "$n" ] && add "$r" config:configuration-recorder "$n" "" "" 0; done < <(jq -r --arg p "$PREFIX" '.ConfigurationRecorders[]?.name // empty | select(startswith($p))' <<<"$json")
      else
        list_failed "Config recorders in $r"
      fi
      if json="$(awsq "$r" configservice describe-delivery-channels)"; then
        while IFS= read -r n; do [ -n "$n" ] && add "$r" config:delivery-channel "$n" "" "" 0; done < <(jq -r --arg p "$PREFIX" '.DeliveryChannels[]?.name // empty | select(startswith($p))' <<<"$json")
      else
        list_failed "Config delivery channels in $r"
      fi
      if json="$(awsq "$r" logs describe-query-definitions --query-definition-name-prefix "$PREFIX")"; then
        while IFS=$'\x1f' read -r n x; do [ -n "$n" ] && add "$r" logs:query-definition "$n" "$x" "" 0; done < <(jq -r --arg p "$PREFIX" '.queryDefinitions[]? | select((.name // "") | startswith($p)) | [.name, .queryDefinitionId // ""] | join("\u001f")' <<<"$json")
      else
        list_failed "Logs query definitions in $r"
      fi
      if json="$(awsq "$r" kms list-aliases)"; then
        while IFS=$'\x1f' read -r n x; do [ -n "$n" ] && add "$r" kms:alias "$n" "$x" "" 0; done < <(jq -r --arg p "alias/$PREFIX" '.Aliases[]? | select((.AliasName // "") | startswith($p)) | [.AliasName, .TargetKeyId // ""] | join("\u001f")' <<<"$json")
      else
        list_failed "KMS aliases in $r"
      fi
      # Rulings P3, P4, P15: what the lab also owns by name (a replica before its tags arrive, an AMI copy, a Glue database).
      if json="$(awsq "$r" dynamodb list-tables)"; then
        while IFS= read -r n; do [ -n "$n" ] && add "$r" dynamodb:table "$n" "" "" 0; done < <(jq -r --arg p "$PREFIX" '.TableNames[]? | select(startswith($p))' <<<"$json")
      else
        list_failed "DynamoDB tables in $r"
      fi
      if json="$(awsq "$r" ec2 describe-images --owners self --filters "Name=name,Values=${PREFIX}*")"; then
        # Review M3: describe-images gives the image's tags, so one carrying wg-admin is marked (never touched).
        while IFS=$'\x1f' read -r x n w; do [ -n "$x" ] && add "$r" ec2:image "$x" "" "$n" "$w"; done < <(jq -r --arg p "$PREFIX" '.Images[]? | select((.Name // "") | startswith($p)) | [.ImageId, .Name, (if any((.Tags // [])[]; .Key == "wg-admin") then "1" else "0" end)] | join("\u001f")' <<<"$json")
      else
        list_failed "AMIs in $r"
      fi
      if json="$(awsq "$r" glue get-databases)"; then
        while IFS= read -r n; do [ -n "$n" ] && add "$r" glue:database "$n" "" "" 0; done < <(jq -r --arg p "$GLUE_DB" '.DatabaseList[]?.Name // empty | select(. == $p or startswith($p + "_"))' <<<"$json")
      else
        list_failed "Glue databases in $r"
      fi
    fi
    # CloudFront origin access controls take no tags (A4) and are global, so they are listed by name in us-east-1,
    # which $REGIONS holds only for AWS_GLOBAL_LABS.
    if [ "$r" = us-east-1 ]; then
      if json="$(awsq "$r" cloudfront list-origin-access-controls)"; then
        while IFS=$'\x1f' read -r n x; do [ -n "$n" ] && add "$r" cloudfront:origin-access-control "$x" "" "$n" 0; done < <(jq -r --arg p "$PREFIX" '.OriginAccessControlList.Items[]? | select((.Name // "") | startswith($p)) | [.Name, .Id] | join("\u001f")' <<<"$json")
      else
        list_failed "CloudFront origin access controls"
      fi
    fi
  done
  if json="$(awsq iam iam list-roles --path-prefix "$IAM_PATH")"; then
    while IFS= read -r n; do [ -n "$n" ] && add iam iam:role "$n" "" "" 0; done < <(jq -r --arg p "$PREFIX" '.Roles[]?.RoleName // empty | select(startswith($p))' <<<"$json")
  else
    list_failed "IAM roles"
  fi
  if json="$(awsq iam iam list-instance-profiles --path-prefix "$IAM_PATH")"; then
    while IFS=$'\x1f' read -r n x; do [ -n "$n" ] && add iam iam:instance-profile "$n" "$x" "" 0; done < <(jq -r --arg p "$PREFIX" '.InstanceProfiles[]? | select((.InstanceProfileName // "") | startswith($p)) | [.InstanceProfileName, ([.Roles[]?.RoleName // empty] | join(" "))] | join("\u001f")' <<<"$json")
  else
    list_failed "IAM instance profiles"
  fi
  if json="$(awsq iam iam list-policies --scope Local --path-prefix "$IAM_PATH")"; then
    while IFS=$'\x1f' read -r n x; do [ -n "$n" ] && add iam iam:policy "$n" "$x" "" 0; done < <(jq -r --arg p "$PREFIX" '.Policies[]? | select((.PolicyName // "") | startswith($p)) | [.PolicyName, .Arn // ""] | join("\u001f")' <<<"$json")
  else
    list_failed "IAM policies"
  fi
  if json="$(awsq iam iam list-users --path-prefix "$IAM_PATH")"; then
    while IFS= read -r n; do [ -n "$n" ] && add iam iam:user "$n" "" "" 0; done < <(jq -r --arg p "$PREFIX" '.Users[]?.UserName // empty | select(startswith($p))' <<<"$json")
  else
    list_failed "IAM users"
  fi
}

# ── Real state ───────────────────────────────────────────────────────────
# describe <i>: the item's own describe, as one JSON object in DJ (empty when
# AWS answered with an empty list: an empty answer counts as one). Returns 0
# answered, 1 not found, 2 AWS could not be asked or its answer could not be
# read (never "gone"), 3 no describe for this type (no handler).
describe() {
  local i="$1" id="${C_I[$1]}" x="${C_A[$1]}" q json
  local -a bus=()
  DJ=""
  case "${C_T[$i]}" in
    ec2:instance) set -- ec2 describe-instances --instance-ids "$id"; q='.Reservations[]?.Instances[]?' ;;
    ec2:natgateway) set -- ec2 describe-nat-gateways --nat-gateway-ids "$id"; q='.NatGateways[]?' ;;
    ec2:vpc-endpoint) set -- ec2 describe-vpc-endpoints --vpc-endpoint-ids "$id"; q='.VpcEndpoints[]?' ;;
    ec2:instance-connect-endpoint) set -- ec2 describe-instance-connect-endpoints --instance-connect-endpoint-ids "$id"; q='.InstanceConnectEndpoints[]?' ;;
    ec2:network-interface) set -- ec2 describe-network-interfaces --network-interface-ids "$id"; q='.NetworkInterfaces[]?' ;;
    ec2:security-group) set -- ec2 describe-security-groups --group-ids "$id"; q='.SecurityGroups[]?' ;;
    ec2:security-group-rule) set -- ec2 describe-security-group-rules --security-group-rule-ids "$id"; q='.SecurityGroupRules[]?' ;;
    ec2:subnet) set -- ec2 describe-subnets --subnet-ids "$id"; q='.Subnets[]?' ;;
    ec2:route-table) set -- ec2 describe-route-tables --route-table-ids "$id"; q='.RouteTables[]?' ;;
    ec2:network-acl) set -- ec2 describe-network-acls --network-acl-ids "$id"; q='.NetworkAcls[]?' ;;
    ec2:internet-gateway) set -- ec2 describe-internet-gateways --internet-gateway-ids "$id"; q='.InternetGateways[]?' ;;
    ec2:egress-only-internet-gateway) set -- ec2 describe-egress-only-internet-gateways --egress-only-internet-gateway-ids "$id"; q='.EgressOnlyInternetGateways[]?' ;;
    ec2:prefix-list) set -- ec2 describe-managed-prefix-lists --prefix-list-ids "$id"; q='.PrefixLists[]?' ;;
    ec2:vpc) set -- ec2 describe-vpcs --vpc-ids "$id"; q='.Vpcs[]?' ;;
    ec2:launch-template) set -- ec2 describe-launch-templates --launch-template-ids "$id"; q='.LaunchTemplates[]?' ;;
    ec2:elastic-ip) set -- ec2 describe-addresses --allocation-ids "$id"; q='.Addresses[]?' ;;
    ec2:vpc-peering-connection) set -- ec2 describe-vpc-peering-connections --vpc-peering-connection-ids "$id"; q='.VpcPeeringConnections[]?' ;;
    ec2:volume) set -- ec2 describe-volumes --volume-ids "$id"; q='.Volumes[]?' ;;
    ec2:snapshot) set -- ec2 describe-snapshots --snapshot-ids "$id"; q='.Snapshots[]?' ;;
    ec2:image) set -- ec2 describe-images --image-ids "$id"; q='.Images[]?' ;;
    elasticloadbalancing:loadbalancer) set -- elbv2 describe-load-balancers --load-balancer-arns "$x"; q='.LoadBalancers[]?' ;;
    elasticloadbalancing:targetgroup) set -- elbv2 describe-target-groups --target-group-arns "$x"; q='.TargetGroups[]?' ;;
    elasticloadbalancing:listener) set -- elbv2 describe-listeners --listener-arns "$x"; q='.Listeners[]?' ;;
    elasticloadbalancing:listener-rule) set -- elbv2 describe-rules --rule-arns "$x"; q='.Rules[]?' ;;
    rds:db) set -- rds describe-db-instances --db-instance-identifier "$id"; q='.DBInstances[]?' ;;
    rds:subgrp) set -- rds describe-db-subnet-groups --db-subnet-group-name "$id"; q='.DBSubnetGroups[]?' ;;
    rds:pg) set -- rds describe-db-parameter-groups --db-parameter-group-name "$id"; q='.DBParameterGroups[]?' ;;
    rds:snapshot) set -- rds describe-db-snapshots --db-snapshot-identifier "$id"; q='.DBSnapshots[]?' ;;
    autoscaling:autoScalingGroup) set -- autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$id"; q='.AutoScalingGroups[]?' ;;
    events:rule)
      [[ "$id" == */* ]] && bus=(--event-bus-name "${id%/*}")
      set -- events describe-rule --name "${id##*/}" "${bus[@]}"; q='.' ;;
    config:config-rule) set -- configservice describe-config-rules; q='.ConfigRules[]? | select(.ConfigRuleArn == $x)' ;;
    config:configuration-recorder) set -- configservice describe-configuration-recorders --configuration-recorder-names "$id"; q='.ConfigurationRecorders[]?' ;;
    config:delivery-channel) set -- configservice describe-delivery-channels --delivery-channel-names "$id"; q='.DeliveryChannels[]?' ;;
    s3:bucket) set -- s3api head-bucket --bucket "$id"; q='{}' ;;
    sns:topic) set -- sns get-topic-attributes --topic-arn "$x"; q='.Attributes' ;;
    logs:log-group) set -- logs describe-log-groups --log-group-name-prefix "$id"; q='.logGroups[]? | select(.logGroupName == $id)' ;;
    logs:query-definition) set -- logs describe-query-definitions --query-definition-name-prefix "$id"; q='.queryDefinitions[]? | select(.name == $id)' ;;
    cloudwatch:alarm) set -- cloudwatch describe-alarms --alarm-names "$id"; q='(.MetricAlarms // [])[], (.CompositeAlarms // [])[]' ;;
    cloudwatch:dashboard) set -- cloudwatch get-dashboard --dashboard-name "$id"; q='.' ;;
    ssm:association) set -- ssm describe-association --association-id "$id"; q='.AssociationDescription' ;;
    ssm:patchbaseline) set -- ssm get-patch-baseline --baseline-id "$id"; q='.' ;;
    backup:backup-plan) set -- backup get-backup-plan --backup-plan-id "$id"; q='select(.DeletionDate == null)' ;;
    backup:backup-vault) set -- backup describe-backup-vault --backup-vault-name "$id"; q='.' ;;
    resource-groups:group) set -- resource-groups get-group --group "$id"; q='.Group' ;;
    kms:key) set -- kms describe-key --key-id "$id"; q='.KeyMetadata' ;;
    cloudformation:stack) set -- cloudformation describe-stacks --stack-name "$x"; q='.Stacks[]?' ;;
    sqs:queue) set -- sqs get-queue-url --queue-name "$id"; q='.' ;;
    ssm:parameter) set -- ssm get-parameter --name "/$id"; q='.Parameter' ;;
    secretsmanager:secret) set -- secretsmanager describe-secret --secret-id "$x"; q='select(.DeletedDate == null)' ;;
    lambda:function) set -- lambda get-function-configuration --function-name "${id%%:*}"; q='.' ;;
    access-analyzer:analyzer) set -- accessanalyzer get-analyzer --analyzer-name "$id"; q='.analyzer' ;;
    ecr:repository) set -- ecr describe-repositories --repository-names "$id"; q='.repositories[]?' ;;
    ecs:cluster) set -- ecs describe-clusters --clusters "$x"; q='.clusters[]?' ;;
    ecs:service) set -- ecs describe-services --cluster "${id%%/*}" --services "$x"; q='.services[]?' ;;
    ecs:task) set -- ecs describe-tasks --cluster "${id%%/*}" --tasks "$x"; q='.tasks[]?' ;;
    ecs:task-definition) set -- ecs describe-task-definition --task-definition "$x"; q='.taskDefinition' ;;
    ec2:vpc-flow-log) set -- ec2 describe-flow-logs --flow-log-ids "$id"; q='.FlowLogs[]?' ;;
    cloudfront:distribution) set -- cloudfront get-distribution --id "$id"; q='.Distribution' ;;
    cloudfront:origin-access-control) set -- cloudfront get-origin-access-control --id "$id"; q='.OriginAccessControl' ;;
    route53:hostedzone) set -- route53 get-hosted-zone --id "$id"; q='.HostedZone' ;;
    route53:healthcheck) set -- route53 get-health-check --health-check-id "$id"; q='.HealthCheck' ;;
    kms:alias)
      [ -n "$x" ] || return 3
      set -- kms list-aliases --key-id "$x"; q='.Aliases[]? | select(.AliasName == $id)' ;;
    apigateway:apis) set -- apigatewayv2 get-api --api-id "$id"; q='.' ;;
    apigateway:stages) set -- apigatewayv2 get-stage --api-id "${id%%/*}" --stage-name "${id#*/}"; q='.' ;;
    cognito-idp:userpool) set -- cognito-idp describe-user-pool --user-pool-id "$id"; q='.UserPool' ;;
    dynamodb:table) set -- dynamodb describe-table --table-name "$id"; q='.Table' ;;
    events:event-bus) set -- events describe-event-bus --name "$id"; q='.' ;;
    states:stateMachine) set -- stepfunctions describe-state-machine --state-machine-arn "$x"; q='.' ;;
    elasticfilesystem:file-system) set -- efs describe-file-systems --file-system-id "$id"; q='.FileSystems[]?' ;;
    elasticache:replicationgroup) set -- elasticache describe-replication-groups --replication-group-id "$id"; q='.ReplicationGroups[]?' ;;
    elasticache:cluster) set -- elasticache describe-cache-clusters --cache-cluster-id "$id"; q='.CacheClusters[]?' ;;
    elasticache:subnetgroup) set -- elasticache describe-cache-subnet-groups --cache-subnet-group-name "$id"; q='.CacheSubnetGroups[]?' ;;
    elasticache:snapshot) set -- elasticache describe-snapshots --snapshot-name "$id"; q='.Snapshots[]?' ;;
    kinesis:stream) set -- kinesis describe-stream-summary --stream-name "$id"; q='.StreamDescriptionSummary' ;;
    firehose:deliverystream) set -- firehose describe-delivery-stream --delivery-stream-name "$id"; q='.DeliveryStreamDescription' ;;
    glue:crawler) set -- glue get-crawler --name "$id"; q='.Crawler' ;;
    glue:database) set -- glue get-database --name "$id"; q='.Database' ;;
    athena:workgroup) set -- athena list-work-groups; q='.WorkGroups[]? | select(.Name == $id)' ;;
    eks:cluster) set -- eks describe-cluster --name "$id"; q='.cluster' ;;
    eks:nodegroup) set -- eks describe-nodegroup --cluster-name "${id%%/*}" --nodegroup-name "$(cut -d/ -f2 <<<"$id")"; q='.nodegroup' ;;
    # Pre-flight C11: judged only, each going with its cluster or Auto Scaling group (an access entry by its cluster).
    eks:access-entry) set -- eks describe-cluster --name "${id%%/*}"; q='.cluster' ;;
    ec2:fleet) set -- ec2 describe-fleets --fleet-ids "$id"; q='.Fleets[]?' ;;
    iam:role) set -- iam get-role --role-name "$id"; q='.Role' ;;
    iam:instance-profile) set -- iam get-instance-profile --instance-profile-name "$id"; q='.InstanceProfile' ;;
    iam:policy) set -- iam get-policy --policy-arn "$x"; q='.Policy' ;;
    iam:user) set -- iam get-user --user-name "$id"; q='.User' ;;
    *) return 3 ;;
  esac
  if ! json="$(awsq "${C_R[$i]}" "$@")"; then
    [ "${C_T[$i]}" = ecs:task-definition ] && [ "$(errcode)" = ClientException ] && return 1 # a deleted task definition describes as ClientException (V; Task 13)
    gone_err && return 1
    return 2
  fi
  # head-bucket answering at all means the bucket is there (older CLI v2 prints no body).
  if [ "${C_T[$i]}" = s3:bucket ]; then
    DJ='{}'
    return 0
  fi
  if ! DJ="$(jq -c --arg x "$x" --arg id "$id" "[ $q ][0] // empty" <<<"$json" 2>/dev/null)"; then
    DJ=""
    : >"$ERRF" # no AWS error code to show: the answer itself was unreadable
    return 2
  fi
  return 0
}

# judge <i>: J = gone, there, unknown (AWS could not be asked) or nohandler; NT = its Name tag.
judge() {
  local i="$1" g s n
  NT="${C_N[$i]}"
  describe "$i"
  case $? in
    1) J=gone; return ;;
    2) J=unknown; return ;;
    3) J=nohandler; return ;;
  esac
  [ -z "$DJ" ] && { J=gone; return; }
  case "${C_T[$i]}" in
    ec2:instance) g='.State.Name == "terminated"' ;;
    ec2:natgateway | ec2:volume) g='.State == "deleted"' ;;
    ec2:vpc-endpoint) g='(.State // "" | ascii_downcase) == "deleted"' ;;
    ec2:instance-connect-endpoint | ec2:prefix-list) g='.State == "delete-complete"' ;;
    ec2:image) g='.State == "deregistered"' ;;
    ec2:vpc-peering-connection) g='(.Status.Code // "") | IN("deleted", "rejected", "failed", "expired")' ;;
    kms:key) g='.KeyState == "PendingDeletion"' ;;
    cloudformation:stack) g='.StackStatus == "DELETE_COMPLETE"' ;;
    ecs:cluster | ecs:service) g='.status == "INACTIVE"' ;;
    ecs:task) g='.lastStatus == "STOPPED"' ;;
    ecs:task-definition) g='.status == "DELETE_IN_PROGRESS"' ;;
    rds:snapshot) g='.Status == "deleting"' ;;
    # Ruling P21: everything else of batch 3 is there until AWS no longer has it.
    dynamodb:table) g='.TableStatus == "DELETING"' ;;
    states:stateMachine) g='.status == "DELETING"' ;;
    elasticfilesystem:file-system) g='.LifeCycleState == "deleted"' ;;
    ec2:fleet) g='(.FleetState // "") | startswith("deleted")' ;;
    *) g='false' ;;
  esac
  IFS=$'\x1f' read -r s n < <(jq -r "[ (if ($g) then \"gone\" else \"there\" end), ((.Tags // .TagSet // []) | if type == \"array\" then (map(select(.Key == \"Name\"))[0].Value // \"\") else \"\" end) ] | join(\"\u001f\")" <<<"$DJ" 2>/dev/null)
  J="${s:-there}"
  [ -n "${n:-}" ] && NT="$n"
}

# ── Verify clean ─────────────────────────────────────────────────────────

if [ "$MODE" = verify ]; then
  discover
  left=("${LIST_FAILED[@]}")
  # A58: automated RDS snapshots go with their database minutes after it; wait for them (by UNTIL, at most 15 minutes).
  auto=()
  for i in "${!C_T[@]}"; do [ "${C_T[$i]}" = rds:snapshot ] && [[ "${C_I[$i]}" == rds:* ]] && auto+=("$i"); done
  auto_until=$(($(date +%s) + 900))
  while [ "${#auto[@]}" -gt 0 ]; do
    next=()
    for i in "${auto[@]}"; do
      judge "$i"
      [ "$J" = there ] && next+=("$i")
    done
    auto=("${next[@]}")
    [ "${#auto[@]}" -eq 0 ] && break
    { past_until || [ "$(date +%s)" -ge "$auto_until" ]; } && break
    echo "verify clean: waiting for ${#auto[@]} automated database snapshot(s) to go with their database"
    sleep "$POLL_S"
  done
  for i in "${!C_T[@]}"; do
    judge "$i"
    case "$J" in
      gone) ;;
      there)
        left+=("${C_T[$i]} ${C_I[$i]}${NT:+ ($NT)}")
        # A26: whatever is inside a lab VPC that still exists, tagged or not (never the VPN server's).
        if [ "${C_T[$i]}" = ec2:vpc ] && [ "${C_W[$i]}" != 1 ]; then
          r="${C_R[$i]}"
          v="${C_I[$i]}"
          if json="$(awsq "$r" ec2 describe-instances --filters "Name=vpc-id,Values=$v")"; then
            while IFS= read -r x; do [ -n "$x" ] && left+=("untagged inside lab VPC: $x"); done < <(jq -r --arg id "$LAB_ID" '.Reservations[]?.Instances[]? | select((.State.Name // "") != "terminated") | (.Tags // []) as $t | select(any($t[]; .Key == "cloudlabs-lab" and .Value == $id) | not) | ($t | map(select(.Key == "Name"))[0].Value // "") as $n | .InstanceId + (if $n == "" then "" else " (" + $n + ")" end)' <<<"$json")
          else
            left+=("could not list instances inside $v in $r")
          fi
          if json="$(awsq "$r" ec2 describe-network-interfaces --filters "Name=vpc-id,Values=$v")"; then
            while IFS= read -r x; do [ -n "$x" ] && left+=("untagged inside lab VPC: $x"); done < <(jq -r --arg id "$LAB_ID" '.NetworkInterfaces[]? | select(.RequesterManaged != true and .Attachment.InstanceId == null) | (.TagSet // .Tags // []) as $t | select(any($t[]; .Key == "cloudlabs-lab" and .Value == $id) | not) | ($t | map(select(.Key == "Name"))[0].Value // "") as $n | .NetworkInterfaceId + (if $n == "" then "" else " (" + $n + ")" end)' <<<"$json")
          else
            left+=("could not list network interfaces inside $v in $r")
          fi
        fi ;;
      unknown) left+=("${C_T[$i]} ${C_I[$i]} (could not read its state)") ;;
      nohandler) left+=("no handler for ${C_T[$i]}: ${C_I[$i]}${NT:+ ($NT)}") ;;
    esac
  done
  json="$(jq -cn '$ARGS.positional' --args "${left[@]}")"
  if [ "${#left[@]}" -eq 0 ]; then clean=true; else clean=false; fi
  echo "clean=$clean"
  echo "leftovers=$json"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    { echo "clean=$clean"; echo "leftovers=$json"; } >>"$GITHUB_OUTPUT"
  fi
  [ "$clean" = true ] && exit 0
  exit 1
fi

# ── Sweep ────────────────────────────────────────────────────────────────

# wr <i> <what> <aws args...>: one write, in the item's region (IAM's none). True when AWS took it or
# the item is already gone; a refusal is a warning (its code in WCODE).
WCODE=""
wr() {
  local i="$1" what="$2" r="${C_R[$1]}"
  shift 2
  WCODE=""
  if [ "$r" = iam ]; then awsx "$@" >/dev/null; else awsx "$@" --region "$r" >/dev/null; fi && { echo "safety net: $what"; return 0; }
  gone_err && return 0
  WCODE="$(code)"
  [ "${QUIET_DEPENDENCY:-}" = 1 ] && [ "$WCODE" = DependencyViolation ] && return 1
  [ -n "${QUIET_CODE:-}" ] && [ "$WCODE" = "$QUIET_CODE" ] && return 1
  warn "could not $what ($WCODE)"
  return 1
}

# of_type <type>: the indices of that type's items, never one carrying the VPN server's tag.
of_type() {
  local i
  for i in "${!C_T[@]}"; do
    [ "${C_T[$i]}" = "$1" ] && [ "${C_W[$i]}" != 1 ] && echo "$i"
  done
}

# The VPN server's VPCs (tag wg-admin = vpn), per region with EC2 items.
declare -A WG_VPCS=() WG_BLIND=()
find_wg_vpcs() {
  local r="$1" json v
  if json="$(awsq "$r" ec2 describe-vpcs --filters Name=tag:wg-admin,Values=vpn)"; then
    while IFS= read -r v; do [ -n "$v" ] && WG_VPCS["$r|$v"]=1; done < <(jq -r '.Vpcs[]?.VpcId // empty' <<<"$json")
  else
    WG_BLIND[$r]=1
    warn "could not find the VPN server's VPC in $r ($(code)); nothing inside a VPC there is deleted"
  fi
}
# vpc_ok <i>: describes an item that lives in a VPC (DJ) and is true when it may be deleted: AWS
# answered, and it is not inside (nor is) the VPN server's VPC. Otherwise warns and is false.
vpc_ok() {
  local i="$1" r="${C_R[$1]}" v rc
  if [ -n "${WG_BLIND[$r]:-}" ]; then
    warn "not deleted: $(label "$i") (the VPN server's VPC in $r is not known)"
    return 1
  fi
  describe "$i"
  rc=$?
  [ "$rc" -eq 1 ] && return 1
  if [ "$rc" -ne 0 ]; then
    warn "not deleted: $(label "$i") (could not read it: $(code))"
    return 1
  fi
  # An empty answer (exit 0, nothing listed) passes: a describe by id of an item AWS no longer has
  # answers NotFound (rc 1, above), never an empty list, so an empty answer only comes from a fake AWS
  # (the tests' no-state fixtures describe nothing), and the delete then answers NotFound harmlessly.
  # It is still never inside the VPN server's VPC: the checks below find no VpcId to match.
  while IFS= read -r v; do
    if [ -n "$v" ] && [ -n "${WG_VPCS["$r|$v"]:-}" ]; then
      warn "never touched: $(label "$i") is inside the VPN server's VPC"
      return 1
    fi
  done < <(jq -r '.VpcId // empty, (.Attachments // [] | .[].VpcId // empty)' <<<"$DJ" 2>/dev/null)
  return 0
}

# wait_gone <i...>: poll until each is gone, or UNTIL; what is left is a warning.
wait_gone() {
  local left=("$@") next i
  while :; do
    next=()
    for i in "${left[@]}"; do
      judge "$i"
      [ "$J" = gone ] || next+=("$i")
    done
    left=("${next[@]}")
    [ "${#left[@]}" -eq 0 ] && return 0
    past_until && break
    echo "safety net: waiting for ${#left[@]} item(s) to go"
    sleep "$POLL_S"
  done
  for i in "${left[@]}"; do warn "left behind: $(label "$i")"; done
}

# run <type> <poll|-> <handler>: the handler for each item of the type; then, for "poll", a wait
# for every item whose delete AWS took.
run() {
  local t="$1" poll="$2" fn="$3" i
  local -a issued=()
  for i in $(of_type "$t"); do "$fn" "$i" && issued+=("$i"); done
  [ "$poll" = poll ] && [ "${#issued[@]}" -gt 0 ] && wait_gone "${issued[@]}"
  return 0
}

# readable <i>: describes the item (DJ) and is true when AWS answered. Not found is quietly false; any other failure
# is a warning and false, so nothing is deleted blind (review I2, M4).
readable() {
  local rc
  describe "$1"
  rc=$?
  [ "$rc" -eq 0 ] && return 0
  [ "$rc" -ne 1 ] && warn "could not read $(label "$1") ($(code))"
  return 1
}
# mid_delete <i> <status query>: MD = gone (AWS no longer has it), deleting (a destroy that ran out of time left it being
# deleted, and AWS refuses a second delete: the handler returns 0 so the poll waits for it, as rds_wait does; review
# I1) or empty (ask for the delete).
mid_delete() {
  MD=""
  describe "$1"
  [ $? -eq 1 ] && { MD=gone; return; }
  [ "$(jq -r "($2 // \"\") | ascii_downcase" <<<"$DJ" 2>/dev/null)" = deleting ] && MD=deleting
  return 0
}

# ── Handlers ──
# Phase 1, workloads. CloudFormation stacks first (ruling P4): deleted and waited for; one that ends DELETE_FAILED
# (a resource its role could not remove, or a hand-made change) is deleted again with FORCE_DELETE_STACK, which leaves
# those resources: they carry the stack's tags, so their own handlers below remove them.
stack_status() {
  describe "$1"
  case $? in
    0) if [ -z "$DJ" ]; then echo DELETE_COMPLETE; else jq -r '.StackStatus // "DELETE_COMPLETE"' <<<"$DJ"; fi ;;
    1) echo DELETE_COMPLETE ;;
    *) echo UNKNOWN ;;
  esac
}
stacks() {
  local i s pass
  local -a left next
  for pass in 1 2; do
    left=()
    for i in $(of_type cloudformation:stack); do
      s="$(stack_status "$i")"
      case "$s" in
        DELETE_COMPLETE | UNKNOWN) ;;
        DELETE_IN_PROGRESS) left+=("$i") ;;
        DELETE_FAILED) wr "$i" "force-delete $(label "$i") (DELETE_FAILED: what it could not delete is left to its own handler)" cloudformation delete-stack --stack-name "${C_A[$i]}" --deletion-mode FORCE_DELETE_STACK && left+=("$i") ;;
        *) [ "$pass" = 1 ] && wr "$i" "delete $(label "$i")" cloudformation delete-stack --stack-name "${C_A[$i]}" && left+=("$i") ;;
      esac
    done
    while [ "${#left[@]}" -gt 0 ]; do
      next=()
      for i in "${left[@]}"; do [[ "$(stack_status "$i")" == *_IN_PROGRESS ]] && next+=("$i"); done
      left=("${next[@]}")
      [ "${#left[@]}" -eq 0 ] && break
      if past_until; then
        for i in "${left[@]}"; do warn "left behind: $(label "$i")"; done
        return 0
      fi
      echo "safety net: waiting for ${#left[@]} stack(s) to delete"
      sleep "$POLL_S"
    done
  done
}
# ECS (ruling P12): services scaled to 0 and deleted, running tasks stopped, clusters deleted once their tasks are gone,
# task definitions deregistered and deleted (Terraform only deregisters, and the tagging API lists them for ever).
del_ecs_service() {
  local i="$1"
  describe "$i"
  [ $? -eq 1 ] && return 1
  [ "$(jq -r '.status // ""' <<<"$DJ" 2>/dev/null)" = INACTIVE ] && return 1
  wr "$i" "scale $(label "$i") to 0" ecs update-service --cluster "${C_I[$i]%%/*}" --service "${C_A[$i]}" --desired-count 0
  wr "$i" "delete $(label "$i")" ecs delete-service --cluster "${C_I[$i]%%/*}" --service "${C_A[$i]}" --force
}
del_ecs_task() {
  local i="$1"
  describe "$i"
  [ $? -eq 1 ] && return 1
  [ "$(jq -r '.lastStatus // "STOPPED"' <<<"$DJ" 2>/dev/null)" = STOPPED ] && return 1
  wr "$i" "stop $(label "$i")" ecs stop-task --cluster "${C_I[$i]%%/*}" --task "${C_A[$i]}"
}
ecs_clusters() {
  local i pass
  local -a left next
  mapfile -t left < <(of_type ecs:cluster)
  for pass in 1 2 3 4 5 6 7 8 9 10; do
    next=()
    for i in "${left[@]}"; do
      judge "$i"
      [ "$J" = gone ] && continue
      wr "$i" "delete $(label "$i")" ecs delete-cluster --cluster "${C_A[$i]}" || case "$WCODE" in ClusterContains*) next+=("$i") ;; esac
    done
    left=("${next[@]}")
    [ "${#left[@]}" -eq 0 ] && return 0
    past_until && break
    echo "safety net: waiting for the tasks of ${#left[@]} ECS cluster(s) to stop (pass $pass)"
    sleep "$POLL_S"
  done
  for i in "${left[@]}"; do warn "left behind: $(label "$i") (its tasks are still stopping)"; done
}
del_taskdef() {
  local i="$1"
  describe "$i"
  [ $? -eq 1 ] && return 1
  case "$(jq -r '.status // ""' <<<"$DJ" 2>/dev/null)" in
    DELETE_IN_PROGRESS) return 1 ;;
    ACTIVE) wr "$i" "deregister $(label "$i")" ecs deregister-task-definition --task-definition "${C_A[$i]}" ;;
  esac
  wr "$i" "delete $(label "$i")" ecs delete-task-definitions --task-definitions "${C_A[$i]}"
}
del_lambda() { wr "$1" "delete $(label "$1")" lambda delete-function --function-name "${C_I[$1]%%:*}"; }
del_asg() { wr "$1" "delete $(label "$1")" autoscaling delete-auto-scaling-group --auto-scaling-group-name "${C_I[$1]}" --force-delete; }
del_rule() {
  local i="$1" id="${C_I[$1]}" json
  local -a bus=() ids=()
  [[ "$id" == */* ]] && bus=(--event-bus-name "${id%/*}")
  if json="$(awsq "${C_R[$i]}" events list-targets-by-rule --rule "${id##*/}" "${bus[@]}")"; then
    mapfile -t ids < <(jq -r '.Targets[]?.Id // empty' <<<"$json")
    [ "${#ids[@]}" -gt 0 ] && wr "$i" "remove the targets of $(label "$i")" events remove-targets --rule "${id##*/}" "${bus[@]}" --ids "${ids[@]}"
  elif ! gone_err; then
    warn "could not list the targets of $(label "$i") ($(code))"
  fi
  wr "$i" "delete $(label "$i")" events delete-rule --name "${id##*/}" "${bus[@]}"
}
del_config_rule() {
  local i="$1" name rc
  describe "$i"
  rc=$?
  [ "$rc" -eq 1 ] && return 1
  if [ "$rc" -ne 0 ]; then
    warn "could not read $(label "$i") to find its name ($(code))"
    return 1
  fi
  name="$(jq -r '.ConfigRuleName // empty' <<<"$DJ")"
  [ -n "$name" ] || return 1
  wr "$i" "delete the remediation of $(label "$i")" configservice delete-remediation-configuration --config-rule-name "$name"
  wr "$i" "delete $(label "$i") ($name)" configservice delete-config-rule --config-rule-name "$name"
}
stop_recorder() { wr "$1" "stop $(label "$1")" configservice stop-configuration-recorder --configuration-recorder-name "${C_I[$1]}"; }
del_channel() { wr "$1" "delete $(label "$1")" configservice delete-delivery-channel --delivery-channel-name "${C_I[$1]}"; }
del_recorder() { wr "$1" "delete $(label "$1")" configservice delete-configuration-recorder --configuration-recorder-name "${C_I[$1]}"; }

# Phase 1, workloads (batch 3). EKS: node groups, then clusters (AWS refuses a cluster that still has node groups),
# each waited for until AWS no longer has it (V: minutes each; Task 17 records them). One a timed-out destroy left
# DELETING is not asked again (AWS refuses that) but waited for all the same (review I1); so are streams and cache groups.
del_nodegroup() { mid_delete "$1" .status; case "$MD" in gone) return 1 ;; deleting) return 0 ;; esac; wr "$1" "delete $(label "$1")" eks delete-nodegroup --cluster-name "${C_I[$1]%%/*}" --nodegroup-name "$(cut -d/ -f2 <<<"${C_I[$1]}")"; }
del_eks() { mid_delete "$1" .status; case "$MD" in gone) return 1 ;; deleting) return 0 ;; esac; wr "$1" "delete $(label "$1")" eks delete-cluster --name "${C_I[$1]}"; }
# An HTTP API takes its stages, routes, integrations and authorisers with it; a stage still listed is only judged.
del_api() { wr "$1" "delete $(label "$1")" apigatewayv2 delete-api --api-id "${C_I[$1]}"; }
del_sfn() { wr "$1" "delete $(label "$1")" stepfunctions delete-state-machine --state-machine-arn "${C_A[$1]}"; }
# A bus's rules go first, by the events:rule handler (bus-qualified); then the bus.
del_bus() { wr "$1" "delete $(label "$1")" events delete-event-bus --name "${C_I[$1]}"; }
del_firehose() { mid_delete "$1" .DeliveryStreamStatus; case "$MD" in gone) return 1 ;; deleting) return 0 ;; esac; wr "$1" "delete $(label "$1")" firehose delete-delivery-stream --delivery-stream-name "${C_I[$1]}" --allow-force-delete; }
del_stream() { mid_delete "$1" .StreamStatus; case "$MD" in gone) return 1 ;; deleting) return 0 ;; esac; wr "$1" "delete $(label "$1")" kinesis delete-stream --stream-name "${C_I[$1]}" --enforce-consumer-deletion; }
# Ruling P21: a running crawler is stopped and waited for (AWS refuses to delete one that runs). One that cannot be
# read is a warning, never a wait (pre-flight C10).
del_crawler() {
  local i="$1" s rc k=0
  while :; do
    describe "$i"
    rc=$?
    [ "$rc" -eq 1 ] && return 1
    if [ "$rc" -ne 0 ]; then
      warn "could not read $(label "$i") ($(code))"
      return 1
    fi
    # An empty answer is no crawler (as judge counts it), never a state to wait on.
    [ -n "$DJ" ] || return 1
    s="$(jq -r '.State // "READY"' <<<"$DJ" 2>/dev/null)"
    [ "$s" = READY ] && break
    [ "$s" = RUNNING ] && [ "$k" -eq 0 ] && wr "$i" "stop $(label "$i")" glue stop-crawler --name "${C_I[$i]}"
    k=$((k + 1))
    if past_until; then
      warn "left behind: $(label "$i") (still $s)"
      return 1
    fi
    echo "safety net: waiting for $(label "$i") to stop"
    sleep "$POLL_S"
  done
  wr "$i" "delete $(label "$i")" glue delete-crawler --name "${C_I[$i]}"
}
# A database takes its tables, the crawler's too, with it.
del_gluedb() { wr "$1" "delete $(label "$1") and its tables" glue delete-database --name "${C_I[$1]}"; }
del_workgroup() { wr "$1" "delete $(label "$1") and its saved queries" athena delete-work-group --work-group "${C_I[$1]}" --recursive-delete-option; }

# Phase 2, edge and DNS. CloudFront (spec §15, slow deletes): every enabled distribution is disabled; then each is
# waited for until Deployed (AWS takes minutes; V up to 20, by UNTIL) and deleted with its newest ETag; then the lab's
# origin access controls, each with its own ETag.
distributions() {
  local i id json etag s e
  local -a left next
  for i in $(of_type cloudfront:distribution); do
    id="${C_I[$i]}"
    if ! json="$(awsq "${C_R[$i]}" cloudfront get-distribution-config --id "$id")"; then
      gone_err || warn "could not read $(label "$i") ($(code))"
      continue
    fi
    if [ "$(jq -r '.DistributionConfig.Enabled' <<<"$json")" = true ]; then
      jq '.DistributionConfig | .Enabled = false' <<<"$json" >"$TMPD/cf-$id.json"
      wr "$i" "disable $(label "$i")" cloudfront update-distribution --id "$id" --if-match "$(jq -r '.ETag' <<<"$json")" --distribution-config "file://$TMPD/cf-$id.json" || continue
    fi
    left+=("$i")
  done
  while [ "${#left[@]}" -gt 0 ]; do
    next=()
    for i in "${left[@]}"; do
      if ! json="$(awsq "${C_R[$i]}" cloudfront get-distribution --id "${C_I[$i]}")"; then
        gone_err || { warn "could not read $(label "$i") ($(code))"; next+=("$i"); }
        continue
      fi
      s="$(jq -r '.Distribution.Status // ""' <<<"$json")"
      e="$(jq -r '.Distribution.DistributionConfig.Enabled' <<<"$json")"
      if [ "$s" = Deployed ] && [ "$e" = false ]; then
        etag="$(jq -r '.ETag' <<<"$json")"
        wr "$i" "delete $(label "$i")" cloudfront delete-distribution --id "${C_I[$i]}" --if-match "$etag"
      else
        next+=("$i")
      fi
    done
    left=("${next[@]}")
    [ "${#left[@]}" -eq 0 ] && break
    if past_until; then
      for i in "${left[@]}"; do warn "left behind: $(label "$i") (still deploying its disabled configuration)"; done
      return 0
    fi
    echo "safety net: waiting for ${#left[@]} CloudFront distribution(s) to finish disabling"
    sleep "$POLL_S"
  done
}
del_oac() {
  local i="$1" json
  if ! json="$(awsq "${C_R[$i]}" cloudfront get-origin-access-control --id "${C_I[$i]}")"; then
    gone_err || warn "could not read $(label "$i") ($(code))"
    return 1
  fi
  wr "$i" "delete $(label "$i")" cloudfront delete-origin-access-control --id "${C_I[$i]}" --if-match "$(jq -r '.ETag' <<<"$json")"
}
# Route 53: every record but the zone's own NS and SOA, as one change batch, then the zone; health checks after (a
# record that names one would stop its delete).
del_zone() {
  local i="$1" z="${C_I[$1]}" json name
  if ! json="$(awsq "${C_R[$i]}" route53 get-hosted-zone --id "$z")"; then
    gone_err || warn "could not read $(label "$i") ($(code))"
    return 1
  fi
  name="$(jq -r '.HostedZone.Name' <<<"$json")"
  if ! json="$(awsq "${C_R[$i]}" route53 list-resource-record-sets --hosted-zone-id "$z")"; then
    warn "could not list the records of $(label "$i") ($(code))"
    return 1
  fi
  jq --arg n "$name" '{Changes: [.ResourceRecordSets[]? | select(((.Type == "NS" or .Type == "SOA") and .Name == $n) | not) | {Action: "DELETE", ResourceRecordSet: .}]}' <<<"$json" >"$TMPD/rr-$z.json"
  if [ "$(jq '.Changes | length' "$TMPD/rr-$z.json")" -gt 0 ]; then
    wr "$i" "delete the records of $(label "$i")" route53 change-resource-record-sets --hosted-zone-id "$z" --change-batch "file://$TMPD/rr-$z.json"
  fi
  wr "$i" "delete $(label "$i")" route53 delete-hosted-zone --id "$z"
}
del_healthcheck() { wr "$1" "delete $(label "$1")" route53 delete-health-check --health-check-id "${C_I[$1]}"; }

# Phase 3, network services.
del_lb() { wr "$1" "delete $(label "$1")" elbv2 delete-load-balancer --load-balancer-arn "${C_A[$1]}"; }
del_tg() { wr "$1" "delete $(label "$1")" elbv2 delete-target-group --target-group-arn "${C_A[$1]}"; }
# Listeners and their rules go with their load balancer (deleted above), so most answer "not found" here and
# nothing more is asked. One still there (its load balancer is not among the lab's items, or stayed) is deleted
# by its ARN: rules, then listeners, before the target groups they forward to. A listener's default rule goes
# with the listener.
del_lb_child() {
  local i="$1" rc
  describe "$i"
  rc=$?
  [ "$rc" -eq 1 ] && return 1
  if [ "$rc" -ne 0 ]; then
    warn "not deleted: $(label "$i") (could not read it: $(code))"
    return 1
  fi
  [ -n "$DJ" ] || return 1
  if [ "${C_T[$i]}" = elasticloadbalancing:listener ]; then
    wr "$i" "delete $(label "$i")" elbv2 delete-listener --listener-arn "${C_A[$i]}"
  else
    [ "$(jq -r '.IsDefault // false' <<<"$DJ")" = true ] && return 1
    wr "$i" "delete $(label "$i")" elbv2 delete-rule --rule-arn "${C_A[$i]}"
  fi
}
del_db() { wr "$1" "delete $(label "$1")" rds delete-db-instance --db-instance-identifier "${C_I[$1]}" --skip-final-snapshot --delete-automated-backups; }
del_subgrp() { wr "$1" "delete $(label "$1")" rds delete-db-subnet-group --db-subnet-group-name "${C_I[$1]}"; }
del_pg() { wr "$1" "delete $(label "$1")" rds delete-db-parameter-group --db-parameter-group-name "${C_I[$1]}"; }
# An automated snapshot (rds:<db>-<time>) goes with its database (deleted with --delete-automated-backups), minutes
# later: AWS refuses to delete one by itself (ruling A58). Verify clean waits for it.
del_dbsnap() {
  [[ "${C_I[$1]}" == rds:* ]] && return 1
  wr "$1" "delete $(label "$1")" rds delete-db-snapshot --db-snapshot-identifier "${C_I[$1]}"
}
del_instance() { vpc_ok "$1" && wr "$1" "terminate $(label "$1")" ec2 terminate-instances --instance-ids "${C_I[$1]}"; }
del_lt() { wr "$1" "delete $(label "$1")" ec2 delete-launch-template --launch-template-id "${C_I[$1]}"; }
del_nat() { vpc_ok "$1" && wr "$1" "delete $(label "$1")" ec2 delete-nat-gateway --nat-gateway-id "${C_I[$1]}"; }
del_eip() { wr "$1" "release $(label "$1")" ec2 release-address --allocation-id "${C_I[$1]}"; }
del_pcx() { wr "$1" "delete $(label "$1")" ec2 delete-vpc-peering-connection --vpc-peering-connection-id "${C_I[$1]}"; }
del_vpce() { vpc_ok "$1" && wr "$1" "delete $(label "$1")" ec2 delete-vpc-endpoints --vpc-endpoint-ids "${C_I[$1]}"; }
# One Terraform already deleted (the tagging API still lists it) is not asked again: AWS refuses that.
del_eice() {
  vpc_ok "$1" || return 1
  case "$(jq -r '.State // empty' <<<"$DJ" 2>/dev/null)" in
    delete-complete) return 1 ;;
    delete-in-progress) return 0 ;;
  esac
  wr "$1" "delete $(label "$1")" ec2 delete-instance-connect-endpoint --instance-connect-endpoint-id "${C_I[$1]}"
}
del_volume() { wr "$1" "delete $(label "$1")" ec2 delete-volume --volume-id "${C_I[$1]}"; }
# Flow logs, before the VPC fabric.
del_flowlog() { wr "$1" "delete $(label "$1")" ec2 delete-flow-logs --flow-log-ids "${C_I[$1]}"; }
# RDS: read replicas first (ReadReplicaSourceDBInstanceIdentifier set), then the rest.
rds_dbs() {
  local i want="$1" rep
  local -a got=()
  for i in $(of_type rds:db); do
    rep=no
    describe "$i" && [ -n "$(jq -r '.ReadReplicaSourceDBInstanceIdentifier // empty' <<<"$DJ" 2>/dev/null)" ] && rep=yes
    [ "$rep" = "$want" ] || continue
    # Refused with InvalidDBInstanceState: it is already being deleted, or still busy (Unblock's
    # modify-db-instance leaves it "modifying" for a while). Wait for it all the same, so the subnet and
    # parameter group deletes after it do not fail; rds_wait asks again once it is free.
    if QUIET_CODE=InvalidDBInstanceState del_db "$i"; then
      got+=("$i")
    elif [ "$WCODE" = InvalidDBInstanceState ]; then
      echo "safety net: $(label "$i") is busy (being deleted or modified); waiting for it"
      got+=("$i")
    fi
  done
  [ "${#got[@]}" -gt 0 ] && rds_wait "${got[@]}"
  return 0
}
# rds_wait <i...>: as wait_gone, but an instance that is still there and not "deleting" (it was busy when
# the delete was asked) is asked again.
rds_wait() {
  local left=("$@") next i s
  while :; do
    next=()
    for i in "${left[@]}"; do
      judge "$i"
      [ "$J" = gone ] && continue
      next+=("$i")
      s="$(jq -r '.DBInstanceStatus // ""' <<<"$DJ" 2>/dev/null)"
      [ "$J" = there ] && [ -n "$s" ] && [ "$s" != deleting ] && QUIET_CODE=InvalidDBInstanceState del_db "$i"
    done
    left=("${next[@]}")
    [ "${#left[@]}" -eq 0 ] && return 0
    past_until && break
    echo "safety net: waiting for ${#left[@]} database(s) to go"
    sleep "$POLL_S"
  done
  for i in "${left[@]}"; do warn "left behind: $(label "$i")"; done
}

# Phase 3, network services (batch 3): ElastiCache and EFS hold network interfaces in the lab's subnets.
del_cache_group() { mid_delete "$1" .Status; case "$MD" in gone) return 1 ;; deleting) return 0 ;; esac; wr "$1" "delete $(label "$1")" elasticache delete-replication-group --replication-group-id "${C_I[$1]}" --no-retain-primary-cluster; }
# A cluster in a replication group goes with it; only a cluster of its own is deleted here.
del_cache_cluster() {
  local i="$1"
  readable "$i" || return 1
  [ -n "$(jq -r '.ReplicationGroupId // empty' <<<"$DJ" 2>/dev/null)" ] && return 1
  wr "$i" "delete $(label "$i")" elasticache delete-cache-cluster --cache-cluster-id "${C_I[$i]}"
}
del_cache_subnets() { wr "$1" "delete $(label "$1")" elasticache delete-cache-subnet-group --cache-subnet-group-name "${C_I[$1]}"; }
del_cache_snapshot() { wr "$1" "delete $(label "$1")" elasticache delete-snapshot --snapshot-name "${C_I[$1]}"; }
# EFS: every mount target, waited for, then the file system.
del_efs() {
  local i="$1" fs="${C_I[$1]}" json m left
  if ! json="$(awsq "${C_R[$i]}" efs describe-mount-targets --file-system-id "$fs")"; then
    gone_err && return 1
    warn "could not list the mount targets of $(label "$i") ($(code))"
    return 1
  fi
  while IFS= read -r m; do [ -n "$m" ] && wr "$i" "delete mount target $m of $(label "$i")" efs delete-mount-target --mount-target-id "$m"; done < <(jq -r '.MountTargets[]?.MountTargetId // empty' <<<"$json")
  while :; do
    json="$(awsq "${C_R[$i]}" efs describe-mount-targets --file-system-id "$fs")" || break
    left="$(jq '.MountTargets // [] | length' <<<"$json" 2>/dev/null)"
    [ "${left:-0}" -eq 0 ] && break
    if past_until; then
      warn "left behind: $(label "$i") ($left mount target(s) still being deleted)"
      return 1
    fi
    echo "safety net: waiting for $left mount target(s) of $(label "$i")"
    sleep "$POLL_S"
  done
  wr "$i" "delete $(label "$i")" efs delete-file-system --file-system-id "$fs"
}

# Phase 4, VPC fabric: synchronous (ruling C15). FAB_DONE marks an item settled (deleted, gone, skipped
# or refused); one refused with DependencyViolation is tried again in the next pass.
declare -A FAB_DONE=() SG_SKIP=()
fab() {
  local i="$1"
  shift
  if QUIET_DEPENDENCY=1 wr "$i" "$@"; then FAB_DONE[$i]=1; return 0; fi
  [ "$WCODE" = DependencyViolation ] || FAB_DONE[$i]=1
  return 1
}
fab_eni() {
  vpc_ok "$1" || { FAB_DONE[$1]=1; return; }
  if [ "$(jq -r '.Status // "available"' <<<"$DJ")" != available ]; then
    warn "not deleted: $(label "$1") is attached (Verify clean judges it)"
    FAB_DONE[$1]=1
    return
  fi
  fab "$1" "delete $(label "$1")" ec2 delete-network-interface --network-interface-id "${C_I[$1]}"
}
# Rules of a lab group that name another lab group would stop that group's delete: revoked first.
revoke_sg_refs() {
  local i labs perms dir key
  labs="$(for i in $(of_type ec2:security-group); do echo "${C_I[$i]}"; done | jq -Rcs 'split("\n") | map(select(. != ""))')"
  for i in $(of_type ec2:security-group); do
    if ! vpc_ok "$i"; then SG_SKIP[$i]=1; continue; fi
    if [ "$(jq -r '.GroupName // ""' <<<"$DJ")" = default ]; then SG_SKIP[$i]=1; continue; fi
    for dir in ingress egress; do
      if [ "$dir" = ingress ]; then key=IpPermissions; else key=IpPermissionsEgress; fi
      perms="$(jq -c --argjson labs "$labs" --arg k "$key" '[.[$k][]? | {IpProtocol, FromPort, ToPort, UserIdGroupPairs: [.UserIdGroupPairs[]? | select(.GroupId as $g | $labs | index($g)) | {GroupId}]} | select(.UserIdGroupPairs | length > 0) | with_entries(select(.value != null))]' <<<"$DJ" 2>/dev/null)"
      [ -n "$perms" ] && [ "$perms" != "[]" ] && wr "$i" "revoke the $dir rules of $(label "$i") that name another lab group" ec2 "revoke-security-group-$dir" --group-id "${C_I[$i]}" --ip-permissions "$perms"
    done
  done
}
fab_sg() {
  [ -n "${SG_SKIP[$1]:-}" ] && { FAB_DONE[$1]=1; return; }
  fab "$1" "delete $(label "$1")" ec2 delete-security-group --group-id "${C_I[$1]}"
}
fab_subnet() {
  vpc_ok "$1" || { FAB_DONE[$1]=1; return; }
  fab "$1" "delete $(label "$1")" ec2 delete-subnet --subnet-id "${C_I[$1]}"
}
fab_rt() {
  local a
  vpc_ok "$1" || { FAB_DONE[$1]=1; return; }
  # A VPC's main route table goes with the VPC.
  if jq -e 'any(.Associations[]?; .Main == true)' <<<"$DJ" >/dev/null 2>&1; then FAB_DONE[$1]=1; return; fi
  while IFS= read -r a; do
    [ -n "$a" ] && wr "$1" "disassociate $(label "$1") from a subnet" ec2 disassociate-route-table --association-id "$a"
  done < <(jq -r '.Associations[]? | select(.Main != true) | .RouteTableAssociationId // empty' <<<"$DJ")
  fab "$1" "delete $(label "$1")" ec2 delete-route-table --route-table-id "${C_I[$1]}"
}
fab_acl() {
  vpc_ok "$1" || { FAB_DONE[$1]=1; return; }
  if [ "$(jq -r '.IsDefault // false' <<<"$DJ")" = true ]; then FAB_DONE[$1]=1; return; fi
  fab "$1" "delete $(label "$1")" ec2 delete-network-acl --network-acl-id "${C_I[$1]}"
}
fab_igw() {
  local v
  vpc_ok "$1" || { FAB_DONE[$1]=1; return; }
  while IFS= read -r v; do
    [ -n "$v" ] && wr "$1" "detach $(label "$1") from $v" ec2 detach-internet-gateway --internet-gateway-id "${C_I[$1]}" --vpc-id "$v"
  done < <(jq -r '.Attachments[]?.VpcId // empty' <<<"$DJ")
  fab "$1" "delete $(label "$1")" ec2 delete-internet-gateway --internet-gateway-id "${C_I[$1]}"
}
fab_eigw() {
  vpc_ok "$1" || { FAB_DONE[$1]=1; return; }
  fab "$1" "delete $(label "$1")" ec2 delete-egress-only-internet-gateway --egress-only-internet-gateway-id "${C_I[$1]}"
}
fab_pl() { fab "$1" "delete $(label "$1")" ec2 delete-managed-prefix-list --prefix-list-id "${C_I[$1]}"; }
fab_vpc() {
  vpc_ok "$1" || { FAB_DONE[$1]=1; return; }
  fab "$1" "delete $(label "$1")" ec2 delete-vpc --vpc-id "${C_I[$1]}"
}
# A security group rule goes with its group (deleted above), so it normally answers "not found" here and
# nothing more is asked. One still there (its group is not among the lab's items, or stayed) is revoked by its
# id, never when its group is inside the VPN server's VPC or that VPC is not known.
del_sgr() {
  local i="$1" r="${C_R[$1]}" rc g dir json v
  if [ -n "${WG_BLIND[$r]:-}" ]; then
    warn "not deleted: $(label "$i") (the VPN server's VPC in $r is not known)"
    return 1
  fi
  describe "$i"
  rc=$?
  [ "$rc" -eq 1 ] && return 1
  if [ "$rc" -ne 0 ]; then
    warn "not deleted: $(label "$i") (could not read it: $(code))"
    return 1
  fi
  [ -n "$DJ" ] || return 1
  g="$(jq -r '.GroupId // empty' <<<"$DJ")"
  [ "$(jq -r '.IsEgress // false' <<<"$DJ")" = true ] && dir=egress || dir=ingress
  [ -n "$g" ] || return 1
  if ! json="$(awsq "$r" ec2 describe-security-groups --group-ids "$g")"; then
    gone_err && return 1
    warn "not deleted: $(label "$i") (could not read its group: $(code))"
    return 1
  fi
  v="$(jq -r '.SecurityGroups[0]?.VpcId // empty' <<<"$json" 2>/dev/null)"
  if [ -z "$v" ] || [ -n "${WG_VPCS["$r|$v"]:-}" ] || jq -e '.SecurityGroups[0]? | any((.Tags // [])[]; .Key == "wg-admin")' <<<"$json" >/dev/null 2>&1; then
    warn "never touched: $(label "$i") is in a group inside the VPN server's VPC (or one it cannot place)"
    return 1
  fi
  wr "$i" "revoke $(label "$i")" ec2 "revoke-security-group-$dir" --group-id "$g" --security-group-rule-ids "${C_I[$i]}"
}
FABRIC=(ec2:network-interface:fab_eni ec2:security-group:fab_sg ec2:subnet:fab_subnet ec2:route-table:fab_rt ec2:network-acl:fab_acl ec2:internet-gateway:fab_igw ec2:egress-only-internet-gateway:fab_eigw ec2:prefix-list:fab_pl ec2:vpc:fab_vpc)
fabric() {
  local pass=1 e t fn i open
  revoke_sg_refs
  while :; do
    open=0
    for e in "${FABRIC[@]}"; do
      t="${e%:*}"
      fn="${e##*:}"
      for i in $(of_type "$t"); do
        [ -n "${FAB_DONE[$i]:-}" ] && continue
        "$fn" "$i"
        [ -n "${FAB_DONE[$i]:-}" ] || open=$((open + 1))
      done
    done
    [ "$open" -eq 0 ] && return 0
    { [ "$pass" -ge "$FABRIC_PASSES" ] || past_until; } && break
    echo "safety net: $open VPC item(s) still in use; trying again (pass $((pass + 1)) of $FABRIC_PASSES)"
    pass=$((pass + 1))
    sleep "$POLL_S"
  done
  for e in "${FABRIC[@]}"; do
    for i in $(of_type "${e%:*}"); do [ -n "${FAB_DONE[$i]:-}" ] || warn "left behind: $(label "$i") (DependencyViolation)"; done
  done
}

# Phase 5, data and the rest.
del_bucket() {
  local i="$1" b="${C_I[$1]}" json n k=0
  rm -f "$TMPD/deleted.json"
  while [ "$k" -lt 200 ]; do
    k=$((k + 1))
    if ! json="$(awsq "${C_R[$i]}" s3api list-object-versions --bucket "$b" --max-items 1000)"; then
      gone_err && return 0
      warn "could not list the objects in $(label "$i") ($(code))"
      break
    fi
    n="$(jq '[(.Versions // [])[], (.DeleteMarkers // [])[]] | length' <<<"$json" 2>/dev/null)"
    [ "${n:-0}" -eq 0 ] && break
    jq -c '{Objects: ([(.Versions // [])[], (.DeleteMarkers // [])[] | {Key, VersionId}] | .[:1000]), Quiet: true}' <<<"$json" >"$TMPD/delete.json"
    # The same versions again: AWS would not delete them (Object Lock, a legal hold). No point asking twice.
    if [ -f "$TMPD/deleted.json" ] && cmp -s "$TMPD/delete.json" "$TMPD/deleted.json"; then
      warn "$(label "$i") still holds $n object version(s) AWS will not delete (Object Lock?)"
      break
    fi
    mv "$TMPD/delete.json" "$TMPD/deleted.json"
    wr "$i" "delete $n object version(s) in $(label "$i")" s3api delete-objects --bucket "$b" --delete "file://$TMPD/deleted.json" || break
    past_until && break
  done
  wr "$i" "delete $(label "$i")" s3api delete-bucket --bucket "$b"
}
del_topic() { wr "$1" "delete $(label "$1")" sns delete-topic --topic-arn "${C_A[$1]}"; }
del_loggroup() { wr "$1" "delete $(label "$1")" logs delete-log-group --log-group-name "${C_I[$1]}"; }
del_alarm() { wr "$1" "delete $(label "$1")" cloudwatch delete-alarms --alarm-names "${C_I[$1]}"; }
del_dashboard() { wr "$1" "delete $(label "$1")" cloudwatch delete-dashboards --dashboard-names "${C_I[$1]}"; }
del_query() { [ -n "${C_A[$1]}" ] && wr "$1" "delete $(label "$1")" logs delete-query-definition --query-definition-id "${C_A[$1]}"; }
del_assoc() { wr "$1" "delete $(label "$1")" ssm delete-association --association-id "${C_I[$1]}"; }
del_baseline() {
  local i="$1" json g
  if json="$(awsq "${C_R[$i]}" ssm get-patch-baseline --baseline-id "${C_I[$i]}")"; then
    while IFS= read -r g; do
      [ -n "$g" ] && wr "$i" "take $(label "$i") off patch group $g" ssm deregister-patch-baseline-for-patch-group --baseline-id "${C_I[$i]}" --patch-group "$g"
    done < <(jq -r '.PatchGroups[]? // empty' <<<"$json")
  elif gone_err; then
    return 0
  fi
  wr "$i" "delete $(label "$i")" ssm delete-patch-baseline --baseline-id "${C_I[$i]}"
}
del_plan() {
  local i="$1" json s
  if json="$(awsq "${C_R[$i]}" backup list-backup-selections --backup-plan-id "${C_I[$i]}")"; then
    while IFS= read -r s; do
      [ -n "$s" ] && wr "$i" "delete a selection of $(label "$i")" backup delete-backup-selection --backup-plan-id "${C_I[$i]}" --selection-id "$s"
    done < <(jq -r '.BackupSelectionsList[]?.SelectionId // empty' <<<"$json")
  elif gone_err; then
    return 0
  fi
  wr "$i" "delete $(label "$i")" backup delete-backup-plan --backup-plan-id "${C_I[$i]}"
}
del_vault() { wr "$1" "delete $(label "$1")" backup delete-backup-vault --backup-vault-name "${C_I[$1]}"; }

# Phase 5, data and the rest (batch 3). Ruling P21: a global table's replicas in other regions are removed and waited
# for, then the table.
del_table() {
  local i="$1" t="${C_I[$1]}" r="${C_R[$1]}" rep n
  readable "$i" || return 1
  [ "$(jq -r '.TableStatus // ""' <<<"$DJ" 2>/dev/null)" = DELETING ] && return 1
  while IFS= read -r rep; do
    [ -n "$rep" ] && wr "$i" "remove the $rep replica of $(label "$i")" dynamodb update-table --table-name "$t" --replica-updates "Delete={RegionName=$rep}"
  done < <(jq -r --arg r "$r" '.Replicas[]?.RegionName // empty | select(. != $r)' <<<"$DJ" 2>/dev/null)
  while :; do
    describe "$i"
    [ $? -eq 1 ] && return 1
    # Review M1: and until the table is no longer UPDATING (or CREATING): AWS refuses to delete it until then.
    n="$(jq -r --arg r "$r" '([.Replicas[]? | select(.RegionName != $r)] | length) + (if (.TableStatus // "") | IN("UPDATING", "CREATING") then 1 else 0 end)' <<<"$DJ" 2>/dev/null)"
    [ "${n:-0}" -eq 0 ] && break
    # Final review 4: a removal AWS refused (the table was busy) is asked again once the table and that replica are
    # ACTIVE (one already being removed reads DELETING and is left to finish).
    if [ "$(jq -r '.TableStatus // ""' <<<"$DJ" 2>/dev/null)" = ACTIVE ]; then
      while IFS= read -r rep; do
        [ -n "$rep" ] && QUIET_CODE=ResourceInUseException wr "$i" "remove the $rep replica of $(label "$i")" dynamodb update-table --table-name "$t" --replica-updates "Delete={RegionName=$rep}"
      done < <(jq -r --arg r "$r" '.Replicas[]? | select(.RegionName != $r and (.ReplicaStatus // "ACTIVE") == "ACTIVE") | .RegionName' <<<"$DJ" 2>/dev/null)
    fi
    if past_until; then
      warn "left behind: $(label "$i") ($n replica(s) still being removed)"
      return 1
    fi
    echo "safety net: waiting for $n replica(s) of $(label "$i") to go"
    sleep "$POLL_S"
  done
  wr "$i" "delete $(label "$i")" dynamodb delete-table --table-name "$t"
}
# A pool's domains first (AWS refuses a pool that still has one); deletion protection off if Unblock could not.
del_userpool() {
  local i="$1" d
  # Final review 4: never deleted blind (a pool that cannot be read is warned about and left).
  readable "$i" || return 1
  for d in $(jq -r '.Domain // empty, .CustomDomain // empty' <<<"$DJ" 2>/dev/null); do
    wr "$i" "delete the domain $d of $(label "$i")" cognito-idp delete-user-pool-domain --domain "$d" --user-pool-id "${C_I[$i]}"
  done
  [ "$(jq -r '.DeletionProtection // ""' <<<"$DJ" 2>/dev/null)" = ACTIVE ] && wr "$i" "turn off deletion protection on $(label "$i")" cognito-idp update-user-pool --user-pool-id "${C_I[$i]}" --deletion-protection INACTIVE
  wr "$i" "delete $(label "$i")" cognito-idp delete-user-pool --user-pool-id "${C_I[$i]}"
}
# Ruling P4: an AMI copy's snapshots carry no tags, so they are read from the image and deleted after it.
del_image() {
  local i="$1" snaps s
  # Review I2: never deregister an image whose snapshots could not be read (they would be left where nothing finds them).
  readable "$i" || return 1
  # Final review 4: a copy still pending may not list its snapshots yet, so it is waited for first.
  while [ "$(jq -r '.State // ""' <<<"$DJ" 2>/dev/null)" = pending ]; do
    if past_until; then
      warn "left behind: $(label "$i") (still pending)"
      return 1
    fi
    echo "safety net: waiting for $(label "$i") to finish copying"
    sleep "$POLL_S"
    readable "$i" || return 1
  done
  snaps="$(jq -r '.BlockDeviceMappings[]?.Ebs.SnapshotId // empty' <<<"$DJ" 2>/dev/null)"
  wr "$i" "deregister $(label "$i")" ec2 deregister-image --image-id "${C_I[$i]}" || return 1
  for s in $snaps; do wr "$i" "delete snapshot $s of $(label "$i")" ec2 delete-snapshot --snapshot-id "$s"; done
}
del_snapshot() { wr "$1" "delete $(label "$1")" ec2 delete-snapshot --snapshot-id "${C_I[$1]}"; }
del_group() { wr "$1" "delete $(label "$1")" resource-groups delete-group --group "${C_I[$1]}"; }
del_queue() {
  local i="$1" json
  if ! json="$(awsq "${C_R[$i]}" sqs get-queue-url --queue-name "${C_I[$i]}")"; then
    gone_err || warn "could not find $(label "$i") ($(code))"
    return 1
  fi
  wr "$i" "delete $(label "$i")" sqs delete-queue --queue-url "$(jq -r '.QueueUrl' <<<"$json")"
}
del_param() { wr "$1" "delete $(label "$1")" ssm delete-parameter --name "/${C_I[$1]}"; }
del_alias() { wr "$1" "delete $(label "$1")" kms delete-alias --alias-name "${C_I[$1]}"; }
# Ruling P11: a key is scheduled for deletion with the shortest window (7 days, no charge while pending); one already
# pending is left as it is.
del_key() {
  local i="$1"
  describe "$i"
  [ $? -eq 1 ] && return 1
  [ "$(jq -r '.KeyState // ""' <<<"$DJ" 2>/dev/null)" = PendingDeletion ] && return 1
  wr "$i" "schedule $(label "$i") for deletion in 7 days" kms schedule-key-deletion --key-id "${C_I[$i]}" --pending-window-in-days 7
}
del_secret() { wr "$1" "delete $(label "$1") (no recovery window)" secretsmanager delete-secret --secret-id "${C_A[$1]}" --force-delete-without-recovery; }
del_repo() { wr "$1" "delete $(label "$1") and its images" ecr delete-repository --repository-name "${C_I[$1]}" --force; }
del_analyzer() { wr "$1" "delete $(label "$1")" accessanalyzer delete-analyzer --analyzer-name "${C_I[$1]}"; }

# Phase 6, IAM (names lab-<id>-* under /cloudlabs-lab/ only, as found above).
del_profile() {
  local i="$1" role
  for role in ${C_A[$i]}; do
    wr "$i" "remove $role from $(label "$i")" iam remove-role-from-instance-profile --instance-profile-name "${C_I[$i]}" --role-name "$role"
  done
  wr "$i" "delete $(label "$i")" iam delete-instance-profile --instance-profile-name "${C_I[$i]}"
}
del_role() {
  local i="$1" n="${C_I[$1]}" json p
  if json="$(awsq iam iam list-attached-role-policies --role-name "$n")"; then
    while IFS= read -r p; do
      [ -n "$p" ] && wr "$i" "detach a policy from $(label "$i")" iam detach-role-policy --role-name "$n" --policy-arn "$p"
    done < <(jq -r '.AttachedPolicies[]?.PolicyArn // empty' <<<"$json")
  else
    gone_err && return 0
    warn "could not list the policies attached to $(label "$i") ($(code))"
  fi
  if json="$(awsq iam iam list-role-policies --role-name "$n")"; then
    while IFS= read -r p; do
      [ -n "$p" ] && wr "$i" "delete policy $p of $(label "$i")" iam delete-role-policy --role-name "$n" --policy-name "$p"
    done < <(jq -r '.PolicyNames[]? // empty' <<<"$json")
  else
    warn "could not list the policies of $(label "$i") ($(code))"
  fi
  wr "$i" "delete $(label "$i")" iam delete-role --role-name "$n"
}
del_user() {
  local i="$1" n="${C_I[$1]}" json p
  wr "$i" "delete the console password of $(label "$i")" iam delete-login-profile --user-name "$n"
  # Credentials made by hand (the lab makes none): keys, MFA devices, SSH keys, signing certificates, service
  # credentials, each of which stops DeleteUser.
  if json="$(awsq iam iam list-access-keys --user-name "$n")"; then
    while IFS= read -r p; do [ -n "$p" ] && wr "$i" "delete an access key of $(label "$i")" iam delete-access-key --user-name "$n" --access-key-id "$p"; done < <(jq -r '.AccessKeyMetadata[]?.AccessKeyId // empty' <<<"$json")
  fi
  if json="$(awsq iam iam list-mfa-devices --user-name "$n")"; then
    while IFS= read -r p; do [ -n "$p" ] && wr "$i" "deactivate an MFA device of $(label "$i")" iam deactivate-mfa-device --user-name "$n" --serial-number "$p"; done < <(jq -r '.MFADevices[]?.SerialNumber // empty' <<<"$json")
  fi
  if json="$(awsq iam iam list-ssh-public-keys --user-name "$n")"; then
    while IFS= read -r p; do [ -n "$p" ] && wr "$i" "delete an SSH key of $(label "$i")" iam delete-ssh-public-key --user-name "$n" --ssh-public-key-id "$p"; done < <(jq -r '.SSHPublicKeys[]?.SSHPublicKeyId // empty' <<<"$json")
  fi
  if json="$(awsq iam iam list-signing-certificates --user-name "$n")"; then
    while IFS= read -r p; do [ -n "$p" ] && wr "$i" "delete a signing certificate of $(label "$i")" iam delete-signing-certificate --user-name "$n" --certificate-id "$p"; done < <(jq -r '.Certificates[]?.CertificateId // empty' <<<"$json")
  fi
  if json="$(awsq iam iam list-service-specific-credentials --user-name "$n")"; then
    while IFS= read -r p; do [ -n "$p" ] && wr "$i" "delete a service credential of $(label "$i")" iam delete-service-specific-credential --user-name "$n" --service-specific-credential-id "$p"; done < <(jq -r '.ServiceSpecificCredentials[]?.ServiceSpecificCredentialId // empty' <<<"$json")
  fi
  if json="$(awsq iam iam list-attached-user-policies --user-name "$n")"; then
    while IFS= read -r p; do
      [ -n "$p" ] && wr "$i" "detach a policy from $(label "$i")" iam detach-user-policy --user-name "$n" --policy-arn "$p"
    done < <(jq -r '.AttachedPolicies[]?.PolicyArn // empty' <<<"$json")
  else
    gone_err && return 0
    warn "could not list the policies attached to $(label "$i") ($(code))"
  fi
  if json="$(awsq iam iam list-user-policies --user-name "$n")"; then
    while IFS= read -r p; do
      [ -n "$p" ] && wr "$i" "delete policy $p of $(label "$i")" iam delete-user-policy --user-name "$n" --policy-name "$p"
    done < <(jq -r '.PolicyNames[]? // empty' <<<"$json")
  else
    warn "could not list the policies of $(label "$i") ($(code))"
  fi
  wr "$i" "delete $(label "$i")" iam delete-user --user-name "$n"
}
del_policy() {
  local i="$1" a="${C_A[$1]}" json v
  [ -n "$a" ] || return 1
  if json="$(awsq iam iam list-policy-versions --policy-arn "$a")"; then
    while IFS= read -r v; do
      [ -n "$v" ] && wr "$i" "delete version $v of $(label "$i")" iam delete-policy-version --policy-arn "$a" --version-id "$v"
    done < <(jq -r '.Versions[]? | select(.IsDefaultVersion != true) | .VersionId // empty' <<<"$json")
  elif gone_err; then
    return 0
  fi
  wr "$i" "delete $(label "$i")" iam delete-policy --policy-arn "$a"
}

# Every type key a handler covers (ruling A36); the rest are left for Verify clean to report.
HANDLED=" autoscaling:autoScalingGroup events:rule config:config-rule config:configuration-recorder config:delivery-channel
  elasticloadbalancing:loadbalancer elasticloadbalancing:listener elasticloadbalancing:listener-rule elasticloadbalancing:targetgroup rds:db rds:subgrp rds:pg rds:snapshot ec2:instance
  ec2:launch-template ec2:natgateway ec2:elastic-ip ec2:vpc-peering-connection ec2:vpc-endpoint ec2:instance-connect-endpoint
  ec2:volume ec2:network-interface ec2:security-group ec2:security-group-rule ec2:subnet ec2:route-table ec2:network-acl ec2:internet-gateway
  ec2:egress-only-internet-gateway ec2:prefix-list ec2:vpc s3:bucket sns:topic logs:log-group cloudwatch:alarm
  cloudwatch:dashboard logs:query-definition ssm:association ssm:patchbaseline backup:backup-plan backup:backup-vault
  ec2:image ec2:snapshot resource-groups:group iam:instance-profile iam:role iam:user iam:policy
  cloudformation:stack ecs:service ecs:task ecs:cluster ecs:task-definition lambda:function cloudfront:distribution
  cloudfront:origin-access-control route53:hostedzone route53:healthcheck ec2:vpc-flow-log sqs:queue ssm:parameter
  kms:alias kms:key secretsmanager:secret ecr:repository access-analyzer:analyzer
  eks:nodegroup eks:cluster apigateway:apis apigateway:stages states:stateMachine events:event-bus firehose:deliverystream
  kinesis:stream glue:crawler glue:database athena:workgroup elasticache:replicationgroup elasticache:cluster
  elasticache:subnetgroup elasticache:snapshot elasticfilesystem:file-system dynamodb:table cognito-idp:userpool
  eks:access-entry ec2:fleet "
HANDLED="${HANDLED//$'\n'/ }"

discover
echo "safety net: ${#C_T[@]} item(s) found for $LAB_ID in $REGIONS and IAM"
declare -A ec2_regions=()
for i in "${!C_T[@]}"; do
  if [ "${C_W[$i]}" = 1 ]; then
    warn "never touched: $(label "$i") carries the VPN server's tag wg-admin"
    continue
  fi
  [[ "$HANDLED" == *" ${C_T[$i]} "* ]] || warn "no handler for ${C_T[$i]} yet: ${C_I[$i]}${C_N[$i]:+ (${C_N[$i]})} (left for Verify clean to report)"
  [[ "${C_T[$i]}" == ec2:* ]] && ec2_regions[${C_R[$i]}]=1
done
for r in "${!ec2_regions[@]}"; do find_wg_vpcs "$r"; done

# 1 workloads (an API's stages, an EKS cluster's access entries and a group's EC2 Fleets go with them: judged only)
stacks
run eks:nodegroup poll del_nodegroup
run eks:cluster poll del_eks
run ecs:service poll del_ecs_service
run ecs:task - del_ecs_task
ecs_clusters
run ecs:task-definition - del_taskdef
run lambda:function - del_lambda
run apigateway:apis - del_api
run states:stateMachine - del_sfn
run autoscaling:autoScalingGroup poll del_asg
run events:rule - del_rule
run events:event-bus - del_bus
run firehose:deliverystream poll del_firehose
run kinesis:stream poll del_stream
run glue:crawler - del_crawler
run glue:database - del_gluedb
run athena:workgroup - del_workgroup
run config:config-rule - del_config_rule
run config:configuration-recorder - stop_recorder
run config:delivery-channel - del_channel
run config:configuration-recorder - del_recorder
# 2 edge and DNS
distributions
run cloudfront:origin-access-control - del_oac
run route53:hostedzone - del_zone
run route53:healthcheck - del_healthcheck
# 3 network services
run elasticloadbalancing:loadbalancer poll del_lb
run elasticloadbalancing:listener-rule - del_lb_child
run elasticloadbalancing:listener - del_lb_child
run elasticloadbalancing:targetgroup - del_tg
rds_dbs yes
rds_dbs no
run rds:subgrp - del_subgrp
run rds:pg - del_pg
run rds:snapshot - del_dbsnap
run elasticache:replicationgroup poll del_cache_group
run elasticache:cluster poll del_cache_cluster
run elasticache:subnetgroup - del_cache_subnets
run elasticache:snapshot - del_cache_snapshot
run elasticfilesystem:file-system poll del_efs
run ec2:instance poll del_instance
run ec2:launch-template - del_lt
run ec2:natgateway poll del_nat
run ec2:elastic-ip - del_eip
run ec2:vpc-peering-connection - del_pcx
run ec2:vpc-endpoint poll del_vpce
run ec2:instance-connect-endpoint poll del_eice
run ec2:volume - del_volume
run ec2:vpc-flow-log - del_flowlog
# 4 VPC fabric (then any security group rule its group did not take along)
fabric
run ec2:security-group-rule - del_sgr
# 5 data and the rest (AMIs before snapshots: a snapshot behind an AMI cannot go first)
run s3:bucket - del_bucket
run sns:topic - del_topic
run sqs:queue - del_queue
run ssm:parameter - del_param
run logs:log-group - del_loggroup
run cloudwatch:alarm - del_alarm
run cloudwatch:dashboard - del_dashboard
run logs:query-definition - del_query
run ssm:association - del_assoc
run ssm:patchbaseline - del_baseline
run backup:backup-plan - del_plan
run backup:backup-vault - del_vault
run kms:alias - del_alias
run kms:key - del_key
run secretsmanager:secret - del_secret
run ecr:repository - del_repo
run access-analyzer:analyzer - del_analyzer
run dynamodb:table poll del_table
run cognito-idp:userpool - del_userpool
run ec2:image - del_image
run ec2:snapshot - del_snapshot
run resource-groups:group - del_group
# 6 IAM
run iam:instance-profile - del_profile
run iam:role - del_role
run iam:user - del_user
run iam:policy - del_policy

echo "safety net: done for $LAB_ID (Verify clean is the verdict)"
exit 0
