#!/usr/bin/env bash
# infra/ci/lab-peer.sh peer <lab id>     lab.yml step 9, "Peer"
# infra/ci/lab-peer.sh unpeer <lab id>   lab.yml step 10, "Unpeer"
#
# Plain English: connects a lab's VNet to the gateway's (vnet-wg) so tunnel
# clients reach the lab's private addresses, and takes it apart again (labs
# spec §7.6). These are the only writes a lab run ever makes to the gateway's
# resource group, and only to peerings named lab-<id>.
#
# peer: first asks the Worker (POST $LAB_PEER_URL {run_id, phase:"begin"}).
#   The Worker answers {"go":true} only when the gateway is up and it could
#   take the gateway's lock for this run, so a peering never races a gateway
#   apply or destroy. Then, both sides:
#     lab side   lab-<id>-to-wg  allow virtual network access, allow forwarded traffic
#     wg side    lab-<id>        allow virtual network access
#   and, with DNS_LINK=true (lab.yaml) and "dns_link":true in the Worker's
#   begin answer, links each private DNS zone in rg-lab-<id> to vnet-wg (link
#   lab-<id>-wg; the link lives in the lab's group). Finally
#   {phase:"end", ok} releases the lock, whatever happened.
#   {"go":false} means wait: the dashboard offers "Re-peer" once the gateway
#   is running. Without $LAB_PEER_URL (a run with no Worker) it skips.
#
# unpeer: deletes the vnet-wg side first (so the gateway never points at a
#   lab that is going away), then the lab side and the DNS links if the lab's
#   group still exists. No lock: a teardown must never wait. Idempotent: a
#   missing gateway VNet or lab group is simply nothing to do.
#
# Never fails the run: a peering problem is reported (and told to the
# Worker); the lab itself is still up, or still coming down.
#
# PEER_VNET_ID (the lab's peer_vnet_id output) picks the lab VNet; without it
# the first VNet in rg-lab-<id> is used. The gateway's group comes from $RG
# (or LAB_GATEWAY_RG), and defaults to rg-wg-ondemand.

set -uo pipefail

ACTION="${1:-}"
LAB_ID="${2:-}"
LAB_ID_RE='^az(104|305|700)-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$'
if ! [[ "$LAB_ID" =~ $LAB_ID_RE ]] || [ "${#LAB_ID}" -gt 40 ] || { [ "$ACTION" != peer ] && [ "$ACTION" != unpeer ]; }; then
  echo "::error::lab-peer: usage: lab-peer.sh peer|unpeer <lab id> (got '${ACTION}' '${LAB_ID}')"
  exit 2
fi
# The gateway's group: $RG in lab.yml (the AZURE_RESOURCE_GROUP secret, a name the live log hides).
GW_RG="${LAB_GATEWAY_RG:-${RG:-rg-wg-ondemand}}"
RG="rg-lab-$LAB_ID"
GW_VNET="vnet-wg"
LAB_PEERING="lab-$LAB_ID-to-wg"
WG_PEERING="lab-$LAB_ID"
DNS_LINK_NAME="lab-$LAB_ID-wg"

warn() { echo "::warning::$ACTION: $*" >&2; }
azq() { az "$@" | tr -d '\r'; }
if [ -n "${ARM_CLIENT_ID:-}" ]; then
  AZURE_CONFIG_DIR="$(mktemp -d)"
  export AZURE_CONFIG_DIR
  trap 'rm -rf "$AZURE_CONFIG_DIR"' EXIT
  az login --service-principal -u "$ARM_CLIENT_ID" -p "$ARM_CLIENT_SECRET" --tenant "$ARM_TENANT_ID" -o none &&
    az account set --subscription "$ARM_SUBSCRIPTION_ID" || warn "could not sign in to Azure"
fi

# The lab's VNet to peer: "id<TAB>name<TAB>group", or nothing.
lab_vnet() {
  local id="${PEER_VNET_ID:-}"
  [ -z "$id" ] && id="$(azq network vnet list --resource-group "$RG" --query "sort_by([], &name)[0].id" -o tsv | head -n1)"
  [ -z "$id" ] && return 1
  local g
  g="$(sed -n 's|.*/resourceGroups/\([^/]*\)/.*|\1|p' <<<"$id")"
  g="${g,,}"
  if [[ "$g" != "$RG" && "$g" != "$RG"-* ]]; then
    warn "peer_vnet_id is not in the lab's group; refusing it"
    return 1
  fi
  printf '%s\t%s\t%s\n' "$id" "${id##*/}" "$g"
}

# ── unpeer ───────────────────────────────────────────────────────────────

