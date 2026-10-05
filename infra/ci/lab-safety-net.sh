#!/usr/bin/env bash
# infra/ci/lab-safety-net.sh <lab id>            lab.yml step 13, "Safety net"
# infra/ci/lab-safety-net.sh --verify <lab id>   lab.yml step 14, "Verify clean"
#
# Plain English: what gets a lab back to £0 when Terraform cannot (labs spec
# §5, §7.5). It never reads Terraform state: it works from Azure's and
# Entra's own lists, so it does the same job when the destroy failed, the
# state is missing or half-written, or the lab has left the catalogue (an
# orphan clean-up is just a destroy run). Everything it touches is named for
# this lab and nothing else:
#
#   resource groups        rg-lab-<id> and rg-lab-<id>-*   (never rg-lab-<id>x, NetworkWatcherRG, rg-wg-*)
#   soft-deleted vaults    Key Vaults whose id names one of those groups, purged after the
#                          group deletes (--verify lists one as "<name> (soft-deleted vault)")
#   Entra users            user principal name starting lab-<id>-  (deleted, then purged from the
#                          recycle bin so the next deploy can reuse the name)
#   Entra groups           display name starting lab-<id>-
#   custom roles           role name starting lab-<id>- (their assignments first), and each
#                          fixed GUID labs/setup/allowed-roles.json gives the lab, read
#                          directly (the subscription's list misses a role assignable
#                          only inside rg-lab-<id>)
#   policy                 assignments, then initiatives, then definitions named lab-<id>-, and
#                          everything assigned or defined inside a lab management group
#   management groups      id starting lab-<id>-, children before parents
#
# Sweep mode deletes and always exits 0 (the clean check is the verdict).
# Idempotent: a second sweep finds nothing. --verify lists the same things
# again and deletes nothing; it prints (and writes to $GITHUB_OUTPUT)
#
#   clean=true|false
#   leftovers=["rg-lab-...","lab-...-ann",...]     names only, never sign-in domains
#
# and exits 1 when anything is left, or when a list it needs could not be read
# ("unverified: ..."): not knowing is never "clean". LAB_ENTRA=false (from
# lab.yaml: the lab creates no users or groups) makes an unreadable Entra list
# a warning instead, so labs that never touch Entra do not need Graph rights.

set -uo pipefail

MODE=sweep
if [ "${1:-}" = "--verify" ]; then
  MODE=verify
  shift
fi
LAB_ID="${1:-}"
LAB_ID_RE='^az(104|305)-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$'
if ! [[ "$LAB_ID" =~ $LAB_ID_RE ]] || [ "${#LAB_ID}" -gt 40 ]; then
  echo "::error::lab-safety-net: refusing lab id '${LAB_ID}'"
  exit 2
fi
RG="rg-lab-$LAB_ID"
PREFIX="lab-$LAB_ID-"
GRAPH="https://graph.microsoft.com/v1.0"
WAIT_S="${LAB_DELETE_WAIT_SECONDS:-1500}"
ROLES_FILE="${LAB_ROLES_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/labs/setup/allowed-roles.json}"

warn() { echo "::warning::safety net: $*" >&2; }
azq() { az "$@" | tr -d '\r'; }
owns_rg() {
  local n="${1,,}"
  [[ "$n" == "$RG" || "$n" == "$RG"-* ]]
}
prefixed() {
  local n="${1,,}"
  [[ "$n" == "$PREFIX"* ]]
}
az_login() {
  [ -n "${ARM_CLIENT_ID:-}" ] || return 0
  AZURE_CONFIG_DIR="$(mktemp -d)"
  export AZURE_CONFIG_DIR
  trap 'rm -rf "$AZURE_CONFIG_DIR"' EXIT
  az login --service-principal -u "$ARM_CLIENT_ID" -p "$ARM_CLIENT_SECRET" --tenant "$ARM_TENANT_ID" -o none &&
    az account set --subscription "$ARM_SUBSCRIPTION_ID"
}

