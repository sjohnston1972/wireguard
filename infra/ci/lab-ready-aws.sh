#!/usr/bin/env bash
# infra/ci/lab-ready-aws.sh <lab id> <deploy_min>
#
# Plain English: lab-aws.yml step 8, "Ready check" (AWS labs spec §5.1).
# Terraform saying "applied" is not the same as AWS saying "ready": an
# instance still runs its status checks, a load balancer still provisions.
# This lists everything tagged cloudlabs-lab = <id> in the lab's regions
# ($LAB_REGIONS, from Parse payload) and asks each known type for its real
# state, every LAB_READY_POLL_SECONDS (default 15), for up to deploy_min:
#
#   instances            running with both status checks ok (impaired fails;
#                        terminated ones are ignored: a Spot instance AWS
#                        takes back mid-check (shutting-down, terminated) is
#                        gone, never failed (ruling P9))
#   load balancers       active (failed fails)
#   RDS, ElastiCache     available (failed fails; ElastiCache fails at once on
#                        create-failed, incompatible-network or restore-failed
#                        (ruling P17))
#   NAT gateways, VPC endpoints, transit gateways and their attachments,
#   VPN connections      available (failed fails; a peering attachment
#                        pendingAcceptance is waited for, never failed: lab
#                        29's accept follows at once)
#   ACM certificates     ISSUED (FAILED fails)
#   Client VPN           available
#   EKS clusters and node groups   ACTIVE (FAILED fails)
#   ECS services         running = desired
#   Network Firewall     READY
#   CloudFront           Deployed (asked in us-east-1)
#   Global Accelerator   DEPLOYED (asked in us-west-2)
#   VPC Lattice          ACTIVE (a listener has no status: readable is ready)
#   Resolver endpoints   OPERATIONAL (ACTION_NEEDED fails)
#   Instance Connect Endpoints   create-complete (create-failed fails)
#
# Anything else counts as ready by existing. Only this session's items are
# asked about (tag cloudlabs-session = $SESSION_ID too), and an item being
# deleted, already deleted or "not found" is gone, not pending: the tagging
# API lists dead items for about an hour. A failed state ends the check at
# once (pre-flight ruling C16); a pending one waits. At the deadline an
# instance still "initializing" passes with a warning (its checks can take a
# few minutes more), and anything else not ready fails.
#
# Exit 0 ready, 1 not ready (each problem one line "not ready: <type> <name>
# (<state>)"), 2 bad arguments. Names are the ARN's resource part, never the
# account id.

set -uo pipefail

LAB_ID="${1:-}"
DEPLOY_MIN="${2:-}"
LAB_ID_RE='^(az(104|305|700)|soa|saa|ans)-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$'
if ! [[ "$LAB_ID" =~ $LAB_ID_RE ]] || [ "${#LAB_ID}" -gt 30 ]; then
  echo "::error::lab-ready-aws: refusing lab id '${LAB_ID}'"
  exit 2
fi
if ! [[ "$DEPLOY_MIN" =~ ^[0-9]{1,3}$ ]]; then
  echo "::error::lab-ready-aws: deploy_min must be a whole number of minutes"
  exit 2
fi
INTERVAL="${LAB_READY_POLL_SECONDS:-15}"
[[ "$INTERVAL" =~ ^[0-9]+$ ]] || INTERVAL=15
REGIONS="${LAB_REGIONS:-${LAB_REGION:-eu-west-2}}"
deadline=$(($(date +%s) + 60 * DEPLOY_MIN))

ERRF="$(mktemp)"
trap 'rm -f "$ERRF"' EXIT
# One read call: the answer's JSON, or a failure whose error text goes to a
# file, of which only the code is ever read (the text can carry the account id).
awsq() { aws "$@" --output json 2>"$ERRF"; }
errcode() { sed -n 's/.*An error occurred (\([A-Za-z0-9._]*\)).*/\1/p' "$ERRF" | head -n1; }
# A describe that failed: "not found" (an item already deleted, which the
# tagging API still lists for a while) is gone; anything else is pending.
unanswered() {
  case "$(errcode)" in
    *NotFound* | NoSuch*) KIND=gone ;;
    *) KIND=pending; STATE="could not ask AWS" ;;
  esac
}

