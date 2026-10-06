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
#      delete off and read back (AlwaysON, or not Disabled when read back, is
#      "unverified": lab 19's vault is made with it on, as azurerm insists),
#      soft-deleted items undeleted, protection stopped with the
#      backup data deleted for items of every management type, then a wait
#      until the vault lists no items (LAB_UNBLOCK_VAULT_WAIT_SECONDS, default
#      300, polled every 15 s; a list that fails is never "none left": if
#      the last one fails, the vault's items are "unverified", a warning)
#   5. Site Recovery, per vault: recovery plans deleted (a learner may make
#      one; an item in a plan cannot be unprotected), a test failover still
#      to clean up is cleaned up and the item polled until the (asynchronous)
#      cleanup is done (LAB_UNBLOCK_ASR_CLEANUP_WAIT_SECONDS, default 600),
#      replication is removed from every item, then a wait until the vault
#      lists none (LAB_UNBLOCK_ASR_WAIT_SECONDS, default 900, every 15 s; a
#      list that fails is "unverified"; remove is sent again, bounded, for an
#      item still listed and not already being removed), then its network mappings, container
#      mappings and replication policies are removed (lab 26)
#   6. SQL: failover groups deleted on the server holding the primary, then
#      each primary database's geo-replication links (lab 23; after a
#      failover the primary is in the secondary group)
#
# Never fails the run: every refusal is a ::warning:: and the destroy, the
# safety net and the clean check still run after it. Idempotent: a second run
# finds nothing to do. Only the lab's own groups are ever listed into.
#
# Signs in with ARM_* when they are set (in a private, throw-away az profile,
# so no later step inherits the login); otherwise uses the az already signed in.

set -uo pipefail

LAB_ID="${1:-}"
LAB_ID_RE='^az(104|305|700)-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$'
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
# A vault's soft delete state: Enabled, Disabled or AlwaysON (empty if unreadable).
soft_state() { azq backup vault backup-properties show --name "$1" --resource-group "$2" --query "[].properties.softDeleteFeatureState | [0]" -o tsv; }
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
    # Soft delete: read it, turn it off unless it is already off, and read it back.
    # `backup-properties show` answers [storage config, vault config]; the vault
    # config holds softDeleteFeatureState (Enabled, Disabled or AlwaysON). AlwaysON
    # cannot be turned off by anyone (az only warns and changes nothing), so it is
    # never asked for: deleted backup data then stays soft-deleted for 14 days and
    # the vault cannot go. Anything not read back as Disabled is unverified.
    soft="$(soft_state "$v" "$g" || warn "$v: could not read its soft delete state")"
    case "${soft,,}" in
      disabled) ;;
      alwayson)
        warn "$v: soft delete is ALWAYS ON; nobody can turn it off, so its deleted backup data stays for 14 days and this vault and its group cannot be deleted until then"
        UNVERIFIED+=("$v soft delete (always on)")
        ;;
      *)
        if ! az backup vault backup-properties set --name "$v" --resource-group "$g" --soft-delete-feature-state Disable -o none; then
          warn "$v: could not turn soft delete off"
        fi
        soft="$(soft_state "$v" "$g" || true)"
        if [ "${soft,,}" = disabled ]; then
          echo "unblock: $v: soft delete turned off"
        else
          warn "$v: soft delete is ${soft:-not readable} after turning it off, so deleted backup data may be kept for 14 days"
          UNVERIFIED+=("$v soft delete")
        fi
        ;;
    esac
    # Items already soft-deleted (protection stopped while soft delete was on) are
    # brought back first, so the loop below can delete their backup data for good.
    while IFS=$'\t' read -r item bmt wt; do
      [ -z "$item" ] && continue
      typed=()
      case "${bmt:-}" in
        AzureIaasVM | AzureStorage | AzureWorkload)
          typed=(--backup-management-type "$bmt")
          [ -n "${wt:-}" ] && typed+=(--workload-type "$wt")
          ;;
      esac
      if az backup protection undelete --ids "$item" "${typed[@]}" -o none; then
        echo "unblock: $v: soft-deleted item ${item##*/} undeleted"
      else warn "$v: could not undelete the soft-deleted item ${item##*/}"; fi
    done < <(azq backup item list --vault-name "$v" --resource-group "$g" --query "[?properties.isScheduledForDeferredDelete].[id, properties.backupManagementType, properties.workloadType]" -o tsv)
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

