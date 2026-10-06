#!/usr/bin/env bash
# infra/ci/lab-state-reset.sh <lab id>      lab.yml step 15, "Back up state", after the backup
#
# Plain English: once the clean check has said Azure and Entra hold nothing of
# the lab (VERIFY_CLEAN=true), its Terraform state in R2 describes nothing, and
# a lock left by a run that died (a cancelled job, a runner lost mid-apply)
# would stop the next deploy at "Error acquiring the state lock". So both go:
#
#   s3://$R2_BUCKET/labs/<id>/terraform.tfstate          (backed up just before)
#   s3://$R2_BUCKET/labs/<id>/terraform.tfstate.tflock   (use_lockfile's lock)
#
# Never when the lab is not clean (or not checked): the state is then what the
# next destroy needs. Safe against a racing run: lab.yml's "Wait for earlier
# run of this lab" and the Worker's lab lock keep one run per lab at a time,
# and this run is still going. Deleting an object that is not there is not an
# error in S3 or R2. Always exits 0 unless the lab id is bad (2); a failed
# delete is a warning (the next clean destroy tries again).

set -uo pipefail

LAB_ID="${1:-}"
LAB_ID_RE='^az(104|305|700)-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$'
if ! [[ "$LAB_ID" =~ $LAB_ID_RE ]] || [ "${#LAB_ID}" -gt 40 ]; then
  echo "::error::lab-state-reset: refusing lab id '${LAB_ID}'"
  exit 2
fi
if [ "${VERIFY_CLEAN:-}" != true ]; then
  echo "state kept: the lab was not verified clean in this run"
  exit 0
fi
if [ -z "${R2_BUCKET:-}" ]; then
  echo "::warning::lab-state-reset: no R2 bucket; the state and any lock are left as they are"
  exit 0
fi
key="labs/$LAB_ID/terraform.tfstate"
for obj in "$key" "$key.tflock"; do
  if aws s3 rm "s3://$R2_BUCKET/$obj" --only-show-errors; then
    echo "removed $obj (the lab is clean)"
  else
    echo "::warning::could not remove $obj; the next clean destroy tries again"
  fi
done
exit 0
