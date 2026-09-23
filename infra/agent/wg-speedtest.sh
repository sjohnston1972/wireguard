#!/usr/bin/env bash
# wg-speedtest.sh <id> <target-ip>
#
# Plain English: an iperf test across the tunnel, VM to the home site
# container (which runs an iperf3 server), five seconds each way, then ten
# quick pings for latency and jitter. Started by the agent when the dashboard
# asks (the request rides on a heartbeat reply); the result is left in
# /run/wg-admin/speedtest.json and the agent carries it back on the next
# heartbeat. iperf3 is installed the first time, so boots stay fast.

set -uo pipefail
export LC_ALL=C
ID="${1:?id}"
T="${2:?target}"
DIR=/run/wg-admin
OUT="$DIR/speedtest.json"
mkdir -p "$DIR"

if ! command -v iperf3 >/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iperf3 >/dev/null 2>&1 || true
fi

err=""
down="" up=""
if command -v iperf3 >/dev/null; then
  # VM sends, home receives: Azure -> home.
  down="$(iperf3 -c "$T" -t 5 -J 2>/dev/null | jq -r '.end.sum_received.bits_per_second // empty' 2>/dev/null || true)"
  # Reversed: home sends, VM receives: home -> Azure.
  up="$(iperf3 -c "$T" -t 5 -R -J 2>/dev/null | jq -r '.end.sum_received.bits_per_second // empty' 2>/dev/null || true)"
  [[ -z "$down$up" ]] && err="iperf3 could not reach $T:5201 (is the home container running?)"
else
  err="could not install iperf3 on the VM"
fi

# "rtt min/avg/max/mdev = 21.3/24.0/29.8/2.1 ms"
stats="$(ping -n -c 10 -i 0.2 -W 1 "$T" 2>/dev/null | sed -n 's/.*= [0-9.]*\/\([0-9.]*\)\/[0-9.]*\/\([0-9.]*\) ms.*/\1 \2/p')"
rtt="${stats%% *}"
jit="${stats##* }"

jq -n \
  --arg id "$ID" \
  --arg err "$err" \
  --arg down "$down" --arg up "$up" --arg rtt "$rtt" --arg jit "$jit" \
  '{id: $id,
    down_bps: ($down | tonumber? // null), up_bps: ($up | tonumber? // null),
    rtt_ms: ($rtt | tonumber? // null), jitter_ms: ($jit | tonumber? // null),
    error: (if $err == "" then null else $err end)}' > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
logger -t wg-speedtest "id=$ID down=${down:-?} up=${up:-?} rtt=${rtt:-?} ${err}"
