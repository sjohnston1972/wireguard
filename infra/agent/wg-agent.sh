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
# A finished speed test waiting to be reported (see wg-speedtest.sh).
speedtest="null"
[[ -s /run/wg-admin/speedtest.json ]] && speedtest="$(cat /run/wg-admin/speedtest.json)"

# Firewall: which rule set is loaded, each rule's hit counter, and what the
# default-deny rule dropped since the last heartbeat (from the kernel log).
FW_FILE=/etc/wg-admin/firewall.nft
fw_hash=""
[[ -r "$FW_FILE" ]] && fw_hash="$(sed -n 's/^# ruleset \([0-9a-f]*\).*/\1/p' "$FW_FILE" | head -n1)"
# At boot the saved file was refused and the block-all fallback is in force
# (see wg-firewall-load.sh): report no rule set, so the dashboard sends it again.
[[ -e /run/wg-admin/firewall.fallback ]] && fw_hash=""
fw_counters="$(nft -j list counters table inet wgfw 2>/dev/null | jq -c '[.nftables[] | .counter? // empty | {key: .name, value: [.packets, .bytes]}] | from_entries' 2>/dev/null || true)"
[[ -z "$fw_counters" ]] && fw_counters="{}"
fw_error=""
[[ -s /run/wg-admin/firewall.error ]] && fw_error="$(head -c 400 /run/wg-admin/firewall.error)"
# "wgfw-drop IN=wg0 OUT=eth0 SRC=10.13.13.3 DST=10.50.2.4 ... PROTO=TCP SPT=51000 DPT=3389"
# Read the kernel log from exactly where the last heartbeat stopped (a
# journal bookmark, the "cursor"), so each drop is reported once, however
# the heartbeats happen to be spaced. The first run after boot has no
# bookmark yet and looks back 35 seconds.
mkdir -p /run/wg-admin
KCURSOR=/run/wg-admin/kernel.cursor
since=()
[[ -s "$KCURSOR" ]] || since=(--since '-35 seconds')
fw_drops="$(journalctl -k "${since[@]}" --cursor-file="$KCURSOR" -o cat --no-pager 2>/dev/null | grep 'wgfw-drop' | tail -n 20 \
  | sed -n 's/.*IN=\([^ ]*\) OUT=\([^ ]*\).* SRC=\([^ ]*\) DST=\([^ ]*\).* PROTO=\([^ ]*\)\( SPT=\([0-9]*\) DPT=\([0-9]*\)\)\{0,1\}.*/\3 \4 \5 \8 \1 \2/p' \
  | jq -R -s -c 'split("\n") | map(select(length > 0) | split(" ") | {src: .[0], dst: .[1], proto: .[2], dport: (.[3] | if . == "" then null else tonumber end), in: .[4], out: .[5]})' 2>/dev/null || true)"
[[ -z "$fw_drops" ]] && fw_drops="[]"

# Names for addresses: what the tunnel DNS answered recently ("reply
# www.example.com is 93.184.216.34"), kept in a small map so top talkers
# show names, not just numbers. The query log is emptied each time it is read.
DNSLOG=/var/log/dnsmasq-queries.log
DNSMAP=/run/wg-admin/dnsmap.tsv
mkdir -p /run/wg-admin
if [[ -s "$DNSLOG" ]]; then
  { cat "$DNSMAP" 2>/dev/null; sed -n 's/.* \(reply\|cached\) \([^ ]*\) is \([0-9.]*\)$/\3\t\2/p' "$DNSLOG"; } \
    | awk -F'\t' '{m[$1]=$2} END {for (k in m) print k "\t" m[k]}' | tail -n 5000 > "$DNSMAP.tmp" && mv "$DNSMAP.tmp" "$DNSMAP"
  : > "$DNSLOG"
fi

