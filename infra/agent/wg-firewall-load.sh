#!/usr/bin/env bash
# wg-firewall-load.sh
#
# Plain English: loads the firewall at boot (wg-firewall.service), before
# the tunnel comes up. It must fail CLOSED, never open:
#
#   1. Load the saved rule set (the dashboard's rule table).
#   2. If that is refused, load a "block everything routed" rule set instead
#      and write why to /run/wg-admin/firewall.error, so the dashboard shows
#      it. The tunnel still comes up (the firewall never filters the VM's own
#      traffic, so the heartbeat keeps working) and the dashboard sends a
#      good rule set on the next heartbeat.
#   3. If even that is refused, exit with an error. wg-quick@wg0 requires
#      this service, so the tunnel then stays down rather than run with no
#      firewall at all.
#
# Like a firewall that boots with a corrupt config: it comes up denying,
# not permitting.

set -uo pipefail
FW_FILE=/etc/wg-admin/firewall.nft
RUN=/run/wg-admin
mkdir -p "$RUN"

if nft -f "$FW_FILE" 2>"$RUN/firewall.boot.err"; then
  rm -f "$RUN/firewall.error" "$RUN/firewall.fallback" "$RUN/firewall.boot.err"
  exit 0
fi

{
  printf 'At boot the saved rule set was refused, so all routed traffic is blocked until a good one arrives. '
  head -c 300 "$RUN/firewall.boot.err" 2>/dev/null || echo "(the rule set file is missing)"
} > "$RUN/firewall.error"
rm -f "$RUN/firewall.boot.err"
logger -t wg-firewall "saved rule set refused at boot; loading block-all fallback: $(head -c 200 "$RUN/firewall.error")"

# The fallback: the same table name, so the dashboard's next rule set
# replaces it in one step. Default drop, logged like the normal default,
# so the dashboard's Recent drops shows what is being blocked.
if nft -f - <<'EOF'
table inet wgfw
delete table inet wgfw
table inet wgfw {
  counter default { }
  chain forward {
    type filter hook forward priority filter + 10; policy drop;
    limit rate 10/second log prefix "wgfw-drop " level info
    counter name "default" drop
  }
}
EOF
then
  # Tells the agent the saved rule set is not the one in force, so it asks
  # the dashboard for it again rather than reporting it as loaded.
  touch "$RUN/firewall.fallback"
  exit 0
fi

logger -t wg-firewall "even the block-all fallback was refused; the tunnel will stay down"
why="$(cat "$RUN/firewall.error")"
echo "The firewall could not be loaded at all; the tunnel is kept down. $why" > "$RUN/firewall.error"
exit 1
