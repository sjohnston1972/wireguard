#!/usr/bin/env bash
# wg-agent.sh
#
# Plain English: a heartbeat. Every 30 seconds (driven by wg-agent.timer) this
# script sends the Worker a snapshot of the tunnel: which peers exist, when
# each last shook hands, and how many bytes went through. The same idea as an
# SNMP trap or a NetFlow export, but a simple HTTPS POST with a bearer token.
#
# The Worker's reply may contain the full list of peers it wants running. If
# that differs from what is loaded, the agent rewrites the [Peer] section and
# hot-reloads WireGuard with "wg syncconf". This is how a new phone gets
# added without rebuilding the VM.
#
# It must never break the tunnel: any failure to reach the Worker is silent.

set -euo pipefail
export LC_ALL=C

ENV_FILE=/etc/wireguard/wg-agent.env
IFACE_CONF=/etc/wireguard/wg0.interface.conf
PEERS_CONF=/etc/wireguard/wg0.peers.conf
WG_CONF=/etc/wireguard/wg0.conf

# shellcheck disable=SC1090
[[ -r "$ENV_FILE" ]] && source "$ENV_FILE"
AGENT_URL="${AGENT_URL:-}"
AGENT_TOKEN="${AGENT_TOKEN:-}"

# No token means this VM was built without a Worker (e.g. a manual test run).
[[ -z "$AGENT_TOKEN" || -z "$AGENT_URL" ]] && exit 0

# ── Collect ─────────────────────────────────────────────────────────────────
dump="$(wg show wg0 dump 2>/dev/null || true)"
uptime_s="$(cut -d' ' -f1 /proc/uptime)"
load="$(cut -d' ' -f1-3 /proc/loadavg)"
host="$(hostname)"
# The loopback test address on lo1, if this build has one (empty otherwise).
loopback="$(ip -4 -o addr show dev lo1 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)"

body="$(jq -n \
  --arg dump "$dump" \
  --arg up "$uptime_s" \
  --arg load "$load" \
  --arg host "$host" \
  --arg lb "$loopback" \
  '{agent_version: 2, hostname: $host, uptime_seconds: ($up|tonumber), load: $load, loopback: $lb, dump: $dump}')"

# ── Report ──────────────────────────────────────────────────────────────────
resp="$(curl -fsS --max-time 10 \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$body" \
  "$AGENT_URL" 2>/dev/null)" || exit 0

# ── Reconcile peers, if the Worker sent a list ──────────────────────────────
# Reply shape: {"peers":[{"name":"laptop","public_key":"...","allowed_ips":"10.13.13.2/32"}]}
jq -e '.peers | type == "array"' <<<"$resp" >/dev/null 2>&1 || exit 0

desired="$(jq -r '.peers | sort_by(.public_key) | .[] | "\(.public_key) \(.allowed_ips)"' <<<"$resp")"
current="$(wg show wg0 dump | tail -n +2 | awk '{print $1, $4}' | sort)"

[[ "$desired" == "$current" ]] && exit 0

# Rebuild the peers half, then the whole conf, then hot-reload.
tmp="$(mktemp)"
jq -r '.peers[] | "# \(.name)\n[Peer]\nPublicKey = \(.public_key)\nAllowedIPs = \(.allowed_ips)\n"' <<<"$resp" > "$tmp"
install -m 0600 -o root -g root "$tmp" "$PEERS_CONF"
rm -f "$tmp"
cat "$IFACE_CONF" "$PEERS_CONF" > "$WG_CONF"
chmod 0600 "$WG_CONF"
wg syncconf wg0 <(wg-quick strip wg0)
logger -t wg-agent "peers reconciled: $(jq '.peers | length' <<<"$resp") peer(s)"