# Top talkers: bytes per tunnel client and remote address, each way, from
# the firewall's self-filling sets. The 40 biggest pairs, with names.
talkers="$(
  { nft -j list set inet wgfw up4 2>/dev/null | jq -r '.nftables[] | .set? // empty | .elem[]? | .elem | "\(.val.concat[0])\t\(.val.concat[1])\tup\t\(.counter.bytes)"';
    nft -j list set inet wgfw down4 2>/dev/null | jq -r '.nftables[] | .set? // empty | .elem[]? | .elem | "\(.val.concat[0])\t\(.val.concat[1])\tdown\t\(.counter.bytes)"'; } \
  | awk -F'\t' -v mapf="$DNSMAP" 'BEGIN { while ((getline l < mapf) > 0) { split(l, a, "\t"); n[a[1]] = a[2] } }
      { k = $1 "\t" $2; if ($3 == "up") u[k] += $4; else d[k] += $4 }
      END { for (k in u) s[k] = 1; for (k in d) s[k] = 1;
            for (k in s) { split(k, p, "\t"); printf "%s\t%s\t%d\t%d\t%s\n", p[1], p[2], u[k] + 0, d[k] + 0, n[p[2]] } }' \
  | sort -t$'\t' -k3,3nr -k4,4nr | awk -F'\t' '{print $0 "\t" ($3 + $4)}' | sort -t$'\t' -k6,6nr | head -n 40 \
  | jq -R -s -c 'split("\n") | map(select(length > 0) | split("\t") | {c: .[0], r: .[1], up: (.[2] | tonumber), down: (.[3] | tonumber), name: (if .[4] == "" then null else .[4] end)})' 2>/dev/null || true
)"
[[ -z "$talkers" ]] && talkers="[]"
# A packet capture in progress, if any (see wg-capture.sh).
cap_running="$(ls /run/wg-admin/capture.*.running 2>/dev/null | head -n1 | sed 's/.*capture\.\(.*\)\.running/\1/' || true)"

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
# Nobody answering is normal (no client connected): that must never stop the
# heartbeat, so an empty result becomes {} instead of a failed pipeline
# (found live 2026-09-25: a fresh VM with no clients sent no heartbeats).
rtt="$(cat "$rttdir"/* 2>/dev/null | jq -R -s -c 'split("\n") | map(select(length > 0) | split("\t") | {key: .[0], value: (.[1] | tonumber)}) | from_entries' 2>/dev/null || true)"
[[ -z "$rtt" ]] && rtt="{}"
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
  --argjson speedtest "$speedtest" \
  --arg fwhash "$fw_hash" \
  --arg fwerr "$fw_error" \
  --argjson fwcounters "$fw_counters" \
  --argjson fwdrops "$fw_drops" \
  --argjson talkers "$talkers" \
  --arg caprun "$cap_running" \
  '{agent_version: 6, talkers: $talkers, capture_running: (if $caprun == "" then null else $caprun end), hostname: $host, uptime_seconds: ($up|tonumber), load: $load, loopback: $lb, wan6: $wan6, selftest: $selftest, rtt: $rtt, dns: {up: $dns, blocked: $blocked}, speedtest_result: $speedtest,
    firewall: {hash: $fwhash, error: (if $fwerr == "" then null else $fwerr end), counters: $fwcounters, drops: $fwdrops}, dump: $dump}')"

# ── Report ──────────────────────────────────────────────────────────────────
resp="$(curl -fsS --max-time 10 \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$body" \
  "$AGENT_URL" 2>/dev/null)" || exit 0

# ── Reconcile peers, if the Worker sent a list ──────────────────────────────
# Reply shape: {"peers":[{"name":"laptop","host":"laptop","public_key":"...","allowed_ips":"10.13.13.2/32,fd13:13::2/128"}]}

