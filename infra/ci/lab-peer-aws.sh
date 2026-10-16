#!/usr/bin/env bash
# infra/ci/lab-peer-aws.sh peer <lab id>     lab-aws.yml step 9, "Peer"
# infra/ci/lab-peer-aws.sh unpeer <lab id>   lab-aws.yml step 10, "Unpeer"
#
# Plain English: connects an AWS lab's VPC to the VPN server's VPC (vpc-wg,
# 10.50.0.0/16) with a VPC peering connection and a route each way, so tunnel
# clients reach the lab's private addresses, and takes it apart again (AWS
# labs spec §2 connectivity rule, §5 steps 9-10). It runs as wg-admin-deploy,
# which owns the server's VPC (ruling A25), with a 1-hour session. These are
# the only writes a lab run makes to the server's side, and only to routes
# whose target is a connection tagged for this lab (or dead routes inside the
# lab pool 10.64.0.0/13).
#
# The server's VPC and route table are found by their tags: Name = vpc-wg /
# rt-wg and wg-admin = vpn. Every call is in $LAB_REGION (eu-west-2).
#
# peer: first asks the Worker (POST $LAB_PEER_URL {run_id, phase:"begin"}).
#   The Worker answers {"go":true} only when the server is up and it could
#   take the server's lock for this run; {"go":false, reason} means wait (the
#   dashboard offers "Re-peer" later). Without $LAB_PEER_URL (a run with no
#   Worker) it skips. Then:
#     - the lab VPC: $PEER_VPC_ID (Terraform's peer_vpc_id), else (a peer run,
#       which has no outputs; ruling A38) the VPC tagged cloudlabs-lab = <id>
#       and cloudlabs-peer = hub, else the lab's only VPC
#     - which must carry the tag cloudlabs-lab = <id>, or nothing is written
#     - its route tables: $PEER_ROUTE_TABLE_IDS (a JSON list), else that VPC's
#       route tables tagged for the lab; only those inside the lab VPC are used
#     - reuses an active or pending connection tagged for the lab between the
#       two VPCs, or creates one (tags cloudlabs-lab = <id>, Name =
#       lab-<id>-headend), accepts it and waits up to 60 s for it to be active
#     - route <slot> -> connection in rt-wg, and <gateway_cidr> -> connection
#       in each lab route table (replacing a route that already exists)
#   Finally {phase:"end", ok} releases the lock, whatever happened.
#
# unpeer (no Worker, no lock: a teardown never waits), touching only the
#   gateway connection the peer step makes (Name = lab-<id>-headend), never a
#   peering the lab builds between its own VPCs (lab 08), in this order:
#   1. the rt-wg routes whose target is one of the lab's connections
#   2. the lab route tables' routes to those connections (if the lab is still up)
#   3. the connections themselves
#   4. every blackhole route in rt-wg whose destination lies inside the lab pool
#
# Never fails the run (exit 0; 2 only for bad arguments): a peering problem is
# reported (and told to the Worker); the lab itself is still up, or still
# coming down. AWS's error text is cut to its code: it can carry the account id.

set -uo pipefail

ACTION="${1:-}"
LAB_ID="${2:-}"
LAB_ID_RE='^(az(104|305|700)|soa|saa|ans)-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$'
if ! [[ "$LAB_ID" =~ $LAB_ID_RE ]] || [ "${#LAB_ID}" -gt 30 ] || { [ "$ACTION" != peer ] && [ "$ACTION" != unpeer ]; }; then
  echo "::error::lab-peer-aws: usage: lab-peer-aws.sh peer|unpeer <lab id> (got '${ACTION}' '${LAB_ID}')"
  exit 2
fi
REGION="${LAB_REGION:-eu-west-2}"
WG_VPC_FILTERS=(Name=tag:Name,Values=vpc-wg Name=tag:wg-admin,Values=vpn)
WG_RT_FILTERS=(Name=tag:Name,Values=rt-wg Name=tag:wg-admin,Values=vpn)
ID_OK='^(vpc|rtb|pcx)-[0-9a-z]+$'

ERRF="$(mktemp)"
cleanup() { rm -f "$ERRF"; }
trap cleanup EXIT
warn() { echo "::warning::$ACTION: $*" >&2; }
# Every aws call: its error text goes to a file, of which only the code is ever shown.
awsx() { aws "$@" 2>"$ERRF"; }
errcode() { sed -n 's/.*An error occurred (\([A-Za-z0-9.]*\)).*/\1/p' "$ERRF" | head -n1; }
# A read in the lab's region: the answer's JSON.
awsq() { awsx "$@" --region "$REGION" --output json; }
# A write in the lab's region: nothing printed but a warning with the error code.
awsw() { awsx "$@" --region "$REGION" >/dev/null; }

