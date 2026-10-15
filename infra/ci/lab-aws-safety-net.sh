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
#   named items      in each lab region, the types that take no tags, named
#                    lab-<id>-*: CloudWatch dashboards, Config recorders and
#                    delivery channels, Logs query definitions, KMS aliases
#
# Never the VPN server's: an item carrying the wg-admin tag is skipped even
# when it carries the lab's tag too, and so is anything inside a VPC tagged
# wg-admin = vpn (looked up per region; when that lookup fails, nothing inside
# a VPC is deleted in that region). Verify clean still names such an item when
# it carries the lab's tag (a person must look), but never scans inside it.
#
# Sweep mode deletes, in dependency order (§8.2; batch 1's handlers, ruling
# A36: any other type is a warning, "no handler for <type> yet", left for
# Verify clean to report):
#
#   1 workloads      Auto Scaling groups (force), EventBridge rules (targets
#                    first), Config rules (remediation first), the lab's
#                    Config recorder stopped, its delivery channel and recorder
#   3 network        load balancers, then target groups; RDS replicas, then
#                    instances, subnet groups, parameter groups, snapshots;
#                    instances terminated; launch templates; NAT gateways;
#                    Elastic IPs; VPC peering; VPC endpoints; Instance Connect
#                    Endpoints; volumes
#   4 VPC fabric     detached network interfaces, security groups (rules that
#                    name another lab group revoked first; never "default"),
#                    subnets, route tables (non-main associations first),
#                    network ACLs (not the default), internet gateways
#                    (detached first), egress-only gateways, prefix lists, VPCs
#   5 data           buckets (every version and delete marker), SNS topics, log
#                    groups, alarms, dashboards, query definitions, SSM
#                    associations, patch baselines (their patch groups first),
#                    Backup plans (selections first) and vaults, AMIs, then
#                    snapshots, resource groups
#   6 IAM            instance profiles (roles removed), roles (policies detached
#                    and deleted), users (login profile and policies first),
#                    customer policies (old versions first)
#
# Auto Scaling groups, load balancers, RDS instances, instances, NAT gateways,
# VPC endpoints and Instance Connect Endpoints are polled after the delete,
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
# an AMI deregistered, a dead peering connection, anything AWS answers "not
# found" for, and a KMS key pending deletion, are clean). A type with no
# handler is never clean ("no handler for <type>: <name>"). While a lab VPC
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
    *NotFound* | NoSuch* | *DoesNotExist* | 404) return 0 ;;
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
# AWS lists no such item). Returns 0 answered, 1 not found, 2 AWS could not be
# asked, 3 no describe for this type (no handler).
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
    kms:alias)
      [ -n "$x" ] || return 3
      set -- kms describe-key --key-id "$x"; q='.KeyMetadata' ;;
    iam:role) set -- iam get-role --role-name "$id"; q='.Role' ;;
    iam:instance-profile) set -- iam get-instance-profile --instance-profile-name "$id"; q='.InstanceProfile' ;;
    iam:policy) set -- iam get-policy --policy-arn "$x"; q='.Policy' ;;
    iam:user) set -- iam get-user --user-name "$id"; q='.User' ;;
    *) return 3 ;;
  esac
  if ! json="$(awsq "${C_R[$i]}" "$@")"; then
    gone_err && return 1
    return 2
  fi
  DJ="$(jq -c --arg x "$x" --arg id "$id" "[ $q ][0] // empty" <<<"$json" 2>/dev/null)"
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
    kms:key | kms:alias) g='.KeyState == "PendingDeletion"' ;;
    *) g='false' ;;
  esac
  IFS=$'\x1f' read -r s n < <(jq -r "[ (if ($g) then \"gone\" else \"there\" end), ((.Tags // .TagSet // []) | if type == \"array\" then (map(select(.Key == \"Name\"))[0].Value // \"\") else \"\" end) ] | join(\"\u001f\")" <<<"$DJ" 2>/dev/null)
  J="${s:-there}"
  [ -n "${n:-}" ] && NT="$n"
  [[ "${C_T[$i]}" == kms:* && "$J" = there ]] && J=nohandler
}

# ── Verify clean ─────────────────────────────────────────────────────────

if [ "$MODE" = verify ]; then
  discover
  left=("${LIST_FAILED[@]}")
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

# ── Handlers ──
# Phase 1, workloads.
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
  local i="$1" name
  describe "$i" || return 1
  name="$(jq -r '.ConfigRuleName // empty' <<<"$DJ")"
  [ -n "$name" ] || return 1
  wr "$i" "delete the remediation of $(label "$i")" configservice delete-remediation-configuration --config-rule-name "$name"
  wr "$i" "delete $(label "$i") ($name)" configservice delete-config-rule --config-rule-name "$name"
}
stop_recorder() { wr "$1" "stop $(label "$1")" configservice stop-configuration-recorder --configuration-recorder-name "${C_I[$1]}"; }
del_channel() { wr "$1" "delete $(label "$1")" configservice delete-delivery-channel --delivery-channel-name "${C_I[$1]}"; }
del_recorder() { wr "$1" "delete $(label "$1")" configservice delete-configuration-recorder --configuration-recorder-name "${C_I[$1]}"; }