# ── Firewall: a new rule set from the dashboard ─────────────────────────────
# Checked with "nft -c" first, then loaded in one transaction, so a bad rule
# set is refused whole and the old one stays in force. Saved to the file the
# boot service loads, so a resume from Standby comes back with the same rules.
fw_new="$(jq -r '.firewall.nft_b64 // empty' <<<"$resp" 2>/dev/null || true)"
if [[ -n "$fw_new" ]]; then
  mkdir -p /run/wg-admin
  tmp="$(mktemp)"
  if base64 -d <<<"$fw_new" > "$tmp" 2>/dev/null && nft -c -f "$tmp" 2>/run/wg-admin/firewall.error && nft -f "$tmp" 2>/run/wg-admin/firewall.error; then
    install -m 0600 -o root -g root "$tmp" "$FW_FILE"
    rm -f /run/wg-admin/firewall.error /run/wg-admin/firewall.fallback
    logger -t wg-agent "firewall rule set applied: $(sed -n 's/^# ruleset \([0-9a-f]*\).*/\1/p' "$FW_FILE" | head -n1)"
    # If the firewall could not load at all at boot, the tunnel was kept
    # down. Now there is a good rule set, bring both up.
    if systemctl is-failed --quiet wg-firewall.service; then
      systemctl restart wg-firewall.service && systemctl start --no-block wg-quick@wg0 || true
    fi
  else
    logger -t wg-agent "firewall rule set refused: $(head -c 200 /run/wg-admin/firewall.error)"
  fi
  rm -f "$tmp"
fi

# ── Packet capture: start one when asked (once per id) ──────────────────────
cap_id="$(jq -r '.capture.id // empty' <<<"$resp" 2>/dev/null || true)"
if [[ "$cap_id" =~ ^[0-9a-f]{6,32}$ && ! -e "/run/wg-admin/capture.$cap_id.started" ]]; then
  cap_if="$(jq -r '.capture.iface // "wg0"' <<<"$resp")"
  cap_s="$(jq -r '.capture.seconds // 60' <<<"$resp")"
  cap_f="$(jq -r '.capture.filter // ""' <<<"$resp")"
  touch "/run/wg-admin/capture.$cap_id.started"
  systemd-run --quiet --unit "wg-capture-$cap_id" --no-block /usr/local/sbin/wg-capture.sh "$cap_id" "$cap_if" "$cap_s" "$cap_f" || true
fi

# ── Speed test: forget a result once the Worker has it; start one when asked ─
ack="$(jq -r '.speedtest_ack // empty' <<<"$resp" 2>/dev/null || true)"
if [[ -n "$ack" && -s /run/wg-admin/speedtest.json ]] && [[ "$(jq -r '.id' /run/wg-admin/speedtest.json 2>/dev/null || true)" == "$ack" ]]; then
  rm -f /run/wg-admin/speedtest.json
fi
st_id="$(jq -r '.speedtest.id // empty' <<<"$resp" 2>/dev/null || true)"
st_target="$(jq -r '.speedtest.target // empty' <<<"$resp" 2>/dev/null || true)"
if [[ "$st_id" =~ ^[0-9a-f]{6,32}$ && "$st_target" =~ ^[0-9.]+$ && ! -e "/run/wg-admin/speedtest.$st_id" ]]; then
  mkdir -p /run/wg-admin && touch "/run/wg-admin/speedtest.$st_id"
  # Its own short-lived unit, so it outlives this 25-second heartbeat.
  systemd-run --quiet --unit "wg-speedtest-$st_id" --no-block /usr/local/sbin/wg-speedtest.sh "$st_id" "$st_target" || true
fi

jq -e '.peers | type == "array"' <<<"$resp" >/dev/null 2>&1 || exit 0