# Inside the lab pool 10.64.0.0/13 (10.64.0.0 - 10.71.255.255)?
in_pool() {
  local ip="${1%/*}" len="${1#*/}" a b
  IFS=. read -r a b _ _ <<<"$ip"
  [[ "$len" =~ ^[0-9]+$ && "$a" == 10 && "$b" =~ ^[0-9]+$ ]] && [ "$b" -ge 64 ] && [ "$b" -le 71 ] && [ "$len" -ge 13 ]
}

# The ids a read lists, one per line (jq path), or nothing.
ids() { jq -r "$1 // empty" 2>/dev/null; }

# ── unpeer ───────────────────────────────────────────────────────────────

if [ "$ACTION" = unpeer ]; then
  pcx_json="$(awsq ec2 describe-vpc-peering-connections --filters "Name=tag:cloudlabs-lab,Values=$LAB_ID" "Name=tag:Name,Values=lab-$LAB_ID-headend")" || { warn "could not list the lab's peering connections ($(errcode))"; pcx_json='{}'; }
  mapfile -t PCX < <(ids '.VpcPeeringConnections[]?.VpcPeeringConnectionId' <<<"$pcx_json")
  mapfile -t LIVE < <(ids '.VpcPeeringConnections[]? | select((.Status.Code // "") | IN("deleted", "deleting", "rejected", "failed", "expired") | not) | .VpcPeeringConnectionId' <<<"$pcx_json")
  is_lab_pcx() {
    local p
    for p in "${PCX[@]}"; do [ "$p" = "$1" ] && return 0; done
    return 1
  }
  # "table cidr connection state" for every IPv4 route of the tables in a describe-route-tables answer.
  routes() { ids '.RouteTables[]? | .RouteTableId as $t | .Routes[]? | select(.DestinationCidrBlock != null) | [$t, .DestinationCidrBlock, (.VpcPeeringConnectionId // "-"), (.State // "-")] | join(" ")'; }

  # 1. rt-wg's routes to this lab's connections.
  if wg_rt_json="$(awsq ec2 describe-route-tables --filters "${WG_RT_FILTERS[@]}")"; then
    while read -r t cidr p _; do
      [ -z "$t" ] && continue
      is_lab_pcx "$p" || continue
      if awsw ec2 delete-route --route-table-id "$t" --destination-cidr-block "$cidr"; then echo "unpeer: removed rt-wg's route $cidr"; else warn "could not remove rt-wg's route $cidr ($(errcode))"; fi
    done < <(routes <<<"$wg_rt_json")
  else
    warn "could not read rt-wg ($(errcode)); nothing removed on the server's side"
  fi
  # 2. The lab route tables' routes to them, while the lab is still up.
  if [ "${#PCX[@]}" -gt 0 ]; then
    if lab_rt_json="$(awsq ec2 describe-route-tables --filters "Name=tag:cloudlabs-lab,Values=$LAB_ID")"; then
      while read -r t cidr p _; do
        [ -z "$t" ] && continue
        is_lab_pcx "$p" || continue
        if awsw ec2 delete-route --route-table-id "$t" --destination-cidr-block "$cidr"; then echo "unpeer: removed the lab's route $cidr in $t"; else warn "could not remove the lab's route $cidr in $t ($(errcode))"; fi
      done < <(routes <<<"$lab_rt_json")
    else
      warn "could not read the lab's route tables ($(errcode))"
    fi
  fi
  # 3. The connections.
  for p in "${LIVE[@]}"; do
    if awsw ec2 delete-vpc-peering-connection --vpc-peering-connection-id "$p"; then echo "unpeer: deleted $p"; else warn "could not delete $p ($(errcode))"; fi
  done
  [ "${#PCX[@]}" -eq 0 ] && echo "unpeer: no peering connection is tagged for $LAB_ID"
  # 4. Dead routes into the lab pool (a lab whose connection went another way).
  if wg_rt_json="$(awsq ec2 describe-route-tables --filters "${WG_RT_FILTERS[@]}")"; then
    while read -r t cidr _ state; do
      [ -z "$t" ] || [ "$state" != blackhole ] && continue
      in_pool "$cidr" || continue
      if awsw ec2 delete-route --route-table-id "$t" --destination-cidr-block "$cidr"; then echo "unpeer: removed rt-wg's dead route $cidr"; else warn "could not remove rt-wg's dead route $cidr ($(errcode))"; fi
    done < <(routes <<<"$wg_rt_json")
  fi
  exit 0
fi

# ── peer ─────────────────────────────────────────────────────────────────