# ── Lists ────────────────────────────────────────────────────────────────
# Each fills ROWS (tab-separated fields) and, when Azure cannot answer, adds
# to UNVERIFIED. They run in this shell, never a subshell, so both survive.

UNVERIFIED=()
ROWS=()
OUT=""
# Run an az list into OUT; on failure note it (unless optional) and return 1.
fetch() {
  local what="$1" optional="$2"
  shift 2
  if OUT="$(azq "$@")"; then return 0; fi
  OUT=""
  if [ "$optional" = true ]; then
    warn "could not list $what (this lab makes none, so it does not count against clean)"
  else
    warn "could not list $what"
    UNVERIFIED+=("unverified: $what")
  fi
  return 1
}
entra_optional() { [ "${LAB_ENTRA:-true}" = false ] && echo true || echo false; }

list_groups() {
  ROWS=()
  local g
  fetch "resource groups" false group list --query "[].name" -o tsv || return 0
  while IFS= read -r g; do [ -n "$g" ] && owns_rg "$g" && ROWS+=("$g"); done <<<"$OUT"
}
# "id<TAB>display name"
list_users() {
  ROWS=()
  local id upn name
  fetch "Entra users" "$(entra_optional)" ad user list --filter "startswith(userPrincipalName,'$PREFIX')" --query "[].[id, userPrincipalName, displayName]" -o tsv || return 0
  while IFS=$'\t' read -r id upn name; do
    [ -n "$id" ] && prefixed "$upn" && ROWS+=("$id"$'\t'"${name:-user $id}")
  done <<<"$OUT"
}
# "id<TAB>display name"
list_entra_groups() {
  ROWS=()
  local id name
  fetch "Entra groups" "$(entra_optional)" ad group list --filter "startswith(displayName,'$PREFIX')" --query "[].[id, displayName]" -o tsv || return 0
  while IFS=$'\t' read -r id name; do
    [ -n "$id" ] && prefixed "$name" && ROWS+=("$id"$'\t'"$name")
  done <<<"$OUT"
}
# This lab's custom roles from labs/setup/allowed-roles.json ("guid<TAB>name"),
# one { "lab": ..., "name": ..., "id": ... } per line as the file keeps them.
fixed_roles() {
  local line re='"lab"[[:space:]]*:[[:space:]]*"([^"]+)".*"name"[[:space:]]*:[[:space:]]*"([^"]+)".*"id"[[:space:]]*:[[:space:]]*"([0-9A-Fa-f-]{36})"'
  if ! [ -r "$ROLES_FILE" ]; then
    warn "cannot read $ROLES_FILE"
    return 1
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ $re ]] && [ "${BASH_REMATCH[1]}" = "$LAB_ID" ] && printf '%s\t%s\n' "${BASH_REMATCH[3]}" "${BASH_REMATCH[2]}"
  done <"$ROLES_FILE"
  return 0
}
# One role definition by its GUID, straight from ARM: adds "guid<TAB>name<TAB>scope" to
# ROWS when it exists; nothing when ARM says it does not; "unverified" when ARM cannot say.
get_role() {
  local guid="$1" name="$2" out rc err g n s
  if [ -z "$SUB" ]; then
    UNVERIFIED+=("unverified: custom role $name")
    return 0
  fi
  err="$(mktemp)"
  out="$(az rest --method get --url "/subscriptions/$SUB/providers/Microsoft.Authorization/roleDefinitions/$guid?api-version=2022-04-01" \
    --query "[name, properties.roleName, properties.assignableScopes[0]]" -o tsv 2>"$err")"
  rc=$?
  out="${out//$'\r'/}"
  local e
  e="$(<"$err")"
  rm -f "$err"
  if [ "$rc" -ne 0 ]; then
    if [[ "$e" =~ RoleDefinitionDoesNotExist|NotFound|\(404\) ]]; then return 0; fi
    warn "could not read custom role $name ($guid)"
    UNVERIFIED+=("unverified: custom role $name")
    return 0
  fi
  IFS=$'\t' read -r g n s <<<"$out"
  [ -n "$g" ] && ROWS+=("$g"$'\t'"${n:-$name}"$'\t'"$s")
  return 0
}
# "guid<TAB>role name<TAB>first assignable scope". The subscription's list can miss a
# role assignable only inside rg-lab-<id> (lab 1's), so each fixed GUID the lab owns
# (allowed-roles.json) is also asked for directly.
list_roles() {
  ROWS=()
  local guid name scope seen=" " fixed
  if fetch "custom roles" false role definition list --custom-role-only true --query "[].[name, roleName, assignableScopes[0]]" -o tsv; then
    while IFS=$'\t' read -r guid name scope; do
      if [ -n "$guid" ] && prefixed "$name"; then
        ROWS+=("$guid"$'\t'"$name"$'\t'"$scope")
        seen+="${guid,,} "
      fi
    done <<<"$OUT"
  fi
  if ! fixed="$(fixed_roles)"; then
    UNVERIFIED+=("unverified: the lab's custom roles (allowed-roles.json)")
    return 0
  fi
  while IFS=$'\t' read -r guid name; do
    [ -z "$guid" ] && continue
    [[ "$seen" == *" ${guid,,} "* ]] && continue
    get_role "$guid" "$name"
  done <<<"$fixed"
}
# "name<TAB>location": soft-deleted Key Vaults that lived in one of the lab's groups
# (spec §17 ruling 30: Key Vault keeps a deleted vault for its retention, 7 days in the labs).
list_deleted_vaults() {
  ROWS=()
  # Azure spells the id's segments in either case (/resourcegroups/, upper-case group names): matched in lower case.
  local name loc id rg re='/resourcegroups/([^/]+)/'
  fetch "soft-deleted Key Vaults" false keyvault list-deleted --resource-type vault --query "[].[name, properties.location, properties.vaultId]" -o tsv || return 0
  while IFS=$'\t' read -r name loc id; do
    [ -n "$name" ] || continue
    [[ "${id,,}" =~ $re ]] || continue
    rg="${BASH_REMATCH[1]}"
    owns_rg "$rg" && ROWS+=("$name"$'\t'"$loc")
  done <<<"$OUT"
}
# "name"
list_mgs() {
  ROWS=()
  local name display err
  # wg-admin's identity owns every management group it creates, so when Azure refuses
  # the list outright (AuthorizationFailed: e.g. a tenant that has never used management
  # groups) none of the lab's can exist. Any other failure stays "unverified".
  err="$(mktemp)"
  if OUT="$(az account management-group list --query "[].[name, displayName]" -o tsv 2>"$err" | tr -d '\r')" && [ "${PIPESTATUS[0]}" -eq 0 ]; then
    rm -f "$err"
  elif grep -q "AuthorizationFailed" "$err"; then
    rm -f "$err"
    echo "safety net: no management groups visible to wg-admin's identity, so none of the lab's exist"
    return 0
  else
    cat "$err" >&2
    rm -f "$err"
    OUT=""
    warn "could not list management groups"
    UNVERIFIED+=("unverified: management groups")
    return 0
  fi
  while IFS=$'\t' read -r name display; do
    [ -n "$name" ] && prefixed "$name" && ROWS+=("$name")
  done <<<"$OUT"
}
# "name<TAB>scope": everything assigned at a lab management group, plus lab-named assignments anywhere.
list_assignments() {
  ROWS=()
  local mg id name display scope
  for mg in "$@"; do
    scope="/providers/Microsoft.Management/managementGroups/$mg"
    fetch "policy assignments at $mg" false policy assignment list --scope "$scope" --query "[].id" -o tsv || continue
    while IFS= read -r id; do
      [ -n "$id" ] && [ "${id%/providers/Microsoft.Authorization/policyAssignments/*}" = "$scope" ] && ROWS+=("${id##*/}"$'\t'"$scope")
    done <<<"$OUT"
  done
  fetch "policy assignments" false policy assignment list --disable-scope-strict-match --query "[].[id, name, displayName]" -o tsv || return 0
  while IFS=$'\t' read -r id name display; do
    [ -z "$id" ] && continue
    if prefixed "$name" || prefixed "$display"; then ROWS+=("$name"$'\t'"${id%/providers/Microsoft.Authorization/policyAssignments/*}"); fi
  done <<<"$OUT"
}
# "name<TAB>management group (or empty)". $1: definition | set-definition; then the lab's management groups.
list_definitions() {
  ROWS=()
  local kind="$1" mg name display
  shift
  if fetch "policy ${kind}s" false policy "$kind" list --query "[?policyType=='Custom'].[name, displayName]" -o tsv; then
    while IFS=$'\t' read -r name display; do
      [ -n "$name" ] && prefixed "$name" && ROWS+=("$name"$'\t')
    done <<<"$OUT"
  fi
  for mg in "$@"; do
    fetch "policy ${kind}s at $mg" false policy "$kind" list --management-group "$mg" --query "[?policyType=='Custom'].[name, displayName]" -o tsv || continue
    # Everything defined inside a lab management group is the lab's.
    while IFS=$'\t' read -r name display; do
      [ -n "$name" ] && ROWS+=("$name"$'\t'"$mg")
    done <<<"$OUT"
  done
}

