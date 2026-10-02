#!/bin/sh
# entrypoint.sh: bring the tunnel up, start the speed-test server, then keep
# the headend's address fresh. WireGuard looks the Endpoint name up once;
# the VM gets a new public IP on every rebuild, so every 30 seconds the name
# is looked up again and handed back to WireGuard (the same job as the
# reresolve-dns script that ships with wireguard-tools). A failed lookup or a
# move to a new address is logged once, so a stuck tunnel shows in
# "docker logs wg-home" instead of failing silently.
set -eu
CONF=/etc/wireguard/wg0.conf
[ -r "$CONF" ] || { echo "no $CONF; run: npm run home"; exit 1; }

wg-quick up wg0
iperf3 -s -D --logfile /tmp/iperf3.log

PEER="$(wg show wg0 peers | head -n1)"
ENDPOINT="$(sed -n 's/^Endpoint *= *//p' "$CONF" | head -n1)"
echo "home site up: $(wg show wg0 | sed -n 's/^ *allowed ips: //p' | head -n1) via $ENDPOINT"

trap 'wg-quick down wg0; exit 0' TERM INT
failing=
while :; do
  sleep 30 &
  wait $! || true
  before="$(wg show wg0 endpoints | cut -f2)"
  if err="$(wg set wg0 peer "$PEER" endpoint "$ENDPOINT" 2>&1)"; then
    after="$(wg show wg0 endpoints | cut -f2)"
    [ "$after" != "$before" ] && echo "headend moved: $before -> $after"
    [ -n "$failing" ] && echo "$ENDPOINT resolves again ($after)"
    failing=
  else
    [ -z "$failing" ] && echo "cannot look up $ENDPOINT, still dialling $before; retrying every 30 s: $err"
    failing=1
  fi
done
