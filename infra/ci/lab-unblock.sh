#!/usr/bin/env bash
# infra/ci/lab-unblock.sh <lab id>
#
# Plain English: lab.yml step 11, "Unblock" (labs spec §5). Before a lab is
# destroyed, remove what would stop Azure deleting its resource groups, in
# this order, across every rg-lab-<id> and rg-lab-<id>-* group:
#
#   1. resource locks (CanNotDelete / ReadOnly), on the groups and inside them
#   2. legal holds on blob containers
#   3. UNLOCKED immutability policies on blob containers (a Locked one cannot
#      be removed by anyone; the scope check refuses them before apply, and
#      one found here is reported loudly)
#   3b. Azure Files share snapshots (a share with snapshots cannot be deleted,
#      so Terraform's destroy of it fails; lab 7)
#   4. backup protection, per Recovery Services vault: an Unlocked vault
#      immutability turned Disabled (a Locked one is a loud warning), soft
#      delete off, soft-deleted items undeleted, protection stopped with the
#      backup data deleted for items of every management type, then a wait
#      until the vault lists no items (LAB_UNBLOCK_VAULT_WAIT_SECONDS, default
#      300, polled every 15 s; a list that fails is never "none left": if
#      the last one fails, the vault's items are "unverified", a warning)
#   5. Site Recovery replication: protection disabled on every replicated item
#
# Never fails the run: every refusal is a ::warning:: and the destroy, the
# safety net and the clean check still run after it. Idempotent: a second run
# finds nothing to do. Only the lab's own groups are ever listed into.
#
# Signs in with ARM_* when they are set (in a private, throw-away az profile,
# so no later step inherits the login); otherwise uses the az already signed in.

set -uo pipefail

LAB_ID="${1:-}"
LAB_ID_RE='^az(104|305)-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$'
if ! [[ "$LAB_ID" =~ $LAB_ID_RE ]] || [ "${#LAB_ID}" -gt 40 ]; then
  echo "::error::lab-unblock: refusing lab id '${LAB_ID}'"
  exit 2
fi
RG="rg-lab-$LAB_ID"

warn() { echo "::warning::unblock: $*" >&2; }
# az's tsv, without Windows line ends; az's own exit status is kept (pipefail).
azq() { az "$@" | tr -d '\r'; }
owns_rg() {
  local n="${1,,}"
  [[ "$n" == "$RG" || "$n" == "$RG"-* ]]
}
az_login() {
  [ -n "${ARM_CLIENT_ID:-}" ] || return 0
  AZURE_CONFIG_DIR="$(mktemp -d)"
  export AZURE_CONFIG_DIR
  trap 'rm -rf "$AZURE_CONFIG_DIR"' EXIT
  az login --service-principal -u "$ARM_CLIENT_ID" -p "$ARM_CLIENT_SECRET" --tenant "$ARM_TENANT_ID" -o none &&
    az account set --subscription "$ARM_SUBSCRIPTION_ID"
}

az_login || { warn "could not sign in to Azure; nothing unblocked"; exit 0; }

if ! all_groups="$(azq group list --query "[].name" -o tsv)"; then
  warn "could not list resource groups; nothing unblocked"
  exit 0
fi
groups=()
while IFS= read -r g; do
  [ -n "$g" ] && owns_rg "$g" && groups+=("$g")
done <<<"$all_groups"
if [ "${#groups[@]}" -eq 0 ]; then
  echo "unblock: no $RG groups exist; nothing to unblock"
  exit 0
fi
echo "unblock: ${groups[*]}"

# 1. Locks
for g in "${groups[@]}"; do
  while IFS= read -r lock; do
    [ -z "$lock" ] && continue
    if az lock delete --ids "$lock" -o none; then echo "unblock: $g: removed lock ${lock##*/}"; else warn "$g: could not remove lock ${lock##*/}"; fi
  done < <(azq lock list --resource-group "$g" --query "[].id" -o tsv || warn "$g: could not list locks")
done

# Storage accounts, read once for steps 2 and 3.
declare -A accounts=()
for g in "${groups[@]}"; do
  accounts["$g"]="$(azq storage account list --resource-group "$g" --query "[].name" -o tsv || warn "$g: could not list storage accounts")"