if ! az_login; then
  warn "could not sign in to Azure"
  UNVERIFIED+=("unverified: could not sign in to Azure")
fi
SUB="${ARM_SUBSCRIPTION_ID:-}"
[ -n "$SUB" ] || SUB="$(azq account show --query id -o tsv)" || SUB=""

# ── Verify ───────────────────────────────────────────────────────────────

if [ "$MODE" = verify ]; then
  left=()
  first() { local r; for r in "${ROWS[@]}"; do left+=("${r%%$'\t'*}"); done; }
  second() { local r x; for r in "${ROWS[@]}"; do x="${r#*$'\t'}"; left+=("${x%%$'\t'*}"); done; }
  list_groups; first
  list_deleted_vaults
  for r in "${ROWS[@]}"; do left+=("${r%%$'\t'*} (soft-deleted vault)"); done
  list_users; second
  list_entra_groups; second
  list_roles; second
  list_mgs; mgs=("${ROWS[@]}"); first
  list_assignments "${mgs[@]}"; first
  list_definitions set-definition "${mgs[@]}"; first
  list_definitions definition "${mgs[@]}"; first
  left+=("${UNVERIFIED[@]}")

  json="["
  sep=""
  for n in "${left[@]}"; do
    n="${n//\\/\\\\}"
    n="${n//\"/\\\"}"
    json+="$sep\"$n\""
    sep=","
  done
  json+="]"
  if [ "${#left[@]}" -eq 0 ]; then clean=true; else clean=false; fi
  echo "clean=$clean"
  echo "leftovers=$json"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    { echo "clean=$clean"; echo "leftovers=$json"; } >>"$GITHUB_OUTPUT"
  fi
  if [ "$clean" = true ]; then
    echo "verify: Azure and Entra hold nothing of $LAB_ID"
    exit 0
  fi
  echo "::error::verify: $LAB_ID is not clean: ${left[*]}"
  exit 1
