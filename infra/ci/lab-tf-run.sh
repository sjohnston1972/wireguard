#!/usr/bin/env bash
# infra/ci/lab-tf-run.sh
#
# Plain English: lab.yml's Apply and Destroy, which try again when Azure only
# dropped the connection (release tests saw "HTTP response was nil; connection
# may have been reset" now and then, with nothing wrong in the lab):
#
#   bash infra/ci/lab-tf-run.sh apply     apply $RUNNER_TEMP/plan.out, at most 2 retries
#   bash infra/ci/lab-tf-run.sh destroy   terraform destroy, at most 1 retry
#
# A failure is retried only when infra/ci/lab-transient.mjs says every error
# in Terraform's output is a transport error; a quota, validation or
# authorization refusal (any 4xx but 408 and 429) fails at once, as before.
# A saved plan cannot be applied again after a partial apply, so a retried
# apply first makes a fresh plan and shows it to the scope check
# (lab-plan.sh --retry): a plan the check refuses is never applied.
# Each retry waits LAB_APPLY_BACKOFF_SECONDS (default 30) times its number,
# and starts only if the job's deadline (LAB_JOB_DEADLINE, Parse payload)
# still leaves room for it and for everything after it: the deploy
# (LAB_DEPLOY_MIN, apply only), the teardown (LAB_DESTROY_MIN) and the 420 s
# the safety net, Verify clean, Back up state and the report keep.
#
# Apply's "Outputs:" block (addresses, user names) is cut from this public log.

set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
action="${1:-}"
case "$action" in
  apply) retries=2 ;;
  destroy) retries=1 ;;
  *) echo "usage: lab-tf-run.sh apply|destroy" >&2; exit 2 ;;
esac
num() { [[ "${1:-}" =~ ^[0-9]+$ ]] && echo "$1" || echo "$2"; }
backoff="$(num "${LAB_APPLY_BACKOFF_SECONDS:-}" 30)"
deploy_min="$(num "${LAB_DEPLOY_MIN:-}" 10)"
destroy_min="$(num "${LAB_DESTROY_MIN:-}" 10)"
RESERVE_S=420

cd "$GITHUB_WORKSPACE/labs/$LAB_ID/terraform" || exit 1
log="$RUNNER_TEMP/$action.log"

attempt=0
while :; do
  if [ "$action" = apply ]; then
    # Exactly the plan that passed the scope check (step 6's, or this script's fresh one).
    terraform apply -no-color -input=false "$RUNNER_TEMP/plan.out" 2>&1 | sed -u '/^Outputs:/,$d' | tee "$log"
  else
    # A lock a dead run left behind fails this after 5 minutes rather than at once;
    # the safety net still finishes, and once clean, Back up state removes the lock.
    terraform destroy -no-color -input=false -auto-approve -lock-timeout=5m 2>&1 | tee "$log"
  fi
  rc="${PIPESTATUS[0]}"
  [ "$rc" -eq 0 ] && exit 0

  if [ "$attempt" -ge "$retries" ]; then
    word=retries; [ "$retries" -eq 1 ] && word=retry
    echo "::error::terraform $action still failing after $retries $word; Azure kept dropping the connection"
    exit "$rc"
  fi
  if ! why="$(node "$here/lab-transient.mjs" "$log")"; then
    echo "terraform $action failed with an error that is not a dropped connection; not retrying"
    exit "$rc"
  fi
  attempt=$((attempt + 1))
  wait_s=$((backoff * attempt))
  if [[ "${LAB_JOB_DEADLINE:-}" =~ ^[0-9]+$ ]]; then
    need=$((wait_s + RESERVE_S + 60 * destroy_min))
    [ "$action" = apply ] && need=$((need + 60 * deploy_min))
    if [ $(($(date +%s) + need)) -gt "$LAB_JOB_DEADLINE" ]; then
      echo "::warning::Azure dropped the connection ($why), but the job's deadline leaves no room to retry $action"
      exit "$rc"
    fi
  fi
  echo "::warning::Azure dropped the connection; retrying $action ($attempt of $retries) in $wait_s s ($why)"
  sleep "$wait_s"
  if [ "$action" = apply ]; then
    # The saved plan may be half applied: plan again, and check the new plan's scope before applying it.
    echo "making a fresh plan of what is left to build, and checking its scope"
    bash "$here/lab-plan.sh" --retry || { echo "::error::the fresh plan failed or its scope check refused it; not applying"; exit 1; }
  fi
done