# 5. Site Recovery (lab 26; spec §17 ruling 31), per vault: recovery plans are deleted
# first (an item in a plan cannot be unprotected), then a test failover still to
# clean up is cleaned up (its VM and NIC sit in the test network) and waited for
# (the cleanup is a 202: Azure refuses a remove while it still runs), then
# replication is removed from every item, and a bounded wait (every 15 s, at most
# LAB_UNBLOCK_ASR_WAIT_SECONDS, default 900) runs until the vault lists none; a
# list that fails is never "none left". Then the network mappings, container
# mappings and replication policies go (the vault itself needs only the items
# gone; the rest is tidied so nothing is left half-made). All az rest, api-version
# 2023-08-01; every refusal is a warning.
ASR_API="api-version=2023-08-01"
ASR_WAIT="${LAB_UNBLOCK_ASR_WAIT_SECONDS:-900}"
[[ "$ASR_WAIT" =~ ^[0-9]+$ ]] || ASR_WAIT=900
ASR_CLEANUP_WAIT="${LAB_UNBLOCK_ASR_CLEANUP_WAIT_SECONDS:-600}"
[[ "$ASR_CLEANUP_WAIT" =~ ^[0-9]+$ ]] || ASR_CLEANUP_WAIT=600
ASR_RESEND_EVERY=4 # polls (a minute) between re-sends of remove
ASR_RESENDS=8      # re-sends per item at most
asr_list() { azq rest --method get --url "/subscriptions/{subscriptionId}/resourceGroups/$1/providers/Microsoft.RecoveryServices/vaults/$2/$3?$ASR_API" --query "${4:-value[].id}" -o tsv; }
# asr_remove <vault> <item id> [note]: post remove (disable replication); a refusal is a warning.
asr_remove() {
  if az rest --method post --url "${2}/remove?$ASR_API" --body '{"properties":{"disableProtectionReason":"NotSpecified"}}' -o none; then
    echo "unblock: $1: replication disabled for ${2##*/}${3:-}"
  else warn "$1: could not disable replication for ${2##*/}${3:-}"; fi
}
# asr_being_removed <scenario name> <protection state>: true when Azure is already removing the item.
asr_being_removed() {
  local s="${1,,} ${2,,}"
  [[ "$s" == *disabl* || "$s" == *delet* || "$s" == *remov* ]]
}
# asr_cleanup_wait <vault> <item id>: testFailoverCleanup is asynchronous (202) and az rest does
# not wait, so poll the item (every 15 s, at most ASR_CLEANUP_WAIT) until its test failover state
# is None, empty or MarkedForDeletion. A read that fails is not "finished"; a wait that runs out
# is a warning (remove is still sent, and the vault wait sends it again).
asr_cleanup_wait() {
  local tries=$(((ASR_CLEANUP_WAIT + 14) / 15)) n state
  for ((n = 0; ; n++)); do
    if state="$(azq rest --method get --url "${2}?$ASR_API" --query properties.testFailoverState -o tsv)"; then
      case "${state:-None}" in
        None | MarkedForDeletion)
          echo "unblock: $1: ${2##*/}: test failover cleanup finished"
          return 0
          ;;
      esac
    fi
    if [ "$n" -ge "$tries" ]; then
      warn "$1: the test failover cleanup of ${2##*/} had not finished after $ASR_CLEANUP_WAIT s; replication removal is tried anyway"
      return 0
    fi
    sleep 15
  done
}
for g in "${groups[@]}"; do
  while IFS= read -r v; do
    [ -z "$v" ] && continue
    # Recovery plans first (a learner may make one by hand): an item in a plan cannot have its
    # replication removed, and a vault holding a plan cannot be deleted.
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      if az rest --method delete --url "${p}?$ASR_API" -o none; then echo "unblock: $v: recovery plan ${p##*/} deleted"; else warn "$v: could not delete recovery plan ${p##*/}"; fi
    done < <(asr_list "$g" "$v" replicationRecoveryPlans || warn "$v: could not list recovery plans")
    items="$(asr_list "$g" "$v" replicationProtectedItems "value[].[id, properties.testFailoverState]")" || { warn "$v: could not list replicated items"; items=""; }
    [ -z "$items" ] && continue
    while IFS=$'\t' read -r item tfo; do
      [ -z "$item" ] && continue
      case "${tfo:-None}" in
        None | MarkedForDeletion) ;;
        *)
          if az rest --method post --url "${item}/testFailoverCleanup?$ASR_API" --body '{"properties":{"comments":"wg-admin labs: unblock before tear-down"}}' -o none; then
            echo "unblock: $v: ${item##*/}: test failover cleanup started"
            asr_cleanup_wait "$v" "$item"
          else warn "$v: could not clean up the test failover of ${item##*/}"; fi
          ;;
      esac
      asr_remove "$v" "$item"
    done <<<"$items"
    # The wait re-sends remove (every ASR_RESEND_EVERY polls, at most ASR_RESENDS times per
    # item) for an item still listed that is not already being removed: a remove posted
    # while a cleanup still ran is refused, and nothing else would send it again.
    declare -A resent=()
    tries=$(((ASR_WAIT + 14) / 15))
    for ((n = 0; ; n++)); do
      if left="$(asr_list "$g" "$v" replicationProtectedItems "value[].[id, properties.currentScenario.scenarioName, properties.protectionState]")"; then
        listed=true
        if [ -z "$left" ]; then
          echo "unblock: $v: no replicated items left"
          break
        fi
        if [ "$n" -gt 0 ] && [ $((n % ASR_RESEND_EVERY)) -eq 0 ]; then
          while IFS=$'\t' read -r item scen pstate; do
            [ -z "$item" ] && continue
            asr_being_removed "$scen" "$pstate" && continue
            [ "${resent[$item]:-0}" -lt "$ASR_RESENDS" ] || continue
            resent["$item"]=$((${resent[$item]:-0} + 1))
            asr_remove "$v" "$item" " (sent again)"
          done <<<"$left"
        fi
      else
        listed=false
        warn "$v: could not list replicated items, so whether any are left is not known"
      fi
      if [ "$n" -ge "$tries" ]; then
        if [ "$listed" = true ]; then
          warn "$v: $(grep -c . <<<"$left") replicated item(s) still listed after $ASR_WAIT s; the destroy goes ahead and the safety net tries again"
        else
          UNVERIFIED+=("$v replicated items")
        fi
        break
      fi
      sleep 15
    done
    while IFS= read -r m; do
      [ -z "$m" ] && continue
      if az rest --method delete --url "${m}?$ASR_API" -o none; then echo "unblock: $v: network mapping ${m##*/} deleted"; else warn "$v: could not delete network mapping ${m##*/}"; fi
    done < <(asr_list "$g" "$v" replicationNetworkMappings || warn "$v: could not list network mappings")
    while IFS= read -r m; do
      [ -z "$m" ] && continue
      if az rest --method post --url "${m}/remove?$ASR_API" --body '{"properties":{"providerSpecificInput":{}}}' -o none; then echo "unblock: $v: container mapping ${m##*/} removed"; else warn "$v: could not remove container mapping ${m##*/}"; fi
    done < <(asr_list "$g" "$v" replicationProtectionContainerMappings || warn "$v: could not list container mappings")
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      if az rest --method delete --url "${p}?$ASR_API" -o none; then echo "unblock: $v: replication policy ${p##*/} deleted"; else warn "$v: could not delete replication policy ${p##*/}"; fi
    done < <(asr_list "$g" "$v" replicationPolicies || warn "$v: could not list replication policies")
  done <<<"${vaults[$g]}"
