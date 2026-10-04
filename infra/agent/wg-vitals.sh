#!/usr/bin/env bash
# wg-vitals.sh
#
# Plain English: the VM's own health figures for the dashboard, like the
# "show processes memory" and "show environment" a router answers. Two
# halves, so the 30-second heartbeat never waits on anything slow:
#
#   wg-vitals.sh collect   Called by wg-agent.sh on every heartbeat. Prints
#                          one JSON object: memory, disk, CPU steal, the
#                          connection-tracking table, plus the cached result
#                          of each background job. Only file reads and one
#                          "df". Starts a job (through systemd-run, so it
#                          runs on its own) when its result is old.
#   wg-vitals.sh updates   Pending and security updates (apt-check), every 6 h.
#   wg-vitals.sh events    Azure's scheduled maintenance for this VM, from the
#                          metadata service, every 60 s. Read only: never
#                          approves an event (that would bring it forward).
#   wg-vitals.sh net       An internet check, every 5 min: ping 1.1.1.1 and
#                          8.8.8.8; if every ping is lost, a TCP connect to
#                          port 53 tells "ping blocked" from "no internet".
#
# Every part is optional: anything that cannot be read is null, a job that
# fails leaves its last result, and nothing here can stop the heartbeat.
# Insights spec section 5. WG_ROOT is for tests only (a fixture tree in
# place of /proc and /run); it is empty on the VM.

set -uo pipefail
export LC_ALL=C

ROOT="${WG_ROOT:-}"
RUN="$ROOT/run/wg-admin"
SELF="$ROOT/usr/local/sbin/wg-vitals.sh"

# Seconds between runs of each background job.
declare -A EVERY=([updates]=21600 [events]=60 [net]=300)

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Write a job's result in one step, so collect never reads half a file.
save() {
  local name="$1" json="$2"
  [[ -n "$json" ]] || return 0
  printf '%s\n' "$json" > "$RUN/$name.json.tmp" && mv -f "$RUN/$name.json.tmp" "$RUN/$name.json"
}

# One copy of a job at a time: a second start while one runs exits at once.
# The lock is a folder holding the owner's pid, so a lock left by a job that
# was killed (RuntimeMaxSec) is noticed and taken over.
LOCK=""
take_lock() {
  LOCK="$RUN/vitals-$1.lock"
  if ! mkdir "$LOCK" 2>/dev/null; then
    local pid=""
    read -r pid < "$LOCK/pid" 2>/dev/null || true
    # No pid yet: the owner is between mkdir and writing it. Leave it be.
    [[ -z "$pid" ]] && return 1
    kill -0 "$pid" 2>/dev/null && return 1
    rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || return 1
  fi
  # BASHPID: the pid of the shell that holds the lock, even in a subshell.
  # This file is carried gzipped (file(), not Terraform's template), so the
  # cloud-init text checks never see it; CI unpacks it and runs bash -n.
  echo "$BASHPID" > "$LOCK/pid"
  trap 'rm -rf "$LOCK"' EXIT
  return 0
}

# ── Job: pending updates ────────────────────────────────────────────────────
# apt-check (from update-notifier-common, on Ubuntu's server image) writes
# "pending;security" to stderr. Without it, count a simulated upgrade.
job_updates() {
  local apt=/usr/lib/update-notifier/apt-check out pending security
  if [[ -x "$ROOT$apt" ]]; then apt="$ROOT$apt"; else apt="$(command -v apt-check || true)"; fi
  if [[ -n "$apt" ]]; then
    out="$(timeout 120 "$apt" 2>&1 >/dev/null)" || true
    out="${out##*$'\n'}"
    [[ "$out" =~ ^([0-9]+)\;([0-9]+) ]] || return 0
    pending="${BASH_REMATCH[1]}" security="${BASH_REMATCH[2]}"
  else
    out="$(timeout 120 apt-get -s -o Debug::NoLocking=true upgrade 2>/dev/null)" || return 0
    pending="$(grep -c '^Inst ' <<<"$out" || true)"
    security="$(grep '^Inst ' <<<"$out" | grep -c -- '-security' || true)"
  fi
  save updates "{\"pending\":$((10#$pending)),\"security\":$((10#$security)),\"at\":\"$(now_iso)\"}"
}