if [ "$ACTION" = unpeer ]; then
  if az network vnet show --resource-group "$GW_RG" --name "$GW_VNET" --query id -o tsv >/dev/null 2>&1; then
    if azq network vnet peering list --resource-group "$GW_RG" --vnet-name "$GW_VNET" --query "[].name" -o tsv | grep -qx "$WG_PEERING"; then
      if az network vnet peering delete --resource-group "$GW_RG" --vnet-name "$GW_VNET" --name "$WG_PEERING"; then echo "unpeer: removed $GW_VNET -> lab"; else warn "could not remove the $GW_VNET side ($WG_PEERING)"; fi
    else
      echo "unpeer: $GW_VNET has no $WG_PEERING peering"
    fi
  else
    echo "unpeer: the gateway VNet is not there (gateway destroyed); nothing to remove on its side"
  fi
  if [ "$(azq group exists --name "$RG")" = "true" ]; then
    while IFS= read -r vid; do
      [ -z "$vid" ] && continue
      vname="${vid##*/}"
      if azq network vnet peering list --resource-group "$RG" --vnet-name "$vname" --query "[].name" -o tsv | grep -qx "$LAB_PEERING"; then
        az network vnet peering delete --resource-group "$RG" --vnet-name "$vname" --name "$LAB_PEERING" && echo "unpeer: removed lab -> $GW_VNET" || warn "could not remove the lab side on $vname"
      fi
    done < <(azq network vnet list --resource-group "$RG" --query "[].id" -o tsv)
    while IFS= read -r zone; do
      [ -z "$zone" ] && continue
      if azq network private-dns link vnet list --resource-group "$RG" --zone-name "$zone" --query "[].name" -o tsv | grep -qx "$DNS_LINK_NAME"; then
        az network private-dns link vnet delete --resource-group "$RG" --zone-name "$zone" --name "$DNS_LINK_NAME" --yes && echo "unpeer: unlinked $zone" || warn "could not unlink $zone"
      fi
    done < <(azq network private-dns zone list --resource-group "$RG" --query "[].name" -o tsv)
  else
    echo "unpeer: $RG is gone; nothing to remove on the lab side"
  fi
  exit 0
fi

# ── peer ─────────────────────────────────────────────────────────────────

if [ -z "${LAB_PEER_URL:-}" ] || [ -z "${CALLBACK_TOKEN:-}" ]; then
  echo "peer: no Worker for this run (no callback); peering is skipped"
  exit 0
fi
RUN_ID="${WORKER_RUN_ID:-manual}"
RUN_ID="${RUN_ID//\"/}"
tell() {
  curl -sS --fail-with-body --max-time 20 -X POST \
    -H "Authorization: Bearer $CALLBACK_TOKEN" -H "Content-Type: application/json" \
    -d "$1" "$LAB_PEER_URL"
}

answer="$(tell "{\"run_id\":\"$RUN_ID\",\"phase\":\"begin\"}")" || answer=""
if ! grep -Eq '"go"[[:space:]]*:[[:space:]]*true' <<<"$answer"; then
  echo "peer: the Worker says wait (the gateway is not running, or is busy); the dashboard will offer Re-peer"
  exit 0
fi
# The Worker also says whether this run may link its private DNS zones to
# vnet-wg: not when another peered lab has already linked a zone of the same
# name (Azure refuses two). Only an explicit "dns_link": true links.
WORKER_DNS_LINK=false
grep -Eq '"dns_link"[[:space:]]*:[[:space:]]*true' <<<"$answer" && WORKER_DNS_LINK=true
if [ "${DNS_LINK:-false}" = true ] && [ "$WORKER_DNS_LINK" != true ]; then
  note="$(sed -n 's/.*"note"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' <<<"$answer" | head -n1)"
  echo "peer: private DNS zones not linked: ${note:-the Worker said not to link them for this run}"
fi

OK=false
end_peer() { tell "{\"run_id\":\"$RUN_ID\",\"phase\":\"end\",\"ok\":$OK}" >/dev/null || warn "could not tell the Worker the peering ended"; }
trap 'end_peer; [ -n "${AZURE_CONFIG_DIR:-}" ] && rm -rf "$AZURE_CONFIG_DIR"' EXIT

gw_id="$(azq network vnet show --resource-group "$GW_RG" --name "$GW_VNET" --query id -o tsv)" || gw_id=""
if [ -z "$gw_id" ]; then
  warn "the gateway VNet is not there; nothing to peer to"
  exit 0
fi
if ! IFS=$'\t' read -r lab_id lab_name lab_rg < <(lab_vnet); then
  warn "the lab has no VNet in $RG to peer"
  exit 0
fi

ensure_peering() { # group vnet name remote [flags...]
  local g="$1" v="$2" n="$3" remote="$4"
  shift 4
  if az network vnet peering show --resource-group "$g" --vnet-name "$v" --name "$n" -o none 2>/dev/null; then
    echo "peer: $n already exists"
    return 0
  fi
  az network vnet peering create --resource-group "$g" --vnet-name "$v" --name "$n" --remote-vnet "$remote" "$@" -o none
}

failed=0
ensure_peering "$lab_rg" "$lab_name" "$LAB_PEERING" "$gw_id" --allow-vnet-access --allow-forwarded-traffic || { warn "could not create the lab side"; failed=1; }
ensure_peering "$GW_RG" "$GW_VNET" "$WG_PEERING" "$lab_id" --allow-vnet-access || { warn "could not create the $GW_VNET side"; failed=1; }

if [ "${DNS_LINK:-false}" = true ] && [ "$WORKER_DNS_LINK" = true ] && [ "$failed" -eq 0 ]; then
  while IFS= read -r zone; do
    [ -z "$zone" ] && continue
    # A privatelink zone linked to vnet-wg would otherwise answer NXDOMAIN for every
    # other storage account (or vault...) of that kind: fall back to public DNS
    # for names the zone does not hold. Azure takes this only on privatelink zones.
    policy=()
    [[ "${zone,,}" == privatelink.* ]] && policy=(--resolution-policy NxDomainRedirect)
    az network private-dns link vnet create --resource-group "$RG" --zone-name "$zone" --name "$DNS_LINK_NAME" --virtual-network "$gw_id" --registration-enabled false "${policy[@]}" -o none ||
      warn "could not link $zone to $GW_VNET (already linked by the lab's own Terraform?)"
  done < <(azq network private-dns zone list --resource-group "$RG" --query "[].name" -o tsv)
fi

if [ "$failed" -eq 0 ]; then
  OK=true
  echo "peer: $lab_name <-> $GW_VNET peered"
fi
exit 0
