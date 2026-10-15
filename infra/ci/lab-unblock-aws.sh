#!/usr/bin/env bash
# infra/ci/lab-unblock-aws.sh <lab id>
#
# Plain English: lab-aws.yml step 11, "Unblock" (AWS labs spec §8.1). Before
# an AWS lab is destroyed, turn off what a learner can switch on and what
# stops a delete, for the lab's own tagged items only (everything tagged
# cloudlabs-lab = <id> in $LAB_REGIONS, from Parse payload; default eu-west-2
# eu-west-1), plus its Config recorders named lab-<id>-*. Never an item
# carrying the VPN server's wg-admin tag, even with the lab's tag too.
#
#   RDS instances          deletion protection off (applied immediately)
#   load balancers         deletion_protection.enabled = false (application,
#                          network and gateway; a classic one has none)
#   DynamoDB tables        deletion protection off
#   Network Firewall       delete protection off
#   EC2 instances          termination protection off, then stop protection off
#   CloudFormation stacks  termination protection off
#   Config recorders       named lab-<id>-* stopped (lab 02; never another one)
#   Backup vaults          every recovery point deleted, then the vault polled
#                          every 15 s until it is empty, at most
#                          LAB_UNBLOCK_VAULT_WAIT_SECONDS (default 300)
#   Client VPN             every active connection terminated
#   Lambda in a VPC        a wait until the function's network interfaces are
#                          released (AWS takes up to 20 minutes)
#   S3 buckets             Object Lock switched on is a loud warning: its
#                          locked versions cannot be deleted until they expire
#
# Every wait is also capped at LAB_JOB_DEADLINE (Parse payload: the job's
# start plus its timeout) less the reserve the later steps need (420 s, the
# safety net's own reserve, plus 60 s per minute of LAB_DESTROY_MIN, default
# 10), as lab-unblock.sh does, so the destroy and the safety net still run.
#
# Never fails the run: every refusal is a ::warning:: and the destroy, the
# safety net and the clean check still run after it. Exit 0 always; 2 only for
# a bad lab id (before any AWS call). AWS CLI v2 and jq only; every call names
# its region and every read asks for JSON. AWS's error text is cut to its code
# (it can carry the account id), and ARNs are never printed.

set -uo pipefail

LAB_ID="${1:-}"
LAB_ID_RE='^(az(104|305|700)|soa|saa|ans)-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$'
if ! [[ "$LAB_ID" =~ $LAB_ID_RE ]] || [ "${#LAB_ID}" -gt 30 ]; then
  echo "::error::lab-unblock-aws: refusing lab id '${LAB_ID}'"
  exit 2
fi
PREFIX="lab-$LAB_ID-"
REGIONS="${LAB_REGIONS:-eu-west-2 eu-west-1}"
num() { [[ "${1:-}" =~ ^[0-9]+$ ]] && echo "$1" || echo "$2"; }
VAULT_WAIT_S="$(num "${LAB_UNBLOCK_VAULT_WAIT_SECONDS:-}" 300)"
VAULT_POLL_S=15
LAMBDA_POLL_S=30
UNTIL=""
if [[ "${LAB_JOB_DEADLINE:-}" =~ ^[0-9]+$ ]]; then
  UNTIL=$((LAB_JOB_DEADLINE - 420 - 60 * $(num "${LAB_DESTROY_MIN:-}" 10)))
fi
# A wait's end: <seconds> from now, or UNTIL when that is sooner.
wait_end() {
  local e=$(($(date +%s) + $1))
  [ -n "$UNTIL" ] && [ "$UNTIL" -lt "$e" ] && e="$UNTIL"
  echo "$e"
}

ERRF="$(mktemp)"
trap 'rm -f "$ERRF"' EXIT
warn() { echo "::warning::unblock: $*" >&2; }
# Every aws call: its error text goes to a file, of which only the code is ever shown.
awsx() { aws "$@" 2>"$ERRF"; }
errcode() { sed -n 's/.*An error occurred (\([A-Za-z0-9._]*\)).*/\1/p' "$ERRF" | head -n1; }
code() { local c; c="$(errcode)"; echo "${c:-refused}"; }
# A read in region $1: the answer's JSON. A write in region $1: nothing printed.
awsq() { local r="$1"; shift; awsx "$@" --region "$r" --output json; }
awsw() { local r="$1"; shift; awsx "$@" --region "$r" >/dev/null; }
# do_write <region> <what it did> <aws args...>: one write; a refusal is a warning, never a failure.
do_write() {
  local r="$1" what="$2"
  shift 2
  if awsw "$r" "$@"; then echo "unblock: $what"; else warn "could not ${what} ($(code))"; fi
}

# empty_vault <region> <vault>: delete every recovery point, then poll until none is left.
empty_vault() {
  local r="$1" v="$2" json end n p
  local -A asked=()
  end="$(wait_end "$VAULT_WAIT_S")"
  while :; do
    if ! json="$(awsq "$r" backup list-recovery-points-by-backup-vault --backup-vault-name "$v")"; then
      warn "could not list the recovery points in $v ($(code))"
      return
    fi
    n="$(jq -r '.RecoveryPoints // [] | length' <<<"$json")"
    if [ "${n:-0}" -eq 0 ]; then
      echo "unblock: backup vault $v is empty"
      return
    fi
    while IFS= read -r p; do
      [ -z "$p" ] || [ -n "${asked[$p]:-}" ] && continue
      asked[$p]=1
      awsw "$r" backup delete-recovery-point --backup-vault-name "$v" --recovery-point-arn "$p" || warn "could not delete a recovery point in $v ($(code))"
    done < <(jq -r '.RecoveryPoints[]? | select(.Status != "DELETING") | .RecoveryPointArn // empty' <<<"$json")
    if [ "$(date +%s)" -ge "$end" ]; then
      warn "backup vault $v still holds $n recovery point(s) after waiting; the safety net cannot delete it yet"
      return
    fi
    echo "unblock: waiting for $n recovery point(s) in $v to go"
    sleep "$VAULT_POLL_S"
  done
}