# Check every peer before any of it goes near wg0.conf, which root reads at
# every boot: a proper WireGuard key, addresses that really are addresses,
# a DNS name that is only letters, digits and dashes, and a display name of
# plain characters only (a line break in a name could otherwise slip a
# "PostUp = ..." line into the file). A peer that fails is left out and
# logged. The dashboard checks the same things; this is the second lock.
peers="$(jq -c '
  def v4: test("^([0-9]{1,3}\\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$");
  def v6: test("^[0-9a-fA-F:]*:[0-9a-fA-F:]*/([0-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$");
  [.peers[]
   | select(type == "object")
   | select((.public_key | type) == "string" and (.public_key | test("^[A-Za-z0-9+/]{43}=$")))
   | select((.allowed_ips | type) == "string")
   | .allowed_ips |= gsub(" "; "")
   | select(.allowed_ips | split(",") | length > 0 and all(v4 or v6))
   | {name: ((.name // "") | tostring | gsub("[^A-Za-z0-9 _.-]"; "?") | .[0:64]),
      host: ((.host // "") | tostring | if test("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$") then . else "" end),
      public_key, allowed_ips}]' <<<"$resp" 2>/dev/null || true)"
[[ -z "$peers" ]] && exit 0
sent="$(jq '.peers | length' <<<"$resp")"
kept="$(jq 'length' <<<"$peers")"
(( kept < sent )) && logger -t wg-agent "peer list: $(( sent - kept )) of $sent peer(s) refused (bad key, address or name)"

# Client names for the tunnel DNS: laptop.wg, phone.wg, and the VM itself.
hosts="$(mktemp)"
{
  [[ -n "$loopback" ]] && echo "$loopback vm.wg"
  jq -r '.[] | select(.host != "") | (.allowed_ips | split(",") | map(split("/")[0]))[] as $a | "\($a) \(.host).wg"' <<<"$peers"
} > "$hosts"
if ! cmp -s "$hosts" /etc/wg-admin/peers.hosts 2>/dev/null; then
  install -m 0644 "$hosts" /etc/wg-admin/peers.hosts
  systemctl kill -s HUP dnsmasq 2>/dev/null || true
fi
rm -f "$hosts"

# Site routes: a peer that carries a whole network (the home LAN behind the
# home container) needs a kernel route sending that network into wg0, like a
# static route towards a branch. wg-quick only adds these at boot, so keep
# them in place here for a site added while the VM is running. A route with
# no matching peer yet simply drops traffic, so adding it early is harmless.
#
# Never a route that would cut the VM off: nothing wider than /8 (0.0.0.0/0
# would take the default route, and the VM could never reach the dashboard
# again to be fixed), and nothing overlapping what the VM needs for itself:
# the tunnel, its loopback, its own LAN and VNet, Azure's platform
# addresses, and the dashboard's own address.
# (10# so a part written "08" is read as eight, not as a broken octal number.)
ip2int() { local IFS=.; set -- $1; echo $(( (10#$1 << 24) + (10#$2 << 16) + (10#$3 << 8) + 10#$4 )); }
# Do two IPv4 networks (a.b.c.d/n) share any address?
overlaps() {
  local a="${1%/*}" an="${1#*/}" b="${2%/*}" bn="${2#*/}"
  [[ "$1" == */* ]] || an=32
  [[ "$2" == */* ]] || bn=32
  local n=$(( an < bn ? an : bn ))
  local mask=$(( n == 0 ? 0 : (0xffffffff << (32 - n)) & 0xffffffff ))
  (( ($(ip2int "$a") & mask) == ($(ip2int "$b") & mask) ))
}
keep_out=(168.63.129.16/32 169.254.169.254/32)
[[ -n "${VNET_CIDR:-}" ]] && keep_out+=("$VNET_CIDR")
[[ -n "$loopback" ]] && keep_out+=("$loopback/32")
while read -r net; do [[ -n "$net" ]] && keep_out+=("$net") || true; done < <(
  ip -4 -o addr show dev wg0 2>/dev/null | awk '{print $4}'
  ip -4 -o addr show dev eth0 2>/dev/null | awk '{print $4}'
  getent ahostsv4 "$(sed -E 's#^[a-z]+://([^/:]+).*#\1#' <<<"$AGENT_URL")" 2>/dev/null | awk '{print $1 "/32"}' | sort -u
)
route_ok() {
  local cidr="$1" bits="${1#*/}" k
  [[ "$cidr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]] || return 1
  (( bits >= 8 )) || return 1
  for k in "${keep_out[@]}"; do overlaps "$cidr" "$k" && return 1; done
  return 0
}
wanted_routes=()
while read -r cidr; do
  [[ -z "$cidr" ]] && continue
  if route_ok "$cidr"; then
    wanted_routes+=("$cidr")
    ip route replace "$cidr" dev wg0 2>/dev/null || true
  else
    logger -t wg-agent "site route $cidr refused: too wide, or overlaps a network the VM needs"
  fi
done < <(jq -r '.[].allowed_ips | split(",")[] | select(test("^[0-9.]+/([0-9]|[12][0-9]|3[01])$"))' <<<"$peers" 2>/dev/null || true)
# And take away a site route nobody carries any more (a site deleted or
# changed). Only routes into wg0 that someone added; the tunnel's own
# subnet route belongs to the kernel and is left alone.
while read -r cidr; do
  [[ -z "$cidr" || "$cidr" == default ]] && continue
  [[ "$cidr" == */* ]] || continue  # single-address routes are never ours
  [[ " ${wanted_routes[*]} " == *" $cidr "* ]] && continue
  { ip route del "$cidr" dev wg0 2>/dev/null && logger -t wg-agent "site route $cidr removed: no peer carries it now"; } || true
done < <(ip -4 -o route show dev wg0 2>/dev/null | grep -v 'proto kernel' | awk '{print $1}')

# The self-test adds a canary peer for a few seconds; leave the list alone
# until it is done, or this would remove the canary mid-test.
[[ -e /run/wg-admin/selftest.running ]] && exit 0

# Compare as "key sorted-allowed-ips" lines, so the order WireGuard happens to
# list addresses in never looks like a change.
norm() { while read -r k ips; do printf '%s %s\n' "$k" "$(tr ',' '\n' <<<"$ips" | sed '/^$/d' | sort | paste -sd, -)"; done | sort; }
desired="$(jq -r '.[] | "\(.public_key) \(.allowed_ips)"' <<<"$peers" | norm)"
current="$(wg show wg0 dump | tail -n +2 | awk '{print $1, $4}' | norm)"

[[ "$desired" == "$current" ]] && exit 0

# Build the new peers half and the whole conf in a private scratch folder,
# have WireGuard itself check it by loading it live ("wg syncconf" reads the
# whole file before changing anything, so a bad one changes nothing), and
# only then move the files into place. A peer list WireGuard refuses is
# never saved, so it cannot break the tunnel at the next boot either.
work="$(mktemp -d)"
jq -r '.[] | "# \(.name)\n[Peer]\nPublicKey = \(.public_key)\nAllowedIPs = \(.allowed_ips)\n"' <<<"$peers" > "$work/peers.conf"
cat "$IFACE_CONF" "$work/peers.conf" > "$work/wg0.conf"
if wg-quick strip "$work/wg0.conf" > "$work/wg0.strip" 2>"$work/err" && wg syncconf wg0 "$work/wg0.strip" 2>>"$work/err"; then
  install -m 0600 -o root -g root "$work/peers.conf" "$PEERS_CONF.new" && mv -f "$PEERS_CONF.new" "$PEERS_CONF"
  install -m 0600 -o root -g root "$work/wg0.conf" "$WG_CONF.new" && mv -f "$WG_CONF.new" "$WG_CONF"
  logger -t wg-agent "peers reconciled: $kept peer(s)"
else
  logger -t wg-agent "peer list refused by WireGuard, nothing changed: $(tr '\n' ' ' < "$work/err" | head -c 200)"
fi
rm -rf "$work"