# check <arn>: sets KIND (ready, pending, failed, initializing or gone), STATE and the line's TYPE and NAME.
check() {
  local arn="$1" service region rest rtype id json s a b
  IFS=: read -r _ _ service region _ rest <<<"$arn"
  if [[ "$rest" == */* ]]; then
    rtype="${rest%%/*}"
    id="${rest#*/}"
  else
    rtype="${rest%%:*}"
    id="${rest#*:}"
  fi
  # arn:aws:vpc-lattice:<r>:<a>:service/<svc>/listener/<l>: a listener goes with its service (as in lab-aws-safety-net.sh).
  if [ "$service" = vpc-lattice ] && [[ "$rest" == service/*/listener/* ]]; then
    rtype=listener
    id="${rest#service/}"
  fi
  TYPE="$service:$rtype"
  NAME="$id"
  KIND=ready
  STATE=""
  [ -z "$region" ] && region=us-east-1
  # s: the state to judge; empty when AWS has no such item any more.
  case "$TYPE" in
    ec2:instance)
      json="$(awsq ec2 describe-instance-status --instance-ids "$id" --include-all-instances --region "$region")" || { unanswered; return; }
      # "|" between the three: a tab is whitespace to read, so an empty field would collapse.
      IFS='|' read -r s a b < <(jq -r '.InstanceStatuses[0] // {} | [.InstanceState.Name // "", .InstanceStatus.Status // "", .SystemStatus.Status // ""] | join("|")' <<<"$json")
      case "$s" in
        "" | terminated | shutting-down) KIND=gone ;;
        running)
          if [ "$a" = ok ] && [ "$b" = ok ]; then KIND=ready
          elif [ "$a" = impaired ] || [ "$b" = impaired ]; then KIND=failed; STATE=impaired
          elif [ "$a" = initializing ] || [ "$b" = initializing ]; then KIND=initializing; STATE=initializing
          else KIND=pending; STATE="${a:-no status} / ${b:-no status}"
          fi ;;
        *) KIND=pending; STATE="$s" ;;
      esac
      return ;;
    elasticloadbalancing:loadbalancer)
      # Application, network and gateway load balancers (elbv2); a classic one counts by existing.
      [[ "$id" == app/* || "$id" == net/* || "$id" == gwy/* ]] || return
      json="$(awsq elbv2 describe-load-balancers --load-balancer-arns "$arn" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.LoadBalancers[0].State.Code // ""' <<<"$json")"
      judge "$s" active failed ;;
    rds:db)
      json="$(awsq rds describe-db-instances --db-instance-identifier "$id" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.DBInstances[0].DBInstanceStatus // ""' <<<"$json")"
      [[ "$s" == incompatible-* ]] && s=failed
      judge "$s" available failed ;;
    elasticache:cluster)
      json="$(awsq elasticache describe-cache-clusters --cache-cluster-id "$id" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.CacheClusters[0].CacheClusterStatus // ""' <<<"$json")"
      # Ruling P17: these never recover by waiting.
      case "$s" in incompatible-network | restore-failed) KIND=failed; STATE="$s"; return ;; esac
      judge "$s" available create-failed ;;
    elasticache:replicationgroup)
      json="$(awsq elasticache describe-replication-groups --replication-group-id "$id" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.ReplicationGroups[0].Status // ""' <<<"$json")"
      judge "$s" available create-failed ;;
    elasticache:serverlesscache)
      json="$(awsq elasticache describe-serverless-caches --serverless-cache-name "$id" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.ServerlessCaches[0].Status // ""' <<<"$json")"
      judge "$s" available create-failed ;;
    ec2:natgateway)
      json="$(awsq ec2 describe-nat-gateways --nat-gateway-ids "$id" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.NatGateways[0].State // ""' <<<"$json")"
      judge "$s" available failed ;;
    ec2:vpc-endpoint)
      json="$(awsq ec2 describe-vpc-endpoints --vpc-endpoint-ids "$id" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.VpcEndpoints[0].State // ""' <<<"$json")"
      judge "${s,,}" available failed ;;
    ec2:transit-gateway)
      json="$(awsq ec2 describe-transit-gateways --transit-gateway-ids "$id" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.TransitGateways[0].State // ""' <<<"$json")"
      judge "$s" available failed ;;
    ec2:transit-gateway-attachment)
      json="$(awsq ec2 describe-transit-gateway-attachments --transit-gateway-attachment-ids "$id" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.TransitGatewayAttachments[0].State // ""' <<<"$json")"
      [ "$s" = failing ] && s=failed
      # Waited for, never failed: lab 29's accept follows at once.
      [ "$s" = pendingAcceptance ] && s=pending
      judge "$s" available failed ;;
    ec2:vpn-connection)
      # Its tunnels may stay down until the lab's own router configures itself: the connection's state is what counts.
      json="$(awsq ec2 describe-vpn-connections --vpn-connection-ids "$id" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.VpnConnections[0].State // ""' <<<"$json")"
      judge "$s" available failed ;;
    ec2:client-vpn-endpoint)
      json="$(awsq ec2 describe-client-vpn-endpoints --client-vpn-endpoint-ids "$id" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.ClientVpnEndpoints[0].Status.Code // ""' <<<"$json")"
      judge "$s" available failed ;;
    ec2:instance-connect-endpoint)
      json="$(awsq ec2 describe-instance-connect-endpoints --instance-connect-endpoint-ids "$id" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.InstanceConnectEndpoints[0].State // ""' <<<"$json")"
      [[ "$s" == delete-* ]] && s=""
      judge "$s" create-complete create-failed ;;
    eks:cluster)
      json="$(awsq eks describe-cluster --name "$id" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.cluster.status // ""' <<<"$json")"
      judge "$s" ACTIVE FAILED ;;
    eks:nodegroup)
      # nodegroup/<cluster>/<node group>/<uuid>
      IFS=/ read -r a b _ <<<"$id"
      NAME="$a/$b"
      json="$(awsq eks describe-nodegroup --cluster-name "$a" --nodegroup-name "$b" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.nodegroup.status // ""' <<<"$json")"
      [ "$s" = DEGRADED ] && s=CREATE_FAILED
      judge "$s" ACTIVE CREATE_FAILED ;;
    ecs:service)
      # service/<cluster>/<service>, or the old service/<service> in the default cluster.
      if [[ "$id" == */* ]]; then a="${id%%/*}"; else a=default; fi
      json="$(awsq ecs describe-services --cluster "$a" --services "$arn" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.services[0] // empty | if .status == "INACTIVE" then "" elif .runningCount == .desiredCount then "steady" else "running \(.runningCount) of \(.desiredCount)" end' <<<"$json")"
      judge "$s" steady never-fails ;;
    network-firewall:firewall)
      json="$(awsq network-firewall describe-firewall --firewall-arn "$arn" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.FirewallStatus.Status // ""' <<<"$json")"
      judge "$s" READY never-fails ;;
    cloudfront:distribution)
      json="$(awsq cloudfront get-distribution --id "$id" --region us-east-1)" || { unanswered; return; }
      s="$(jq -r '.Distribution.Status // ""' <<<"$json")"
      judge "$s" Deployed never-fails ;;
    globalaccelerator:accelerator)
      json="$(awsq globalaccelerator describe-accelerator --accelerator-arn "$arn" --region us-west-2)" || { unanswered; return; }
      s="$(jq -r '.Accelerator.Status // ""' <<<"$json")"
      judge "$s" DEPLOYED never-fails ;;
    vpc-lattice:service)
      json="$(awsq vpc-lattice get-service --service-identifier "$id" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.status // ""' <<<"$json")"
      judge "$s" ACTIVE CREATE_FAILED ;;
    vpc-lattice:listener)
      # A listener has no status: it is ready once AWS can read it (a not-found is gone, as for any item).
      awsq vpc-lattice get-listener --service-identifier "${id%%/*}" --listener-identifier "${id##*/}" --region "$region" >/dev/null || { unanswered; return; } ;;
    vpc-lattice:servicenetworkvpcassociation)
      json="$(awsq vpc-lattice get-service-network-vpc-association --service-network-vpc-association-identifier "$id" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.status // ""' <<<"$json")"
      judge "$s" ACTIVE CREATE_FAILED ;;
    vpc-lattice:servicenetworkserviceassociation)
      json="$(awsq vpc-lattice get-service-network-service-association --service-network-service-association-identifier "$id" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.status // ""' <<<"$json")"
      judge "$s" ACTIVE CREATE_FAILED ;;
    route53resolver:resolver-endpoint)
      json="$(awsq route53resolver get-resolver-endpoint --resolver-endpoint-id "$id" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.ResolverEndpoint.Status // ""' <<<"$json")"
      judge "$s" OPERATIONAL ACTION_NEEDED ;;
    acm:certificate)
      json="$(awsq acm describe-certificate --certificate-arn "$arn" --region "$region")" || { unanswered; return; }
      judge "$(jq -r '.Certificate.Status // ""' <<<"$json")" ISSUED FAILED ;;
    *) ;; # ready by existing
  esac
}