if [ -z "${LAB_PEER_URL:-}" ] || [ -z "${CALLBACK_TOKEN:-}" ]; then
  echo "peer: no Worker for this run (no callback): peering skipped"
  exit 0
fi
RUN_ID="${WORKER_RUN_ID:-manual}"
tell() {
  curl -sS --fail-with-body --max-time 20 -X POST \
    -H "Authorization: Bearer $CALLBACK_TOKEN" -H "Content-Type: application/json" \
    -d "$1" "$LAB_PEER_URL"
}

answer="$(tell "$(jq -cn --arg r "$RUN_ID" '{run_id: $r, phase: "begin"}')")" || answer=""
if ! jq -e '.go == true' <<<"$answer" >/dev/null 2>&1; then
  reason="$(jq -r '.reason // empty' <<<"$answer" 2>/dev/null)"
  echo "peer: the Worker says wait (${reason:-the VPN server is not running, or is busy}); the dashboard will offer Re-peer"
  exit 0
fi

OK=false
end_peer() { tell "$(jq -cn --arg r "$RUN_ID" --argjson ok "$OK" '{run_id: $r, phase: "end", ok: $ok}')" >/dev/null || warn "could not tell the Worker the peering ended"; }
trap 'end_peer; cleanup' EXIT

# Exactly one of each on the server's side.
one() { # what json-path json
  local got
  got="$(ids "$2" <<<"$3")"
  if [ -z "$got" ]; then warn "the VPN server's $1 is not there; nothing to peer to"; return 1; fi
  if [ "$(wc -l <<<"$got")" -ne 1 ]; then warn "more than one $1 carries the server's tags; not peering"; return 1; fi
  printf '%s\n' "$got"
}
wg_vpc="$(one vpc-wg '.Vpcs[]?.VpcId' "$(awsq ec2 describe-vpcs --filters "${WG_VPC_FILTERS[@]}")")" || exit 0
wg_rt="$(one rt-wg '.RouteTables[]?.RouteTableId' "$(awsq ec2 describe-route-tables --filters "${WG_RT_FILTERS[@]}")")" || exit 0

lab_vpc="${PEER_VPC_ID:-}"
if [ -z "$lab_vpc" ]; then
  lab_vpc="$(ids '.Vpcs[]?.VpcId' <<<"$(awsq ec2 describe-vpcs --filters "Name=tag:cloudlabs-lab,Values=$LAB_ID" Name=tag:cloudlabs-peer,Values=hub)")"
  if [ -z "$lab_vpc" ] || [ "$(wc -l <<<"$lab_vpc")" -ne 1 ]; then
    lab_vpc="$(ids '.Vpcs[]?.VpcId' <<<"$(awsq ec2 describe-vpcs --filters "Name=tag:cloudlabs-lab,Values=$LAB_ID")")"
    [ -n "$lab_vpc" ] && [ "$(wc -l <<<"$lab_vpc")" -ne 1 ] && { warn "the lab has several VPCs and none is tagged cloudlabs-peer = hub; not peering"; exit 0; }
  fi
fi
if ! [[ "$lab_vpc" =~ $ID_OK ]] || [[ "$lab_vpc" != vpc-* ]]; then
  warn "the lab has no VPC to peer"
  exit 0
fi
# Defence in depth for the VPN server: only a VPC that carries this lab's tag is
# ever peered to it, whichever way it was found. Nothing is written otherwise.
tagged="$(ids '.Vpcs[]?.VpcId' <<<"$(awsq ec2 describe-vpcs --vpc-ids "$lab_vpc" --filters "Name=tag:cloudlabs-lab,Values=$LAB_ID")")"
if [ "$tagged" != "$lab_vpc" ]; then
  warn "$lab_vpc is not tagged cloudlabs-lab = $LAB_ID (or AWS could not say); refusing to peer it to the VPN server"
  exit 0
fi

# The lab's route tables, and only those inside the lab VPC.
rt_problem=0
lab_rts=()
if [ -n "${PEER_ROUTE_TABLE_IDS:-}" ]; then mapfile -t lab_rts < <(ids '.[]?' <<<"$PEER_ROUTE_TABLE_IDS"); fi
if [ "${#lab_rts[@]}" -gt 0 ]; then
  for t in "${lab_rts[@]}"; do
    [[ "$t" =~ $ID_OK && "$t" == rtb-* ]] || { warn "'$t' is not a route table id; not peering"; exit 0; }
  done
  mapfile -t inside < <(ids '.RouteTables[]?.RouteTableId' <<<"$(awsq ec2 describe-route-tables --route-table-ids "${lab_rts[@]}" --filters "Name=vpc-id,Values=$lab_vpc")")
  for t in "${lab_rts[@]}"; do
    printf '%s\n' "${inside[@]}" | grep -qx "$t" || { warn "$t is not a route table of $lab_vpc; skipped"; rt_problem=1; }
  done
  lab_rts=("${inside[@]}")