done

# 6. SQL (lab 23; ruling 31): failover groups first, deleted on the server that
# holds the primary (after a failover that is the secondary-region server, and
# Terraform's view is stale), then each primary database's geo-replication links
# (a database with a link cannot be deleted while it is a secondary). Servers
# are read across all the lab's groups first, so a link's partner group is known.
declare -A server_rg=()
sql_pairs=()
for g in "${groups[@]}"; do
  while IFS= read -r s; do
    [ -z "$s" ] && continue
    server_rg["$s"]="$g"
    sql_pairs+=("$g"$'\t'"$s")
  done < <(azq sql server list --resource-group "$g" --query "[].name" -o tsv || warn "$g: could not list SQL servers")
done
for pair in "${sql_pairs[@]}"; do
  IFS=$'\t' read -r g s <<<"$pair"
  while IFS=$'\t' read -r fog role; do
    [ -z "$fog" ] && continue
    [ "${role:-Primary}" = Primary ] || continue
    if az sql failover-group delete --resource-group "$g" --server "$s" --name "$fog" -o none; then
      echo "unblock: $fog: failover group deleted (on $s)"
    else warn "$fog: could not delete the failover group (on $s)"; fi
  done < <(azq sql failover-group list --resource-group "$g" --server "$s" --query "[].[name, replicationRole]" -o tsv || warn "$s: could not list failover groups")
done
for pair in "${sql_pairs[@]}"; do
  IFS=$'\t' read -r g s <<<"$pair"
  while IFS= read -r db; do
    [ -z "$db" ] && continue
    while IFS=$'\t' read -r partner role; do
      [ -z "$partner" ] && continue
      [ "${role:-Primary}" = Primary ] || continue
      prg=()
      [ -n "${server_rg[$partner]:-}" ] && prg=(--partner-resource-group "${server_rg[$partner]}")
      if az sql db replica delete-link --resource-group "$g" --server "$s" --name "$db" --partner-server "$partner" "${prg[@]}" --yes -o none; then
        echo "unblock: $db: geo-replication link to $partner removed"
      else warn "$db: could not remove the geo-replication link to $partner"; fi
    done < <(azq sql db replica list-links --resource-group "$g" --server "$s" --name "$db" --query "[].[partnerServer, role]" -o tsv || warn "$db: could not list its replication links")
  done < <(azq sql db list --resource-group "$g" --server "$s" --query "[?name!='master'].name" -o tsv || warn "$s: could not list databases")
done

if [ "${#UNVERIFIED[@]}" -gt 0 ]; then
  unverified="$(printf '%s; ' "${UNVERIFIED[@]}")"
  warn "unverified: ${unverified%; } (Azure could not confirm them); the destroy goes ahead, and the safety net and Verify clean decide"
fi
echo "unblock: done"
exit 0
