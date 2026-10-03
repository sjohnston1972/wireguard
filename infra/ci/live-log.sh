# infra/ci/live-log.sh
#
# Plain English: sourced as the first line of a wg.yml step to copy that
# step's output into the run's live log, which the Worker shows on the
# dashboard while the run is still going (see live-log.mjs):
#
#   source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "terraform apply"
#
# From here on the step's stdout and stderr go through `tee`: one copy to
# GitHub's console exactly as before, one to live-log.mjs, which hides every
# secret the step can see and appends the lines to $LIVE_LOG_FILE. The step's
# own commands still run in the step's own shell, so its exit code is
# untouched. When the step ends, an EXIT trap closes the copy and waits (a few
# seconds at most) for the last lines to be written.
#
# Safe by default: does nothing at all when $LIVE_LOG_FILE is empty (a manual
# run, or the live log failed to start) or Node is missing. If the copy dies
# part-way, `cat` drains the rest so the step never blocks or sees a broken
# pipe, and `tee -p` would carry on even if it did.

_ll_node="${LIVE_LOG_NODE:-node}"
if [ -n "${LIVE_LOG_FILE:-}" ] && command -v "$_ll_node" >/dev/null 2>&1 && tee -p </dev/null >/dev/null 2>&1; then
  _ll_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/live-log.mjs"
  _ll_done="${LIVE_LOG_FILE}.done.$$.${RANDOM}"
  exec {_ll_out}>&1 {_ll_err}>&2
  exec > >(tee -p >("$_ll_node" "$_ll_script" filter "${1:-step}" "$_ll_done" 2>/dev/null || { cat >/dev/null; : >"$_ll_done"; })) 2>&1

  _live_log_end() {
    # Point stdout and stderr back at the console: that closes the copy's
    # input, so it finishes and says so by creating the done file.
    exec 1>&"$_ll_out" 2>&"$_ll_err"
    local i=0
    while [ ! -e "$_ll_done" ] && [ "$i" -lt 100 ]; do
      sleep 0.05 || break
      i=$((i + 1))
    done
    rm -f "$_ll_done" 2>/dev/null || true
  }
  # The trap runs after the step's last command; bash then exits with that
  # command's status, not the trap's.
  trap _live_log_end EXIT
fi
