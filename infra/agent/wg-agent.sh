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
loopback="$(ip -4 -o addr show dev lo1 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1 || true)"
# The public IPv6 path, if Azure gave the VM one (empty otherwise).
wan6="$(ip -6 -o addr show dev eth0 scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1 || true)"
# The boot self-test result, once it has run.
selftest="null"
[[ -s /run/wg-admin/selftest.json ]] && selftest="$(cat /run/wg-admin/selftest.json)"
dns_up=false
systemctl is-active --quiet dnsmasq && dns_up=true
blocked=0
[[ -r /etc/wg-admin/blocklist.hosts ]] && blocked="$(grep -c '^0\.0\.0\.0 ' /etc/wg-admin/blocklist.hosts || true)"

# Round-trip time to every client that shook hands in the last 3 minutes,
# one ping each, all at once. Like an IP SLA probe per spoke.
now="$(date +%s)"
rttdir="$(mktemp -d)"
while read -r pub _ _ ips hs _; do
  [[ -z "$pub" || "${hs:-0}" -eq 0 ]] && continue
  (( now - hs > 180 )) && continue
  ip4="$(tr ',' '\n' <<<"$ips" | grep -m1 -E '^[0-9.]+/32$' | cut -d/ -f1 || true)"
  [[ -z "$ip4" ]] && continue
  ( ms="$(ping -n -c1 -W1 "$ip4" 2>/dev/null | sed -n 's/.*time=\([0-9.]*\) ms.*/\1/p')"
    [[ -n "$ms" ]] && printf '%s\t%s\n' "$pub" "$ms" > "$rttdir/$(md5sum <<<"$pub" | cut -c1-12)" ) &
done < <(tail -n +2 <<<"$dump")
wait
rtt="$(cat "$rttdir"/* 2>/dev/null | jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {key: .[0], value: (.[1] | tonumber)}) | from_entries')"
rm -rf "$rttdir"

body="$(jq -n \
  --arg dump "$dump" \
  --arg up "$uptime_s" \
  --arg load "$load" \
  --arg host "$host" \
  --arg lb "$loopback" \
  --arg wan6 "$wan6" \
  --argjson selftest "$selftest" \
  --argjson rtt "${rtt:-null}" \
  --argjson dns "$dns_up" \
  --argjson blocked "${blocked:-0}" \
  '{agent_version: 3, hostname: $host, uptime_seconds: ($up|tonumber), load: $load, loopback: $lb, wan6: $wan6, selftest: $selftest, rtt: $rtt, dns: {up: $dns, blocked: $blocked}, dump: $dump}')"

# ── Report ──────────────────────────────────────────────────────────────────
resp="$(curl -fsS --max-time 10 \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$body" \
  "$AGENT_URL" 2>/dev/null)" || exit 0

# ── Reconcile peers, if the Worker sent a list ──────────────────────────────
# Reply shape: {"peers":[{"name":"laptop","host":"laptop","public_key":"...","allowed_ips":"10.13.13.2/32,fd13:13::2/128"}]}
jq -e '.peers | type == "array"' <<<"$resp" >/dev/null 2>&1 || exit 0

# Client names for the tunnel DNS: laptop.wg, phone.wg, and the VM itself.
hosts="$(mktemp)"
{
  [[ -n "$loopback" ]] && echo "$loopback vm.wg"
  jq -r '.peers[] | select(.host != null and .host != "") | (.allowed_ips | split(",") | map(split("/")[0]))[] as $a | "\($a) \(.host).wg"' <<<"$resp"
} > "$hosts"
if ! cmp -s "$hosts" /etc/wg-admin/peers.hosts 2>/dev/null; then
  install -m 0644 "$hosts" /etc/wg-admin/peers.hosts
  systemctl kill -s HUP dnsmasq 2>/dev/null || true
fi
rm -f "$hosts"

# The self-test adds a canary peer for a few seconds; leave the list alone
# until it is done, or this would remove the canary mid-test.
[[ -e /run/wg-admin/selftest.running ]] && exit 0

# Compare as "key sorted-allowed-ips" lines, so the order WireGuard happens to
# list addresses in never looks like a change.
norm() { while read -r k ips; do printf '%s %s\n' "$k" "$(tr ',' '\n' <<<"$ips" | sed '/^$/d' | sort | paste -sd, -)"; done | sort; }
desired="$(jq -r '.peers[] | "\(.public_key) \(.allowed_ips | gsub(" "; ""))"' <<<"$resp" | norm)"
current="$(wg show wg0 dump | tail -n +2 | awk '{print $1, $4}' | norm)"

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