done

# 2. Legal holds
for g in "${groups[@]}"; do
  while IFS= read -r sa; do
    [ -z "$sa" ] && continue
    while IFS= read -r c; do
      [ -z "$c" ] && continue
      mapfile -t tags < <(azq storage container legal-hold show --account-name "$sa" --container-name "$c" --resource-group "$g" --query "tags[].tag" -o tsv)
      [ "${#tags[@]}" -eq 0 ] && continue
      if az storage container legal-hold clear --account-name "$sa" --container-name "$c" --resource-group "$g" --tags "${tags[@]}" -o none; then
        echo "unblock: $sa/$c: legal hold cleared"
      else warn "$sa/$c: could not clear the legal hold"; fi
    done < <(azq storage container-rm list --storage-account "$sa" --resource-group "$g" --query "[?hasLegalHold || properties.hasLegalHold].name" -o tsv)
  done <<<"${accounts[$g]}"
done

# 3. Unlocked immutability policies
for g in "${groups[@]}"; do
  while IFS= read -r sa; do
    [ -z "$sa" ] && continue
    while IFS= read -r c; do
      [ -z "$c" ] && continue
      read -r state etag < <(azq storage container immutability-policy show --account-name "$sa" --container-name "$c" --resource-group "$g" --query "[state, etag]" -o tsv)
      if [ "${state:-}" = "Locked" ]; then
        warn "$sa/$c: immutability policy is Locked; nobody can remove it until it expires, so this group cannot be deleted yet"
      elif [ -n "${etag:-}" ]; then
        if az storage container immutability-policy delete --account-name "$sa" --container-name "$c" --resource-group "$g" --if-match "$etag" -o none; then
          echo "unblock: $sa/$c: unlocked immutability policy removed"
        else warn "$sa/$c: could not remove the immutability policy"; fi
      fi
    done < <(azq storage container-rm list --storage-account "$sa" --resource-group "$g" --query "[?hasImmutabilityPolicy || properties.hasImmutabilityPolicy].name" -o tsv)
  done <<<"${accounts[$g]}"
done

# 3b. Azure Files share snapshots (lab 7): a share that has snapshots cannot be
# deleted, so terraform destroy of the share would fail. The shares themselves
# are left for Terraform (and the group delete).
for g in "${groups[@]}"; do
  while IFS= read -r sa; do
    [ -z "$sa" ] && continue
    while IFS=$'\t' read -r share snap; do
      [ -z "$share" ] || [ -z "$snap" ] && continue
      if az storage share-rm delete --storage-account "$sa" --resource-group "$g" --name "$share" --snapshot "$snap" --yes -o none; then
        echo "unblock: $sa/$share: snapshot $snap deleted"
      else warn "$sa/$share: could not delete snapshot $snap"; fi
    done < <(azq storage share-rm list --storage-account "$sa" --resource-group "$g" --include-snapshot \
      --query "[?snapshotTime || properties.snapshotTime].[name, snapshotTime || properties.snapshotTime]" -o tsv || warn "$sa: could not list file share snapshots")
  done <<<"${accounts[$g]}"
done

# Recovery Services vaults, read once for steps 4 and 5.
declare -A vaults=()
for g in "${groups[@]}"; do
  vaults["$g"]="$(azq backup vault list --resource-group "$g" --query "[].name" -o tsv || warn "$g: could not list Recovery Services vaults")"
done

