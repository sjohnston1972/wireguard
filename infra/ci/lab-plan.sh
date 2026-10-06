#!/usr/bin/env bash
# infra/ci/lab-plan.sh
#
# Plain English: plan the lab and show the plan to the scope check (lab.yml's
# "Plan and scope check", and again before a retried apply, lab-tf-run.sh):
#
#   bash infra/ci/lab-plan.sh            the first plan: also prints its LAB_PLAN_SHAPE line
#   bash infra/ci/lab-plan.sh --retry    a fresh plan after a dropped connection: no shape line
#
# Writes $RUNNER_TEMP/plan.out (what apply applies) and plan.json, then runs
# infra/ci/lab-scope.mjs on it: anything outside rg-lab-<id> fails this
# script, so nothing unchecked is ever applied. The shape is the release
# test's record of the lab's real plan (ruling 35); a retry's plan holds only
# what is left to build, so it is never recorded.

set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
retry=false
[ "${1:-}" = --retry ] && retry=true

cd "$GITHUB_WORKSPACE/labs/$LAB_ID/terraform"
# Only a private DNS zone link may name the gateway VNet, and only through this.
if [ "$LAB_PEERING" = true ]; then
  export TF_VAR_gateway_vnet_id="/subscriptions/$ARM_SUBSCRIPTION_ID/resourceGroups/${RG:-rg-wg-ondemand}/providers/Microsoft.Network/virtualNetworks/vnet-wg"
fi
terraform plan -no-color -input=false -out="$RUNNER_TEMP/plan.out"
# The JSON holds sensitive values in the clear: it stays on the runner and is never printed.
terraform show -no-color -json "$RUNNER_TEMP/plan.out" > "$RUNNER_TEMP/plan.json"
# The plan's shape (addresses, references, unknown and sensitive paths; never a value), one
# LAB_PLAN_SHAPE line the release test saves to check the lab's plan fixture against (ruling 35).
if [ "$retry" = false ]; then
  node "$here/lab-plan-shape.mjs" "$RUNNER_TEMP/plan.json" || echo "::warning::could not record the plan's shape"
fi
node "$here/lab-scope.mjs" --plan "$RUNNER_TEMP/plan.json" --lab "$LAB_ID"
echo "scope check passed: every resource in the plan stays inside the lab"
