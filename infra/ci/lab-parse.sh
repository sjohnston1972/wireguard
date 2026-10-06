#!/usr/bin/env bash
# infra/ci/lab-parse.sh   (lab.yml step 1, "Check out, Parse payload")
#
# Plain English: reads the run's action ($LAB_ACTION_INPUT) and JSON payload
# (from $GITHUB_EVENT_PATH, never an env line, which GitHub would print),
# checks every value, and saves what later steps need in $GITHUB_ENV (labs
# spec §5). It refuses the run, before anything touches Azure, when:
#
#   - the lab id fails the pattern (^az(104|305|700)-NN-word(-word)*$, 40 at most)
#   - labs/<id>/lab.yaml does not exist, or names another id
#   - the payload's version differs from lab.yaml's (a stale dashboard), or
#     a deploy or test finds no terraform/ folder
#   - any value is the wrong type or shape: a slot outside 10.64.0.0/13 or not
#     on a /18 boundary, a name_prefix not l<lab number><5 lowercase>, a
#     callback that is not https, a line break or quote anywhere
#
# A destroy is never refused for being stale or for a lab that has left the
# catalogue: it goes ahead (with a warning), because a teardown must always
# be able to reach £0. Its Terraform steps are then skipped and the safety
# net does the work.
#
# lab.yaml is read with Python's PyYAML (on the runner), which reads YAML 1.1,
# as the labs contract does.

set -euo pipefail

ROOT="${GITHUB_WORKSPACE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
ACTION="${LAB_ACTION_INPUT:-}"
: "${GITHUB_EVENT_PATH:?GITHUB_EVENT_PATH is not set}"
: "${GITHUB_ENV:?GITHUB_ENV is not set}"

PY="${LAB_PYTHON:-}"
if [ -z "$PY" ]; then
  for p in python3 python; do
    if "$p" -c 'import yaml' >/dev/null 2>&1; then PY="$p"; break; fi
  done
fi
[ -n "$PY" ] || { echo "::error::Parse payload: Python with PyYAML is needed to read lab.yaml"; exit 1; }

# Save one value for later steps. A line break could smuggle in extra
# variables, so it is refused, and the end marker is random each time.
put_env() {
  case "$2" in *$'\n'* | *$'\r'*) echo "::error::payload value $1 contains a line break; refusing it"; exit 1 ;; esac
  local end
  end="EOV_$(openssl rand -hex 16 2>/dev/null || echo "$RANDOM$RANDOM$RANDOM$RANDOM")"
  { echo "$1<<$end"; printf '%s\n' "$2"; echo "$end"; } >>"$GITHUB_ENV"
}

values="$("$PY" - "$ACTION" "$GITHUB_EVENT_PATH" "$ROOT" <<'PY'
import ipaddress, json, os, re, sys, time

action, event_path, root = sys.argv[1], sys.argv[2], sys.argv[3]
sys.stdout.reconfigure(newline="\n")  # plain line ends, even from Python on Windows
problems, warnings, out = [], [], {}

def fail(msg):
    problems.append(msg)

ACTIONS = ("deploy", "destroy", "peer", "unpeer", "test")
LAB_ID_RE = re.compile(r"^az(104|305|700)-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$")
SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")
REGION = re.compile(r"^[a-z][a-z0-9]{1,30}$")
URL = re.compile(r"^https://[A-Za-z0-9.-]+(:\d+)?(/[A-Za-z0-9._~/-]*)?$")
POOL = ipaddress.ip_network("10.64.0.0/13")

if action not in ACTIONS:
    fail(f"action must be one of {', '.join(ACTIONS)}")
try:
    with open(event_path, encoding="utf-8") as f:
        raw = (json.load(f).get("inputs") or {}).get("payload") or "{}"
    payload = json.loads(raw)
except Exception:
    payload = None
if not isinstance(payload, dict):
    print("::error::Parse payload: the payload must be a JSON object", file=sys.stderr)
    sys.exit(1)

KNOWN = {"lab_id", "version", "run_id", "session_id", "region", "secondary_region", "slot_cidr", "name_prefix", "peering", "timeout_min", "callback_url", "secrets_url"}
for k in sorted(set(payload) - KNOWN):
    warnings.append(f"payload key {k} is not one lab.yml uses; ignored")

lab_id = payload.get("lab_id")
if not isinstance(lab_id, str) or not LAB_ID_RE.fullmatch(lab_id) or len(lab_id) > 40:
    print(f"::error::Parse payload: refusing lab id {json.dumps(lab_id)[:60]}", file=sys.stderr)
    sys.exit(1)
number = lab_id.split("-")[1]
teardown = action in ("destroy", "unpeer")
needs_tf = action in ("deploy", "test")

folder = os.path.join(root, "labs", lab_id)
yaml_path = os.path.join(folder, "lab.yaml")
lab = None
if os.path.isfile(yaml_path):
    import yaml
    try:
        with open(yaml_path, encoding="utf-8") as f:
            lab = yaml.safe_load(f)
    except Exception as e:
        fail(f"labs/{lab_id}/lab.yaml does not parse: {e}")
    if isinstance(lab, dict) and lab.get("id") != lab_id:
        fail(f"labs/{lab_id}/lab.yaml names id {lab.get('id')!r}")
    if not isinstance(lab, dict):
        lab = None
elif action == "destroy":
    warnings.append(f"no labs/{lab_id} folder: cleaning up a lab that has left the catalogue, by name only")
else:
    fail(f"no labs/{lab_id}/lab.yaml: refusing to {action} a lab that is not in the catalogue")

