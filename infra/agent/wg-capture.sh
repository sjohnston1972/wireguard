#!/usr/bin/env bash
# wg-capture.sh <id> <iface> <seconds> [filter]
#
# Plain English: a packet capture on the VM, like "monitor capture" on a
# router or a SPAN port into Wireshark. tcpdump records whole packets on the
# chosen side (wg0 = inside the tunnel, decrypted; eth0 = the Azure side; any
# = both) for the chosen time, stopping early at 25 MB. The file is
# compressed and sent to the dashboard, which keeps it in R2 for download.
# Started by the agent when the dashboard asks (the request rides on a
# heartbeat reply), in its own short-lived unit so it outlives the heartbeat.

set -uo pipefail
ID="${1:?id}"
IFACE="${2:?iface}"
SECS="${3:?seconds}"
FILTER="${4:-}"
MAX_BYTES=$((25 * 1024 * 1024))

source /etc/wireguard/wg-agent.env
DIR=/run/wg-admin
F="$DIR/capture-$ID.pcap"
mkdir -p "$DIR"
touch "$DIR/capture.$ID.running"

upload_error() {
  curl -fsS --max-time 20 -X POST -H "Authorization: Bearer $AGENT_TOKEN" -H "X-Capture-Error: $1" \
    --data-binary "" "$AGENT_URL/capture/$ID" >/dev/null 2>&1 || true
  rm -f "$DIR/capture.$ID.running" "$F" "$F.gz"
  exit 1
}

case "$IFACE" in wg0|eth0|any) ;; *) upload_error "unknown interface $IFACE" ;; esac
[[ "$SECS" =~ ^[0-9]+$ && "$SECS" -ge 5 && "$SECS" -le 300 ]] || upload_error "bad duration $SECS"
command -v tcpdump >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tcpdump >/dev/null 2>&1 || upload_error "could not install tcpdump"

# The filter is one argument, never evaluated by a shell.
if [[ -n "$FILTER" ]]; then
  tcpdump -i "$IFACE" -s 0 -U -n -w "$F" "$FILTER" 2>"$DIR/capture-$ID.err" &
else
  tcpdump -i "$IFACE" -s 0 -U -n -w "$F" 2>"$DIR/capture-$ID.err" &
fi
pid=$!
sleep 1
kill -0 "$pid" 2>/dev/null || upload_error "tcpdump refused: $(tr '\n' ' ' < "$DIR/capture-$ID.err" | head -c 180)"

end=$((SECONDS + SECS))
while (( SECONDS < end )) && kill -0 "$pid" 2>/dev/null; do
  [[ -f "$F" && "$(stat -c %s "$F")" -ge "$MAX_BYTES" ]] && break
  sleep 1
done
kill -INT "$pid" 2>/dev/null
wait "$pid" 2>/dev/null
gzip -f -6 "$F" || upload_error "could not compress the capture"

for try in 1 2 3; do
  if curl -fsS --max-time 120 -X POST -H "Authorization: Bearer $AGENT_TOKEN" -H "Content-Type: application/octet-stream" \
       --data-binary @"$F.gz" "$AGENT_URL/capture/$ID" >/dev/null 2>&1; then
    logger -t wg-capture "capture $ID uploaded ($(stat -c %s "$F.gz") bytes)"
    rm -f "$F.gz" "$DIR/capture.$ID.running" "$DIR/capture-$ID.err"
    exit 0
  fi
  sleep $((try * 5))
done
logger -t wg-capture "capture $ID upload failed"
rm -f "$DIR/capture.$ID.running"
