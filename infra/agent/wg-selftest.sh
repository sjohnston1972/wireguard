#!/usr/bin/env bash
# wg-selftest.sh
#
# Plain English: before the dashboard trusts the headend, a throwaway client
# inside the VM dials it and tries every job a real client would do: shake
# hands, ping the tunnel end and the loopback, look up a name through the
# tunnel DNS, and reach the internet through NAT (IPv4, and IPv6 when the VM
# has it). Like a loopback test plug on a new circuit before handing it over.
#
# How: a separate network namespace (a VRF, in router terms) holds a WireGuard
# interface made in the main namespace and moved in. Its UDP socket stays
# outside, so it can dial the headend at 127.0.0.1 while every packet it
# carries has to cross the real wg0, forwarding and NAT path.
#
# Runs at every boot (wg-selftest.service), so a resume from standby is
# checked too. The result goes to /run/wg-admin/selftest.json and the agent
# forwards it with each heartbeat. While it runs the agent leaves the peer
# list alone, so the canary peer is not removed mid-test.

set -uo pipefail
export LC_ALL=C

DIR=/run/wg-admin
OUT="$DIR/selftest.json"
FLAG="$DIR/selftest.running"
NS=wgcanary
mkdir -p "$DIR"
touch "$FLAG"

started="$(date +%s%3N)"
srv4="$(ip -4 -o addr show dev wg0 2>/dev/null | awk '{print $4}' | head -n1 | cut -d/ -f1)"
srv6="$(ip -6 -o addr show dev wg0 scope global 2>/dev/null | awk '{print $4}' | head -n1 | cut -d/ -f1)"
lb="$(ip -4 -o addr show dev lo1 2>/dev/null | awk '{print $4}' | head -n1 | cut -d/ -f1)"
port="$(wg show wg0 listen-port 2>/dev/null)"
spub="$(wg show wg0 public-key 2>/dev/null)"
# The canary takes the last host of the tunnel /24 (.254, and ::fe in IPv6),
# far from the clients, which are handed out from .2 upwards.
cip="${srv4%.*}.254"
cip6=""
[ -n "$srv6" ] && cip6="${srv6%::*}::fe"
wan6="$(ip -6 -o addr show dev eth0 scope global 2>/dev/null | awk '{print $4}' | head -n1 | cut -d/ -f1)"

key="$(mktemp -p "$DIR")"
chmod 600 "$key"
wg genkey > "$key"
pub="$(wg pubkey < "$key")"

cleanup() {
  ip netns del "$NS" 2>/dev/null
  wg set wg0 peer "$pub" remove 2>/dev/null
  rm -f "$key" "$FLAG"
}
trap cleanup EXIT

result() { # write the JSON; missing checks are null
  jq -n \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson ms "$(( $(date +%s%3N) - started ))" \
    --arg error "${1:-}" \
    --argjson handshake "${handshake:-null}" \
    --argjson tunnel "${tunnel:-null}" \
    --argjson loopback "${loopback:-null}" \
    --argjson dns "${dns:-null}" \
    --argjson internet "${internet:-null}" \
    --argjson internet6 "${internet6:-null}" \
    '{at:$at, ms:$ms, handshake:$handshake, tunnel:$tunnel, loopback:$loopback, dns:$dns, internet:$internet, internet6:$internet6}
     + (if $error == "" then {} else {error:$error} end)' > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
}

if [ -z "$srv4" ] || [ -z "$port" ] || [ -z "$spub" ]; then
  result "wg0 is not up"
  exit 1
fi

ok() { ip netns exec "$NS" "$@" >/dev/null 2>&1 && echo true || echo false; }

ip netns del "$NS" 2>/dev/null
ip netns add "$NS"
ip -n "$NS" link set lo up
ip link add wgc type wireguard
ip link set wgc netns "$NS"

allowed="$cip/32"
[ -n "$cip6" ] && allowed="$allowed,$cip6/128"
wg set wg0 peer "$pub" allowed-ips "$allowed"

ip netns exec "$NS" wg set wgc private-key "$key" \
  peer "$spub" endpoint "127.0.0.1:$port" allowed-ips 0.0.0.0/0,::/0 persistent-keepalive 1
ip -n "$NS" addr add "$cip/32" dev wgc
[ -n "$cip6" ] && ip -n "$NS" -6 addr add "$cip6/128" dev wgc nodad
ip -n "$NS" link set wgc up
ip -n "$NS" route add default dev wgc
[ -n "$cip6" ] && ip -n "$NS" -6 route add default dev wgc

# The first ping triggers the handshake, so allow it a few tries.
tunnel="$(ok ping -c3 -W2 "$srv4")"
hs="$(wg show wg0 latest-handshakes | awk -v k="$pub" '$1 == k {print $2}')"
if [ "${hs:-0}" -gt 0 ]; then handshake=true; else handshake=false; fi
[ -n "$lb" ] && loopback="$(ok ping -c1 -W2 "$lb")"
if [ -n "$lb" ] && command -v dig >/dev/null; then
  if [ -n "$(ip netns exec "$NS" dig +short +time=2 +tries=2 @"$lb" example.com A 2>/dev/null | grep -E '^[0-9.]+$')" ]; then dns=true; else dns=false; fi
fi
internet="$(ok curl -fsS -m 8 -o /dev/null https://1.1.1.1/cdn-cgi/trace)"
[ -n "$cip6" ] && [ -n "$wan6" ] && internet6="$(ok curl -6 -fsS -m 8 -o /dev/null "https://[2606:4700:4700::1111]/cdn-cgi/trace")"

result
logger -t wg-selftest "handshake=$handshake tunnel=$tunnel loopback=${loopback:-null} dns=${dns:-null} internet=$internet internet6=${internet6:-null}"