# 4. Backup protection. Immutability first: an Unlocked vault's is turned
# Disabled (a Locked one cannot be, by anyone, until its data expires: said
# loudly). Then soft delete off, soft-deleted items undeleted, protection
# stopped with the data deleted for items of every management type (`az
# backup item list` without --backup-management-type lists them all), and a
# bounded wait until the vault lists no items, so the group delete is not
# refused for a vault still deleting its backups.
UNVERIFIED=()
VAULT_WAIT="${LAB_UNBLOCK_VAULT_WAIT_SECONDS:-300}"
[[ "$VAULT_WAIT" =~ ^[0-9]+$ ]] || VAULT_WAIT=300
for g in "${groups[@]}"; do
  while IFS= read -r v; do
    [ -z "$v" ] && continue
    immutability="$(azq backup vault show --name "$v" --resource-group "$g" --query properties.securitySettings.immutabilitySettings.state -o tsv || warn "$v: could not read its immutability")"
    case "${immutability:-}" in
      Unlocked)
        if az backup vault update --name "$v" --resource-group "$g" --immutability-state Disabled -o none; then
          echo "unblock: $v: unlocked immutability turned off"
        else warn "$v: could not turn its unlocked immutability off"; fi
        ;;
      Locked)
        warn "$v: immutability is LOCKED; nobody can turn it off or delete its backup data until it expires, so this vault and its group cannot be deleted yet (and keep costing)"
        ;;
    esac
    az backup vault backup-properties set --name "$v" --resource-group "$g" --soft-delete-feature-state Disable -o none ||
      warn "$v: could not turn soft delete off"
    while IFS= read -r item; do
      [ -z "$item" ] && continue
      az backup protection undelete --ids "$item" -o none || warn "$v: could not undelete a soft-deleted item"
    done < <(azq backup item list --vault-name "$v" --resource-group "$g" --query "[?properties.isScheduledForDeferredDelete].id" -o tsv)
    while IFS=$'\t' read -r item bmt wt; do
      [ -z "$item" ] && continue
      typed=()
      case "${bmt:-}" in
        "") ;;
        AzureIaasVM | AzureStorage | AzureWorkload)
          typed=(--backup-management-type "$bmt")
          [ -n "${wt:-}" ] && typed+=(--workload-type "$wt")
          ;;
        *)
          warn "$v: ${item##*/} is a $bmt item, which the CLI cannot stop; stop it in the portal or the agent"
          continue
          ;;
      esac
      if az backup protection disable --ids "$item" --delete-backup-data true --yes "${typed[@]}" -o none; then
        echo "unblock: $v: protection stopped and backup data deleted for ${item##*/}"
      else warn "$v: could not stop protection for ${item##*/}"; fi
    done < <(azq backup item list --vault-name "$v" --resource-group "$g" --query "[].[id, properties.backupManagementType, properties.workloadType]" -o tsv)
    # Wait (bounded) until the vault lists no items. A list that fails says nothing
    # about the items: it is never "none left", and if the last try fails too the
    # vault is unverified (a warning; the run still goes on).
    tries=$(((VAULT_WAIT + 14) / 15))
    for ((n = 0; ; n++)); do
      if left="$(azq backup item list --vault-name "$v" --resource-group "$g" --query "[].id" -o tsv)"; then
        listed=true
        if [ -z "$left" ]; then
          echo "unblock: $v: no backup items left"
          break
        fi
      else
        listed=false
        warn "$v: could not list backup items, so whether any are left is not known"
      fi
      if [ "$n" -ge "$tries" ]; then
        if [ "$listed" = true ]; then
          warn "$v: $(grep -c . <<<"$left") backup item(s) still listed after $VAULT_WAIT s; the destroy goes ahead and the safety net tries again"
        else
          UNVERIFIED+=("$v backup items")
        fi
        break
      fi
      sleep 15
    done
  done <<<"${vaults[$g]}"
done

# 5. Site Recovery replication
for g in "${groups[@]}"; do
  while IFS= read -r v; do
    [ -z "$v" ] && continue
    while IFS= read -r item; do
      [ -z "$item" ] && continue
      if az rest --method post --url "${item}/remove?api-version=2023-08-01" --body '{"properties":{"disableProtectionReason":"NotSpecified"}}' -o none; then
        echo "unblock: $v: replication disabled for ${item##*/}"
      else warn "$v: could not disable replication for ${item##*/}"; fi
    done < <(azq rest --method get --url "/subscriptions/{subscriptionId}/resourceGroups/$g/providers/Microsoft.RecoveryServices/vaults/$v/replicationProtectedItems?api-version=2023-08-01" --query "value[].id" -o tsv)
  done <<<"${vaults[$g]}"
done

if [ "${#UNVERIFIED[@]}" -gt 0 ]; then
  warn "unverified: ${UNVERIFIED[*]} (Azure could not list them); the destroy goes ahead, and the safety net and Verify clean decide"
fi
echo "unblock: done"
exit 0
