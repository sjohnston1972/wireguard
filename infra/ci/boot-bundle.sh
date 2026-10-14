#!/usr/bin/env bash
# boot-bundle.sh OUT.tgz
#
# Plain English: packs the files an AWS server needs at first boot that will
# not fit in AWS's 16 KB of user data: the agent scripts and this deploy's
# firewall rules. wg-aws.yml uploads it to R2 as boot/<run id>.tgz; the server
# fetches it from the Worker with its own token and checks the SHA-256.
# Modes match cloud-init.yaml.tftpl (scripts/test/boot-bundle.test.mjs).
set -euo pipefail
out="$1"
root="$(cd "$(dirname "$0")/../agent" && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage" "$stage.list"' EXIT
put() { install -D -m "$3" "$1" "$stage$2"; }

put "$root/wg-agent.sh" /usr/local/sbin/wg-agent.sh 0755
put "$root/wg-vitals.sh" /usr/local/sbin/wg-vitals.sh 0755
put "$root/wg-selftest.sh" /usr/local/sbin/wg-selftest.sh 0755
put "$root/wg-blocklist.sh" /usr/local/sbin/wg-blocklist.sh 0755
put "$root/wg-speedtest.sh" /usr/local/sbin/wg-speedtest.sh 0755
put "$root/wg-capture.sh" /usr/local/sbin/wg-capture.sh 0755
put "$root/wg-firewall-load.sh" /usr/local/sbin/wg-firewall-load.sh 0755

# This deploy's firewall (from the Worker, via "Collect run secrets"), else the open default.
if [[ -n "${TF_VAR_firewall_nft_b64:-}" ]]; then
  base64 -d <<<"$TF_VAR_firewall_nft_b64" > "$stage/fw.tmp"
else
  cp "$root/firewall-open.nft" "$stage/fw.tmp"
fi
install -D -m 0600 "$stage/fw.tmp" "$stage/etc/wg-admin/firewall.nft"
rm -f "$stage/fw.tmp"

# Files only, no directory entries: unpacking never changes /usr or /etc themselves.
( cd "$stage" && find . -type f | sed 's#^\./##' | sort ) > "$stage.list"
tar -C "$stage" --owner=0 --group=0 --numeric-owner --mtime='2000-01-01 00:00Z' -czf "$out" -T "$stage.list"
