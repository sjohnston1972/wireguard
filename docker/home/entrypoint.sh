#!/bin/sh
# entrypoint.sh: bring the tunnel up, start the speed-test server, then keep
# the headend's address fresh. WireGuard looks the Endpoint name up once;
# the VM gets a new public IP on every rebuild, so every 30 seconds the name
# is looked up again and handed back to WireGuard (the same job as the
# reresolve-dns script that ships with wireguard-tools).
set -eu
CONF=/etc/wireguard/wg0.conf
[ -r "$CONF" ] || { echo "no $CONF; run: npm run home"; exit 1; }

wg-quick up wg0
iperf3 -s -D --logfile /tmp/iperf3.log

PEER="$(wg show wg0 peers | head -n1)"
ENDPOINT="$(sed -n 's/^Endpoint *= *//p' "$CONF" | head -n1)"
echo "home site up: $(wg show wg0 | sed -n 's/^ *allowed ips: //p' | head -n1) via $ENDPOINT"

trap 'wg-quick down wg0; exit 0' TERM INT
while :; do
  sleep 30 &
  wait $! || true
  wg set wg0 peer "$PEER" endpoint "$ENDPOINT" 2>/dev/null || true
done