fi

# ── Sweep ────────────────────────────────────────────────────────────────

# 1. Resource groups: start every delete, then poll their state. A group that
# goes back to Succeeded (or Failed) was not deleted: Azure refused part of it
# (a lock, a vault still holding backups). Unblock runs again and the delete is
# issued again, at most LAB_DELETE_RETRIES times. The polling stops in time for
# the rest of the job: by LAB_JOB_DEADLINE (Parse payload: the job's start plus
# its timeout) less DEADLINE_RESERVE_S for this sweep's other steps, Verify
# clean, Back up state and the report, or LAB_DELETE_WAIT_SECONDS when there is
# no deadline. A group still there then is left behind: a warning here, and
# Verify clean names it.
start_delete() {
  if az group delete --name "$1" --yes --no-wait; then echo "safety net: deleting $1"; else warn "could not start deleting $1"; fi
}
num() { [[ "${1:-}" =~ ^[0-9]+$ ]] && echo "$1" || echo "$2"; }
POLL_S="$(num "${LAB_DELETE_POLL_SECONDS:-}" 30)"
[ "$POLL_S" -ge 1 ] || POLL_S=1
RETRIES="$(num "${LAB_DELETE_RETRIES:-}" 2)"
DEADLINE_RESERVE_S=420
UNBLOCK="${LAB_UNBLOCK_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/lab-unblock.sh}"
WAIT_S="$(num "$WAIT_S" 1500)"
budget="$WAIT_S"
if [[ "${LAB_JOB_DEADLINE:-}" =~ ^[0-9]+$ ]]; then
  left_s=$((LAB_JOB_DEADLINE - DEADLINE_RESERVE_S - $(date +%s)))
  [ "$left_s" -lt 0 ] && left_s=0
  [ "$left_s" -lt "$budget" ] && budget="$left_s"