# Phase 3, network services.
del_lb() { wr "$1" "delete $(label "$1")" elbv2 delete-load-balancer --load-balancer-arn "${C_A[$1]}"; }
del_tg() { wr "$1" "delete $(label "$1")" elbv2 delete-target-group --target-group-arn "${C_A[$1]}"; }
del_db() { wr "$1" "delete $(label "$1")" rds delete-db-instance --db-instance-identifier "${C_I[$1]}" --skip-final-snapshot --delete-automated-backups; }
del_subgrp() { wr "$1" "delete $(label "$1")" rds delete-db-subnet-group --db-subnet-group-name "${C_I[$1]}"; }
del_pg() { wr "$1" "delete $(label "$1")" rds delete-db-parameter-group --db-parameter-group-name "${C_I[$1]}"; }
del_dbsnap() { wr "$1" "delete $(label "$1")" rds delete-db-snapshot --db-snapshot-identifier "${C_I[$1]}"; }
del_instance() { vpc_ok "$1" && wr "$1" "terminate $(label "$1")" ec2 terminate-instances --instance-ids "${C_I[$1]}"; }
del_lt() { wr "$1" "delete $(label "$1")" ec2 delete-launch-template --launch-template-id "${C_I[$1]}"; }
del_nat() { vpc_ok "$1" && wr "$1" "delete $(label "$1")" ec2 delete-nat-gateway --nat-gateway-id "${C_I[$1]}"; }
del_eip() { wr "$1" "release $(label "$1")" ec2 release-address --allocation-id "${C_I[$1]}"; }
del_pcx() { wr "$1" "delete $(label "$1")" ec2 delete-vpc-peering-connection --vpc-peering-connection-id "${C_I[$1]}"; }
del_vpce() { vpc_ok "$1" && wr "$1" "delete $(label "$1")" ec2 delete-vpc-endpoints --vpc-endpoint-ids "${C_I[$1]}"; }
del_eice() { vpc_ok "$1" && wr "$1" "delete $(label "$1")" ec2 delete-instance-connect-endpoint --instance-connect-endpoint-id "${C_I[$1]}"; }
del_volume() { wr "$1" "delete $(label "$1")" ec2 delete-volume --volume-id "${C_I[$1]}"; }
# RDS: read replicas first (ReadReplicaSourceDBInstanceIdentifier set), then the rest.
rds_dbs() {
  local i want="$1" rep
  local -a got=()
  for i in $(of_type rds:db); do
    rep=no
    describe "$i" && [ -n "$(jq -r '.ReadReplicaSourceDBInstanceIdentifier // empty' <<<"$DJ" 2>/dev/null)" ] && rep=yes
    [ "$rep" = "$want" ] && del_db "$i" && got+=("$i")
  done
  [ "${#got[@]}" -gt 0 ] && wait_gone "${got[@]}"
  return 0
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
del_image() { wr "$1" "deregister $(label "$1")" ec2 deregister-image --image-id "${C_I[$1]}"; }
del_snapshot() { wr "$1" "delete $(label "$1")" ec2 delete-snapshot --snapshot-id "${C_I[$1]}"; }
del_group() { wr "$1" "delete $(label "$1")" resource-groups delete-group --group "${C_I[$1]}"; }

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
  elasticloadbalancing:loadbalancer elasticloadbalancing:targetgroup rds:db rds:subgrp rds:pg rds:snapshot ec2:instance
  ec2:launch-template ec2:natgateway ec2:elastic-ip ec2:vpc-peering-connection ec2:vpc-endpoint ec2:instance-connect-endpoint
  ec2:volume ec2:network-interface ec2:security-group ec2:subnet ec2:route-table ec2:network-acl ec2:internet-gateway
  ec2:egress-only-internet-gateway ec2:prefix-list ec2:vpc s3:bucket sns:topic logs:log-group cloudwatch:alarm
  cloudwatch:dashboard logs:query-definition ssm:association ssm:patchbaseline backup:backup-plan backup:backup-vault
  ec2:image ec2:snapshot resource-groups:group iam:instance-profile iam:role iam:user iam:policy "
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

# 1 workloads
run autoscaling:autoScalingGroup poll del_asg
run events:rule - del_rule
run config:config-rule - del_config_rule
run config:configuration-recorder - stop_recorder
run config:delivery-channel - del_channel
run config:configuration-recorder - del_recorder
# 3 network services
run elasticloadbalancing:loadbalancer poll del_lb
run elasticloadbalancing:targetgroup - del_tg
rds_dbs yes
rds_dbs no
run rds:subgrp - del_subgrp
run rds:pg - del_pg
run rds:snapshot - del_dbsnap
run ec2:instance poll del_instance
run ec2:launch-template - del_lt
run ec2:natgateway poll del_nat
run ec2:elastic-ip - del_eip
run ec2:vpc-peering-connection - del_pcx
run ec2:vpc-endpoint poll del_vpce
run ec2:instance-connect-endpoint poll del_eice
run ec2:volume - del_volume
# 4 VPC fabric
fabric
# 5 data and the rest (AMIs before snapshots: a snapshot behind an AMI cannot go first)
run s3:bucket - del_bucket
run sns:topic - del_topic
run logs:log-group - del_loggroup
run cloudwatch:alarm - del_alarm
run cloudwatch:dashboard - del_dashboard
run logs:query-definition - del_query
run ssm:association - del_assoc
run ssm:patchbaseline - del_baseline
run backup:backup-plan - del_plan
run backup:backup-vault - del_vault
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