# wait_lambda <region> <function>: until its VPC network interfaces are released.
wait_lambda() {
  local r="$1" f="$2" json n end
  end="$(wait_end 1200)"
  while :; do
    if ! json="$(awsq "$r" ec2 describe-network-interfaces --filters "Name=requester-id,Values=*:$f")"; then
      warn "could not list the network interfaces of $f ($(code))"
      return
    fi
    n="$(jq -r '.NetworkInterfaces // [] | length' <<<"$json")"
    [ "${n:-0}" -eq 0 ] && return
    if [ "$(date +%s)" -ge "$end" ]; then
      warn "$f still holds $n network interface(s) in its VPC"
      return
    fi
    echo "unblock: waiting for $n network interface(s) of $f to be released"
    sleep "$LAMBDA_POLL_S"
  done
}

echo "unblock: everything tagged cloudlabs-lab=$LAB_ID in $REGIONS"
for r in $REGIONS; do
  if ! listed="$(awsq "$r" resourcegroupstaggingapi get-resources --tag-filters "Key=cloudlabs-lab,Values=$LAB_ID")"; then
    warn "could not list the lab's tagged resources in $r ($(code))"
    listed=""
  fi
  vaults=()
  lambdas=()
  while IFS=$'\x1f' read -r arn wg; do
    [ -z "$arn" ] && continue
    # Never the VPN server's, even with the lab's tag too.
    if [ "$wg" = 1 ]; then warn "never touched: ${arn##*:} carries the VPN server's tag wg-admin"; continue; fi
    # arn:partition:service:region:account:<type><"/" or ":"><id>
    IFS=: read -r _ _ service _ _ rest <<<"$arn"
    head="${rest%%[/:]*}"
    if [ "$head" = "$rest" ]; then id="$rest"; else id="${rest:${#head}+1}"; fi
    case "$service:$head" in
      rds:db)
        do_write "$r" "turn off deletion protection on rds:db $id" rds modify-db-instance --db-instance-identifier "$id" --no-deletion-protection --apply-immediately ;;
      elasticloadbalancing:loadbalancer)
        [[ "$id" == app/* || "$id" == net/* || "$id" == gwy/* ]] || continue
        do_write "$r" "turn off deletion protection on load balancer $id" elbv2 modify-load-balancer-attributes --load-balancer-arn "$arn" --attributes Key=deletion_protection.enabled,Value=false ;;
      dynamodb:table)
        do_write "$r" "turn off deletion protection on dynamodb:table $id" dynamodb update-table --table-name "$id" --no-deletion-protection-enabled ;;
      network-firewall:firewall)
        do_write "$r" "turn off delete protection on network firewall $id" network-firewall update-firewall-delete-protection --firewall-arn "$arn" --no-delete-protection ;;
      ec2:instance)
        do_write "$r" "turn off termination protection on $id" ec2 modify-instance-attribute --instance-id "$id" --no-disable-api-termination
        do_write "$r" "turn off stop protection on $id" ec2 modify-instance-attribute --instance-id "$id" --no-disable-api-stop ;;
      cloudformation:stack)
        do_write "$r" "turn off termination protection on stack ${id%%/*}" cloudformation update-termination-protection --stack-name "${id%%/*}" --no-enable-termination-protection ;;
      backup:backup-vault) vaults+=("$id") ;;
      ec2:client-vpn-endpoint)
        if ! cj="$(awsq "$r" ec2 describe-client-vpn-connections --client-vpn-endpoint-id "$id")"; then
          warn "could not list the connections of $id ($(code))"
          continue
        fi
        while IFS= read -r c; do
          [ -z "$c" ] && continue
          do_write "$r" "terminate Client VPN connection $c" ec2 terminate-client-vpn-connections --client-vpn-endpoint-id "$id" --connection-id "$c"
        done < <(jq -r '.Connections[]? | select(.Status.Code == "active") | .ConnectionId // empty' <<<"$cj") ;;
      lambda:function) lambdas+=("${id%%:*}") ;;
      s3:*)
        # arn:aws:s3:::<bucket>: no type part.
        if lj="$(awsq "$r" s3api get-object-lock-configuration --bucket "$rest")" && jq -e '.ObjectLockConfiguration.ObjectLockEnabled == "Enabled"' <<<"$lj" >/dev/null 2>&1; then
          warn "Object Lock is on in $rest: its locked versions cannot be deleted until they expire"
        fi ;;
    esac
  done < <(jq -r '.ResourceTagMappingList[]? | [.ResourceARN // "", (if any((.Tags // [])[]; .Key == "wg-admin") then "1" else "0" end)] | join("\u001f")' <<<"$listed")

  # Config recorders by name (they take no tags): only this lab's.
  if rj="$(awsq "$r" configservice describe-configuration-recorders)"; then
    while IFS= read -r n; do
      [ -z "$n" ] && continue
      do_write "$r" "stop Config recorder $n" configservice stop-configuration-recorder --configuration-recorder-name "$n"
    done < <(jq -r --arg p "$PREFIX" '.ConfigurationRecorders[]?.name // empty | select(startswith($p))' <<<"$rj")
  else
    warn "could not list the Config recorders in $r ($(code))"
  fi

  for v in "${vaults[@]}"; do empty_vault "$r" "$v"; done
  for f in "${lambdas[@]}"; do wait_lambda "$r" "$f"; done
done
echo "unblock: done"
exit 0