fi
end=$(($(date +%s) + budget))
polls=$((budget / POLL_S))

list_groups
groups=("${ROWS[@]}")
declare -A tries=()
pending=()
for g in "${groups[@]}"; do
  start_delete "$g"
  tries["$g"]=0
  pending+=("$g")
done
[ "${#pending[@]}" -gt 0 ] && echo "safety net: waiting up to ${budget}s for ${pending[*]} (polling every ${POLL_S}s, up to $RETRIES retries each)"
for ((n = 0; ${#pending[@]} > 0 && n < polls; n++)); do
  sleep "$POLL_S"
  if ! states="$(azq group list --query "[].[name, properties.provisioningState]" -o tsv)"; then
    warn "could not list resource groups to see how the deletes are going; trying again"
    continue
  fi
  declare -A state=()
  while IFS=$'\t' read -r name st; do [ -n "$name" ] && state["${name,,}"]="${st:-unknown}"; done <<<"$states"
  still=()
  failed=()
  for g in "${pending[@]}"; do
    st="${state[${g,,}]:-}"
    if [ -z "$st" ]; then
      echo "safety net: $g is gone"
    elif [ "$st" = Deleting ] || [ "$st" = unknown ]; then
      still+=("$g")
    elif [ "${tries[$g]}" -lt "$RETRIES" ]; then
      failed+=("$g")
    else
      warn "$g: the delete failed $((RETRIES + 1)) times (state $st); left behind"
    fi
  done
  unset state
  if [ "${#failed[@]}" -gt 0 ]; then
    warn "the delete of ${failed[*]} failed (the group is back, not Deleting); unblocking again and retrying"
    if [ -r "$UNBLOCK" ]; then
      wait_left=$(((end - $(date +%s)) / 3))
      [ "$wait_left" -lt 0 ] && wait_left=0
      vault_wait="$(num "${LAB_UNBLOCK_VAULT_WAIT_SECONDS:-}" 300)"
      [ "$wait_left" -lt "$vault_wait" ] && vault_wait="$wait_left"
      LAB_UNBLOCK_VAULT_WAIT_SECONDS="$vault_wait" bash "$UNBLOCK" "$LAB_ID" || warn "unblock did not finish cleanly"
    fi
    for g in "${failed[@]}"; do
      tries["$g"]=$((tries[$g] + 1))
      echo "safety net: retrying the delete of $g (${tries[$g]} of $RETRIES)"
      start_delete "$g"
      still+=("$g")
    done
  fi
  pending=("${still[@]}")
  [ "$(date +%s)" -ge "$end" ] && break
done
for g in "${pending[@]}"; do warn "$g was not gone within ${budget}s (the job's time is nearly up); left behind"; done

# 1b. Key Vaults the group deletes soft-deleted (or a destroy that did not purge):
# purged, so nothing of the lab is kept for the retention period and the next
# session can reuse the name. Only vaults whose id names one of the lab's groups.
list_deleted_vaults
for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r name loc <<<"$row"
  if az keyvault purge --name "$name" --location "$loc"; then echo "safety net: purged soft-deleted vault $name"; else warn "could not purge soft-deleted vault $name"; fi
done

# Purge a deleted Entra object from the recycle bin (it takes a moment to arrive there).
purge() {
  local id="$1" i
  for i in 1 2 3; do
    az rest --method delete --url "$GRAPH/directory/deletedItems/$id" -o none 2>/dev/null && return 0
    sleep 5
  done
  return 1
}

# 2. Entra users and groups.
list_users
for row in "${ROWS[@]}"; do
  id="${row%%$'\t'*}"
  name="${row#*$'\t'}"
  if az ad user delete --id "$id"; then
    echo "safety net: deleted user $name"
    purge "$id" || warn "user $name is deleted but still in the recycle bin"
  else warn "could not delete user $name"; fi
done
list_entra_groups
for row in "${ROWS[@]}"; do
  id="${row%%$'\t'*}"
  name="${row#*$'\t'}"
  if az ad group delete --group "$id"; then
    echo "safety net: deleted group $name"
    purge "$id" || true # security groups are not kept in the recycle bin
  else warn "could not delete group $name"; fi
done

# 3. Custom roles: their assignments first.
list_roles
for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r guid name scope <<<"$row"
  while IFS= read -r ra; do
    [ -n "$ra" ] && { az role assignment delete --ids "$ra" || warn "could not delete an assignment of $name"; }
  done < <(azq role assignment list --all --role "$guid" --query "[].id" -o tsv)
  if az role definition delete --name "$guid" --scope "/subscriptions/$SUB" || { [ -n "$scope" ] && az role definition delete --name "$guid" --scope "$scope"; }; then
    echo "safety net: deleted custom role $name"
  else warn "could not delete custom role $name"; fi
done

# 4. Policy: assignments, then initiatives, then definitions.
list_mgs
mgs=("${ROWS[@]}")
list_assignments "${mgs[@]}"
for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r name scope <<<"$row"
  if az policy assignment delete --name "$name" --scope "$scope"; then echo "safety net: deleted policy assignment $name"; else warn "could not delete policy assignment $name"; fi
done
for kind in set-definition definition; do
  list_definitions "$kind" "${mgs[@]}"
  for row in "${ROWS[@]}"; do
    name="${row%%$'\t'*}"
    mg="${row#*$'\t'}"
    if [ -n "$mg" ]; then
      az policy "$kind" delete --name "$name" --management-group "$mg" || warn "could not delete policy $kind $name"
    else
      az policy "$kind" delete --name "$name" || warn "could not delete policy $kind $name"
    fi
  done
done

# 5. Management groups, deepest first (a group must be empty to delete).
declare -A parent=()
for m in "${mgs[@]}"; do
  parent["$m"]="$(azq account management-group show --name "$m" --query "details.parent.name" -o tsv)"
done
depth() {
  local m="$1" d=0
  while [ -n "${parent[$m]:-}" ] && [ -n "${parent[${parent[$m]}]+x}" ] && [ "$d" -lt 20 ]; do
    m="${parent[$m]}"
    d=$((d + 1))
  done
  echo "$d"
}
ordered=()
for m in "${mgs[@]}"; do ordered+=("$(depth "$m")"$'\t'"$m"); done
while IFS=$'\t' read -r _ m; do
  [ -z "$m" ] && continue
  if az account management-group delete --name "$m"; then echo "safety net: deleted management group $m"; else warn "could not delete management group $m (a subscription inside it must be moved out by hand)"; fi
done < <(printf '%s\n' "${ordered[@]}" | sort -t$'\t' -k1,1nr -k2,2)

echo "safety net: done for $LAB_ID"
exit 0
