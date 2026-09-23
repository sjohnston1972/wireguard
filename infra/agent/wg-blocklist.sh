#!/usr/bin/env bash
# wg-blocklist.sh
#
# Plain English: fetch a public list of advert and tracker hostnames and
# hand it to the tunnel DNS (dnsmasq), which then answers 0.0.0.0 for them.
# Clients that use the tunnel DNS get ad-blocking with nothing installed.
# Best effort: without the list, DNS still works, it just blocks nothing.

set -uo pipefail
LIST_URL="https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts"
OUT=/etc/wg-admin/blocklist.hosts

tmp="$(mktemp)"
if curl -fsSL --max-time 60 "$LIST_URL" | awk '$1 == "0.0.0.0" && $2 != "0.0.0.0" {print "0.0.0.0 " $2}' > "$tmp" && [ -s "$tmp" ]; then
  install -m 0644 "$tmp" "$OUT"
  systemctl kill -s HUP dnsmasq 2>/dev/null || true
  logger -t wg-blocklist "loaded $(wc -l < "$OUT") blocked names"
else
  logger -t wg-blocklist "could not fetch the blocklist; DNS works without it"
fi
rm -f "$tmp"