# ── Job: Azure scheduled events ─────────────────────────────────────────────
# The metadata service lists maintenance Azure has planned (Reboot, Redeploy,
# Freeze, Preempt, Terminate). Only GETs, 2-second cap. The very first call
# after boot switches the service on and may time out; the next one answers.
# If it does not answer, the last result stays (its "at" shows its age).
IMDS="http://169.254.169.254/metadata"
job_events() {
  local name="" body
  read -r name < "$RUN/vm-name" 2>/dev/null || true
  if [[ -z "$name" ]]; then
    name="$(curl -s -f --noproxy '*' -H Metadata:true --max-time 2 "$IMDS/instance/compute/name?api-version=2021-02-01&format=text" 2>/dev/null || true)"
    if [[ "$name" =~ ^[A-Za-z0-9._-]{1,80}$ ]]; then printf '%s\n' "$name" > "$RUN/vm-name"; else name=""; fi
  fi
  body="$(curl -s -f --noproxy '*' -H Metadata:true --max-time 2 "$IMDS/scheduledevents?api-version=2020-07-01" 2>/dev/null)" || return 0
  # "self": this VM is among the event's resources. A standalone VM is only
  # ever told about itself, so with its name unknown an event counts as its own.
  save events "$(jq -c --arg at "$(now_iso)" --arg name "$name" '
    def str: if type == "string" and . != "" then . else null end;
    {incarnation: (.DocumentIncarnation | if type == "number" then . else null end),
     at: $at,
     items: [(.Events // [])[] | select(type == "object") | {
       id: (.EventId | tostring),
       type: .EventType,
       status: .EventStatus,
       not_before: (.NotBefore | str),
       source: (.EventSource | str),
       duration_s: (.DurationInSeconds | if type == "number" and . > 0 then . else null end),
       description: (.Description | str | if . then .[0:200] else null end),
       self: ($name == "" or ((.Resources // []) | index($name) != null))
     }][0:10]}' <<<"$body" 2>/dev/null)"
}

# ── Job: internet check ─────────────────────────────────────────────────────
TARGETS=(1.1.1.1 8.8.8.8)
# Microseconds since the epoch, without starting a process.
usec() { local t="${EPOCHREALTIME/[.,]/}"; echo "$((10#$t))"; }
job_net() {
  local work ip out loss rtt method=icmp lost_all=1 entries=() tcp=() t0 us
  # iputils' summary: "3 packets transmitted, 3 received, 0% packet loss, ..."
  # and "rtt min/avg/max/mdev = 8.9/9.4/9.9/0.3 ms" (the average is kept).
  local re_loss='([0-9.]+)% packet loss' re_rtt='= [0-9.]+/([0-9.]+)/'
  work="$(mktemp -d)"
  for ip in "${TARGETS[@]}"; do
    ping -n -q -c 3 -i 0.2 -W 1 "$ip" > "$work/$ip" 2>&1 &
  done
  wait
  for ip in "${TARGETS[@]}"; do
    out="$(<"$work/$ip")"
    # No summary at all ("Network is unreachable") means nothing came back.
    loss=100 rtt=null
    [[ "$out" =~ $re_loss ]] && loss="${BASH_REMATCH[1]}"
    [[ "$out" =~ $re_rtt ]] && rtt="${BASH_REMATCH[1]}"
    [[ "$loss" != 100 ]] && lost_all=0
    entries+=("{\"ip\":\"$ip\",\"rtt_ms\":$rtt,\"loss_pct\":$loss}")
  done
  rm -rf "$work"
  if (( lost_all )); then
    # Every ping lost: is ICMP blocked, or is the internet gone? A TCP
    # connect to DNS answers that; its time stands in for the round trip.
    for ip in "${TARGETS[@]}"; do
      t0="$(usec)"
      if timeout 2 bash -c "exec 3<>/dev/tcp/$ip/53" 2>/dev/null; then
        us=$(( $(usec) - t0 ))
        method=tcp
        tcp+=("{\"ip\":\"$ip\",\"rtt_ms\":$((us / 1000)).$(( (us % 1000) / 100 )),\"loss_pct\":0}")
      else
        tcp+=("{\"ip\":\"$ip\",\"rtt_ms\":null,\"loss_pct\":100}")
      fi
    done
    if [[ "$method" == tcp ]]; then entries=("${tcp[@]}"); fi
  fi
  local IFS=,
  save net "{\"at\":\"$(now_iso)\",\"method\":\"$method\",\"targets\":[${entries[*]}]}"
}

# ── collect: the heartbeat's part ───────────────────────────────────────────
# Hundredths as a decimal ("412" -> 4.12) into the named variable; a negative
# value (a counter that went backwards) leaves it null. No subshell.
pct2() {
  local h="$2"
  (( h < 0 )) && return 0
  printf -v "$1" '%d.%02d' $((h / 100)) $((h % 100))
}

collect() {
  local k v _ mt="" ma="" mem="" disk="" cpu="" ct="" size used avail
  [[ -d "$RUN" ]] || mkdir -p "$RUN" 2>/dev/null

  # Memory: /proc/meminfo, in kB.
  while read -r k v _; do
    case "$k" in MemTotal:) mt="$v" ;; MemAvailable:) ma="$v" ;; esac
  done < "$ROOT/proc/meminfo" 2>/dev/null
  [[ "$mt" =~ ^[0-9]+$ && "$ma" =~ ^[0-9]+$ ]] && mem="{\"total\":$((mt * 1024)),\"available\":$((ma * 1024))}"

  # Disk: the root file system, in bytes.
  { read -r _; read -r size used avail; } < <(timeout 2 df -B1 --output=size,used,avail / 2>/dev/null)
  [[ "${size:-}" =~ ^[0-9]+$ && "${used:-}" =~ ^[0-9]+$ && "${avail:-}" =~ ^[0-9]+$ ]] && disk="{\"total\":$size,\"used\":$used,\"avail\":$avail}"

  # CPU: steal (time the hypervisor gave to other VMs) and I/O wait, as a
  # share of all CPU time since the previous heartbeat's reading.
  local line n=0 cur="" user nice sys idle iow irq sirq steal
  while read -r line; do
    case "$line" in
      "cpu "*) cur="$line" ;;
      cpu[0-9]*) n=$((n + 1)) ;;
      *) break ;;
    esac
  done < "$ROOT/proc/stat" 2>/dev/null
  if [[ -n "$cur" ]]; then
    read -r _ user nice sys idle iow irq sirq steal _ <<<"$cur"
    local now_s="$user $nice $sys $idle $iow $irq $sirq ${steal:-0}" prev="" steal_pct=null iow_pct=null ncpu=null
    local eight='^[0-9]+( [0-9]+){7}$'
    if [[ "$now_s" =~ $eight ]]; then
      read -r prev < "$RUN/cpustat" 2>/dev/null || true
      printf '%s\n' "$now_s" > "$RUN/cpustat" 2>/dev/null
      if [[ "$prev" =~ $eight ]]; then
        local -a a b
        read -ra a <<<"$prev"
        read -ra b <<<"$now_s"
        local total=0 i
        for i in 0 1 2 3 4 5 6 7; do total=$((total + b[i] - a[i])); done
        if (( total > 0 )); then
          pct2 steal_pct $(( (b[7] - a[7]) * 10000 / total ))
          pct2 iow_pct $(( (b[4] - a[4]) * 10000 / total ))
        fi
      fi
    fi
    (( n > 0 )) && ncpu="$n"
    cpu="{\"steal_pct\":$steal_pct,\"iowait_pct\":$iow_pct,\"ncpu\":$ncpu}"
  fi

  # Connection tracking: entries in use and the table's size (absent when
  # the netfilter module is not loaded).
  local cc="" cm=""
  read -r cc < "$ROOT/proc/sys/net/netfilter/nf_conntrack_count" 2>/dev/null || true
  read -r cm < "$ROOT/proc/sys/net/netfilter/nf_conntrack_max" 2>/dev/null || true
  [[ "$cc" =~ ^[0-9]+$ && "$cm" =~ ^[0-9]+$ ]] && ct="{\"count\":$cc,\"max\":$cm}"

  # Start each background job whose last start is older than its interval.
  # The start time is written before the job is queued, so a job that keeps
  # failing is not restarted on every heartbeat. One with no result yet (apt
  # busy just after boot, say) is tried again after 5 minutes, not 6 hours.
  local job started now every
  now="${EPOCHSECONDS:-$(date +%s)}"
  for job in updates events net; do
    every="${EVERY[$job]}"
    if [[ ! -s "$RUN/$job.json" ]] && (( every > 300 )); then every=300; fi
    started=""
    read -r started < "$RUN/vitals-$job.started" 2>/dev/null || true
    [[ "$started" =~ ^[0-9]+$ ]] && (( now - started < every )) && continue
    printf '%s\n' "$now" > "$RUN/vitals-$job.started" 2>/dev/null
    systemd-run --quiet --no-block --collect --unit "wg-vitals-$job" -p RuntimeMaxSec=300 -p Nice=10 "$SELF" "$job" >/dev/null 2>&1 </dev/null || true
  done

  # One JSON object. A cache file that is not a JSON object reads as null.
  local f updates="" events="" net=""
  for f in updates events net; do
    [[ -s "$RUN/$f.json" ]] && { IFS= read -r -d '' -n 65536 "$f" < "$RUN/$f.json" 2>/dev/null || true; }
  done
  jq -n -c --arg mem "$mem" --arg disk "$disk" --arg cpu "$cpu" --arg ct "$ct" --arg updates "$updates" --arg events "$events" --arg net "$net" '
    def obj($s): ($s | try fromjson catch null) | if type == "object" then . else null end;
    {mem: obj($mem), disk: obj($disk), cpu: obj($cpu), conntrack: obj($ct), updates: obj($updates), events: obj($events), net: obj($net)}'
}

job="${1:-}"
case "$job" in
  collect) collect ;;
  updates | events | net)
    mkdir -p "$RUN"
    take_lock "$job" || exit 0
    "job_$job"
    ;;
  *) echo "usage: $0 collect|updates|events|net" >&2; exit 2 ;;
esac
exit 0