version = payload.get("version")
if lab is not None:
    if not (isinstance(version, int) and not isinstance(version, bool)) or version != lab.get("version"):
        msg = f"payload version {version} differs from lab.yaml version {lab.get('version')} (a stale dashboard)"
        if teardown:
            warnings.append(msg + "; tearing down anyway")
        else:
            fail(msg + "; refusing")
elif version is not None and not (isinstance(version, int) and not isinstance(version, bool)):
    fail("version must be a whole number")

tf_dir = os.path.join(folder, "terraform")
has_tf = os.path.isdir(tf_dir) and any(n.endswith(".tf") for n in os.listdir(tf_dir))
if needs_tf and not has_tf:
    fail(f"labs/{lab_id} has no terraform/ folder with .tf files; it cannot be deployed yet")

def text(key, pattern, default="", required=False, label=None):
    v = payload.get(key)
    if v is None or v == "":
        if required:
            fail(f"{key} is required for {action}")
        return default
    if not isinstance(v, str) or not pattern.fullmatch(v):
        fail(f"{key} is not {label or 'valid'}")
        return default
    return v

run_id = text("run_id", SAFE, "manual", label="a plain run id")
session_id = text("session_id", SAFE, run_id, label="a plain session id")
region = text("region", REGION, "uksouth", required=needs_tf, label="an Azure region name")
secondary = text("secondary_region", REGION, "", label="an Azure region name")

slot = payload.get("slot_cidr")
if slot in (None, ""):
    if needs_tf:
        fail(f"slot_cidr is required for {action}")
    slot = "10.64.0.0/18"
else:
    try:
        net = ipaddress.ip_network(slot) if isinstance(slot, str) else None
    except ValueError:
        net = None
    if net is None or net.prefixlen != 18 or not net.subnet_of(POOL) or str(net) != slot:
        fail("slot_cidr must be one of the 32 /18 slots in 10.64.0.0/13")

prefix = text("name_prefix", re.compile(rf"^l{number}[a-z0-9]{{5}}$"), f"l{number}00000", required=needs_tf, label=f"l{number} and 5 lowercase letters or digits")

peering = payload.get("peering", False)
if not isinstance(peering, bool):
    fail("peering must be true or false")
    peering = False
mode = ((lab or {}).get("connectivity") or {}).get("peering")
if mode == "off" or mode is False:
    peering = False

timeout = payload.get("timeout_min", 60)
if not (isinstance(timeout, int) and not isinstance(timeout, bool)) or not 1 <= timeout <= 150:
    fail("timeout_min must be a whole number of minutes, 1 to 150")

callback = text("callback_url", URL, "", label="an https address")
secrets = text("secrets_url", URL, "", label="an https address")
base = callback.rstrip("/")
if base.endswith("/lab"):
    base = base[: -len("/lab")]

timing = (lab or {}).get("timing") or {}
identity = (lab or {}).get("identity") or {}
creates = identity.get("creates")
entra = True if lab is None else bool(creates)

out.update({
    "LAB_ID": lab_id,
    "LAB_ACTION": action,
    "LAB_NUMBER": number,
    "LAB_VERSION": str(version if isinstance(version, int) else (lab or {}).get("version", "")),
    "LAB_FOLDER": "true" if lab is not None else "false",
    "LAB_HAS_TF": "true" if has_tf else "false",
    "LAB_DEPLOY_MIN": str(timing.get("deploy_min", 10)),
    "LAB_DESTROY_MIN": str(timing.get("destroy_min", 10)),
    # When the job's timeout-minutes runs out (this step runs seconds after the job starts): the
    # safety net stops waiting for resource group deletes in time for the steps after it.
    "LAB_JOB_DEADLINE": str(int(time.time()) + (timeout if isinstance(timeout, int) else 60) * 60),
    "LAB_DNS_LINK": "true" if ((lab or {}).get("connectivity") or {}).get("dns_link") is True else "false",
    "LAB_ENTRA": "true" if entra else "false",
    "LAB_PEERING": "true" if peering else "false",
    "WORKER_RUN_ID": run_id,
    "SESSION_ID": session_id,
    "CALLBACK_URL": f"{base}/lab" if base else "",
    "LAB_PEER_URL": f"{base}/lab-peer" if base else "",
    "LIVE_LOG_URL": f"{base}/log" if base else "",
    "SECRETS_URL": secrets,
    "TF_VAR_lab_id": lab_id,
    "TF_VAR_name_prefix": prefix,
    "TF_VAR_resource_group_name": f"rg-lab-{lab_id}",
    "TF_VAR_region": region,
    "TF_VAR_secondary_region": secondary,
    "TF_VAR_address_space": slot,
    "TF_VAR_peered": "true" if peering else "false",
    "TF_VAR_tags": json.dumps({"project": "wg-admin-labs", "lab": lab_id, "session": session_id}, separators=(",", ":")),
})

for w in warnings:
    print(f"::warning::Parse payload: {w}", file=sys.stderr)
if problems:
    for p in problems:
        print(f"::error::Parse payload: {p}", file=sys.stderr)
    sys.exit(1)
for k, v in out.items():
    if any(c in v for c in "\r\n"):
        print(f"::error::Parse payload: {k} contains a line break", file=sys.stderr)
        sys.exit(1)
    print(f"{k}={v}")
PY
)"

while IFS= read -r line; do
  line="${line%$'\r'}"
  [ -z "$line" ] && continue
  put_env "${line%%=*}" "${line#*=}"
  echo "set ${line%%=*}"
done <<<"$values"
