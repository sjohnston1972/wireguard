#!/usr/bin/env bash
# infra/ci/lab-ready.sh <lab id> <deploy_min>
#
# Plain English: lab.yml step 8, "Ready check" (labs spec §5, §11.2). Terraform
# saying "applied" is not the same as Azure saying "ready": some resources
# finish provisioning after the API call returns. This polls every resource in
# rg-lab-<id> and rg-lab-<id>-* until each one's provisioningState is
# Succeeded, for up to the lab's deploy_min (at least 2 minutes). It exits 0
# when everything is ready and 1, listing what is not, when time runs out or
# when the lab has no resource group at all.
#
# LAB_READY_INTERVAL (seconds between polls, default 15) and
# LAB_READY_SECONDS (overrides the deadline) are for tests.

set -uo pipefail

LAB_ID="${1:-}"
DEPLOY_MIN="${2:-}"
LAB_ID_RE='^az(104|305|700)-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$'
if ! [[ "$LAB_ID" =~ $LAB_ID_RE ]] || [ "${#LAB_ID}" -gt 40 ]; then
  echo "::error::lab-ready: refusing lab id '${LAB_ID}'"
  exit 2
fi
if ! [[ "$DEPLOY_MIN" =~ ^[0-9]{1,3}$ ]]; then
  echo "::error::lab-ready: deploy_min must be a whole number of minutes"
  exit 2
fi
RG="rg-lab-$LAB_ID"
INTERVAL="${LAB_READY_INTERVAL:-15}"
if [ -n "${LAB_READY_SECONDS:-}" ]; then
  LIMIT="$LAB_READY_SECONDS"
else
  LIMIT=$(((DEPLOY_MIN < 2 ? 2 : DEPLOY_MIN) * 60))
fi

# Resource types that never report a provisioningState (labs spec §17, ruling 36):
# one with an empty state passes only when its type is here. Added test-first, on
# a release test's evidence; the list starts empty.
READY_NO_STATE_TYPES=()
no_state_ok() {
  local t
  for t in "${READY_NO_STATE_TYPES[@]}"; do [ "${1,,}" = "${t,,}" ] && return 0; done
  return 1
}

azq() { az "$@" | tr -d '\r'; }
owns_rg() {
  local n="${1,,}"
  [[ "$n" == "$RG" || "$n" == "$RG"-* ]]
}
if [ -n "${ARM_CLIENT_ID:-}" ]; then
  AZURE_CONFIG_DIR="$(mktemp -d)"
  export AZURE_CONFIG_DIR
  trap 'rm -rf "$AZURE_CONFIG_DIR"' EXIT
  az login --service-principal -u "$ARM_CLIENT_ID" -p "$ARM_CLIENT_SECRET" --tenant "$ARM_TENANT_ID" -o none &&
    az account set --subscription "$ARM_SUBSCRIPTION_ID" || { echo "::error::ready check: could not sign in to Azure"; exit 1; }
fi

deadline=$(($(date +%s) + LIMIT))
polls=0
while :; do
  polls=$((polls + 1))
  pending=()
  groups=0
  if all="$(azq group list --query "[].[name, properties.provisioningState]" -o tsv)"; then
    while IFS=$'\t' read -r g state; do
      [ -z "$g" ] && continue
      owns_rg "$g" || continue
      groups=$((groups + 1))
      [ "$state" = "Succeeded" ] || pending+=("$g ($state)")
      if res="$(azq resource list --resource-group "$g" --query "[].[name, type, provisioningState]" -o tsv)"; then
        # The state last: tab is whitespace to read, so an empty field in the middle would collapse.
        while IFS=$'\t' read -r name rtype rstate; do
          [ -z "$name" ] && continue
          [ -z "$rstate" ] && no_state_ok "${rtype:-}" && continue
          [ "$rstate" = "Succeeded" ] || pending+=("$name (${rstate:-no state})")
        done <<<"$res"
      else
        pending+=("$g (could not list its resources)")
      fi
    done <<<"$all"
  else
    pending+=("(could not list resource groups)")
  fi
  [ "$groups" -eq 0 ] && pending+=("$RG (does not exist)")

  if [ "${#pending[@]}" -eq 0 ]; then
    echo "ready check: every resource in $RG* is Succeeded (poll $polls)"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::ready check: not ready after ${LIMIT}s: ${pending[*]}"
    exit 1
  fi
  echo "ready check: waiting for ${#pending[@]} resource(s): ${pending[*]}"
  sleep "$INTERVAL"
done