else
  mapfile -t lab_rts < <(ids '.RouteTables[]?.RouteTableId' <<<"$(awsq ec2 describe-route-tables --filters "Name=vpc-id,Values=$lab_vpc" "Name=tag:cloudlabs-lab,Values=$LAB_ID")")
fi

slot="${TF_VAR_address_space:-}"
gateway="${TF_VAR_gateway_cidr:-10.50.0.0/16}"
if ! in_pool "$slot"; then
  warn "the lab's slot '${slot}' is not inside 10.64.0.0/13; not peering"
  exit 0
fi

# An active or pending connection tagged for the lab between the two VPCs, else a new one.
pcx=""
status=""
found="$(awsq ec2 describe-vpc-peering-connections --filters "Name=tag:cloudlabs-lab,Values=$LAB_ID" "Name=requester-vpc-info.vpc-id,Values=$lab_vpc" "Name=accepter-vpc-info.vpc-id,Values=$wg_vpc" Name=status-code,Values=active,pending-acceptance,provisioning,initiating-request)" || found='{}'
IFS='|' read -r pcx status < <(ids '.VpcPeeringConnections[0] // empty | [.VpcPeeringConnectionId, (.Status.Code // "")] | join("|")' <<<"$found")
if [ -n "$pcx" ]; then
  echo "peer: reusing the lab's peering connection $pcx ($status)"
else
  if ! created="$(awsq ec2 create-vpc-peering-connection --vpc-id "$lab_vpc" --peer-vpc-id "$wg_vpc" --tag-specifications "ResourceType=vpc-peering-connection,Tags=[{Key=cloudlabs-lab,Value=$LAB_ID},{Key=Name,Value=lab-$LAB_ID-headend}]")"; then
    warn "could not create the peering connection ($(errcode))"
    exit 0
  fi
  pcx="$(ids '.VpcPeeringConnection.VpcPeeringConnectionId' <<<"$created")"
  status=pending-acceptance
  echo "peer: created $pcx"
fi
if ! [[ "$pcx" =~ $ID_OK ]] || [[ "$pcx" != pcx-* ]]; then
  warn "AWS gave no peering connection id"
  exit 0
fi

# A reused connection that is active or already provisioning (accepted) needs no accepting.
if [ "$status" != active ] && [ "$status" != provisioning ]; then
  accepted=false
  for _ in 1 2 3 4 5; do
    if awsw ec2 accept-vpc-peering-connection --vpc-peering-connection-id "$pcx"; then accepted=true; break; fi
    sleep 2
  done
  [ "$accepted" = true ] || { warn "could not accept $pcx ($(errcode))"; exit 0; }
fi
# Up to 60 s for it to be active.
for _ in $(seq 1 20); do
  status="$(ids '.VpcPeeringConnections[0].Status.Code' <<<"$(awsq ec2 describe-vpc-peering-connections --vpc-peering-connection-ids "$pcx")")"
  case "$status" in
    active) break ;;
    failed | rejected | expired | deleted) warn "$pcx is $status"; exit 0 ;;
  esac
  sleep 3
done
if [ "$status" != active ]; then
  warn "$pcx was not active after 60 s (${status:-no status})"
  exit 0
fi

# route <table> <cidr>: to the connection, replacing a route that is already there.
route() {
  if awsw ec2 create-route --route-table-id "$1" --destination-cidr-block "$2" --vpc-peering-connection-id "$pcx"; then return 0; fi
  if [ "$(errcode)" = RouteAlreadyExists ] && awsw ec2 replace-route --route-table-id "$1" --destination-cidr-block "$2" --vpc-peering-connection-id "$pcx"; then return 0; fi
  warn "could not route $2 through $pcx in $1 ($(errcode))"
  return 1
}
failed="$rt_problem"
route "$wg_rt" "$slot" || failed=1
if [ "${#lab_rts[@]}" -eq 0 ]; then
  warn "the lab has no route table to route $gateway back"
  failed=1
fi
for t in "${lab_rts[@]}"; do
  [[ "$t" =~ $ID_OK && "$t" == rtb-* ]] || { warn "'$t' is not a route table id"; failed=1; continue; }
  route "$t" "$gateway" || failed=1
done

if [ "$failed" -eq 0 ]; then
  OK=true
  echo "peer: $lab_vpc <-> vpc-wg peered ($pcx): $slot from the server, $gateway from the lab"
fi
exit 0