# judge <state> <ready state> <failed state>: an empty state, or one being or
# already deleted (deleted, deleting, delete-complete, DELETING, ...), means
# AWS no longer has it.
judge() {
  local l="${1,,}"
  case "$l" in
    "" | delet*) KIND=gone ;;
    "${2,,}") KIND=ready ;;
    "${3,,}") KIND=failed; STATE="$1" ;;
    *) KIND=pending; STATE="$1" ;;
  esac
}

# This session's items only (SESSION_ID, from Parse payload): a quick redeploy
# must not wait on the last session's dead items the tagging API still lists.
FILTERS=("Key=cloudlabs-lab,Values=$LAB_ID")
[ -n "${SESSION_ID:-}" ] && FILTERS+=("Key=cloudlabs-session,Values=$SESSION_ID")
echo "ready check: everything tagged cloudlabs-lab=$LAB_ID${SESSION_ID:+ and cloudlabs-session=$SESSION_ID} in $REGIONS, for up to $DEPLOY_MIN min"
while :; do
  pending=()
  warming=()
  failed=()
  seen=0
  declare -A done_arns=()
  for r in $REGIONS; do
    if ! arns="$(awsq resourcegroupstaggingapi get-resources --tag-filters "${FILTERS[@]}" --region "$r" | jq -r '.ResourceTagMappingList[]?.ResourceARN')"; then
      pending+=("tagging $r (could not list the lab's resources)")
      continue
    fi
    while IFS= read -r arn; do
      [ -z "$arn" ] && continue
      [ -n "${done_arns[$arn]:-}" ] && continue
      done_arns[$arn]=1
      seen=$((seen + 1))
      check "$arn"
      case "$KIND" in
        failed) failed+=("$TYPE $NAME ($STATE)") ;;
        pending) pending+=("$TYPE $NAME ($STATE)") ;;
        initializing) warming+=("$TYPE $NAME ($STATE)") ;;
      esac
    done <<<"$arns"
  done
  unset done_arns
  [ "$seen" -eq 0 ] && [ "${#pending[@]}" -eq 0 ] && pending+=("lab $LAB_ID (nothing tagged for it yet)")

  if [ "${#failed[@]}" -gt 0 ]; then
    for p in "${failed[@]}" "${pending[@]}" "${warming[@]}"; do echo "not ready: $p"; done
    echo "::error::ready check: $LAB_ID has ${#failed[@]} item(s) in a failed state"
    exit 1
  fi
  if [ "${#pending[@]}" -eq 0 ] && [ "${#warming[@]}" -eq 0 ]; then
    echo "ready: all $seen tagged item(s) of $LAB_ID are ready"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    for p in "${warming[@]}"; do echo "::warning::ready check: still running its status checks at the deadline, counted ready: $p"; done
    if [ "${#pending[@]}" -eq 0 ]; then
      echo "ready: $LAB_ID is up (instance status checks still finishing)"
      exit 0
    fi
    for p in "${pending[@]}"; do echo "not ready: $p"; done
    echo "::error::ready check: $LAB_ID was not ready after $DEPLOY_MIN min"
    exit 1
  fi
  echo "waiting: $(( ${#pending[@]} + ${#warming[@]} )) item(s) of $LAB_ID not ready yet"
  sleep "$INTERVAL"
done
