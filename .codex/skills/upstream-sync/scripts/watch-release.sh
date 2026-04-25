#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: watch-release.sh [--repo <path>] [--remote <name>] [--mark-current]

Minimal upstream release watcher:
1. Check the selected upstream remote for the newest v* release tag merged into remote/main.
2. If that tag was not already handled, run `omx exec` with $upstream-sync.
3. Let the upstream-sync skill do the sync, conflict resolution, verification, and local CLI update.

State: .omx/state/upstream-sync/release-watch.json
Logs:  .omx/logs/upstream-sync/release-watch.log
USAGE
}

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

fail() {
  log "error: $*" >&2
  exit 1
}

realpath_py() {
  python3 - "$1" <<'PY'
import os
import sys
print(os.path.realpath(sys.argv[1]))
PY
}

json_field() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 0
  python3 - "$file" "$key" <<'PY'
import json
import sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        value = json.load(handle).get(sys.argv[2])
except Exception:
    value = None
if value is not None:
    print(value)
PY
}

is_canonical_upstream_url() {
  local url="$1"
  case "$url" in
    https://github.com/Yeachan-Heo/oh-my-codex|\
    https://github.com/Yeachan-Heo/oh-my-codex.git|\
    git@github.com:Yeachan-Heo/oh-my-codex.git|\
    ssh://git@github.com/Yeachan-Heo/oh-my-codex.git)
      return 0
      ;;
  esac
  return 1
}

write_state() {
  local status="$1"
  local tag="$2"
  local detail="${3:-}"
  mkdir -p "$(dirname "$STATE_FILE")"
  WATCH_STATUS="$status" WATCH_TAG="$tag" WATCH_DETAIL="$detail" WATCH_REMOTE="$REMOTE" python3 - "$STATE_FILE" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    data = {}

status = os.environ["WATCH_STATUS"]
tag = os.environ["WATCH_TAG"]
now = datetime.now(timezone.utc).isoformat()

data.update({
    "latest_tag": tag,
    "last_status": status,
    "last_checked_at": now,
    "remote": os.environ.get("WATCH_REMOTE") or None,
})
data.pop("mode", None)
data.pop("branch", None)
if os.environ.get("WATCH_DETAIL"):
    data["last_detail"] = os.environ["WATCH_DETAIL"]
if status in {"marked-current", "success"}:
    data.pop("running_tag", None)
    data["last_success_tag"] = tag
    data["last_run_finished_at"] = now
    data["last_exit_code"] = 0
elif status == "no-change":
    data.pop("running_tag", None)
    data["last_run_finished_at"] = now
    data["last_exit_code"] = 0
elif status == "running":
    data["running_tag"] = tag
    data["last_run_started_at"] = now
elif status == "failed":
    data.pop("running_tag", None)
    data["last_failed_tag"] = tag
    data["last_run_finished_at"] = now
    data["last_exit_code"] = 1

with open(path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
}

select_remote() {
  if [[ -n "$REMOTE" ]]; then
    git remote get-url "$REMOTE" >/dev/null 2>&1 || fail "remote '$REMOTE' not found"
    printf '%s\n' "$REMOTE"
    return 0
  fi

  local candidate url
  for candidate in upstream origin; do
    if url=$(git remote get-url "$candidate" 2>/dev/null) && is_canonical_upstream_url "$url"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  fail 'no canonical Yeachan-Heo/oh-my-codex remote configured; pass --remote explicitly to use another remote'
}

latest_release_tag() {
  git fetch "$REMOTE" --no-tags "+refs/heads/main:refs/remotes/${REMOTE}/main" >/dev/null \
    || fail "failed to fetch ${REMOTE}/main"
  git fetch --prune "$REMOTE" "+refs/tags/*:refs/upstream-sync/remote-tags/*" >/dev/null \
    || fail "failed to fetch tags from ${REMOTE}"
  git show-ref --verify --quiet "refs/remotes/${REMOTE}/main" || fail "remote '$REMOTE' main is unavailable"
  git for-each-ref \
    --merged="refs/remotes/${REMOTE}/main" \
    --sort=-version:refname \
    --format='%(refname)' \
    'refs/upstream-sync/remote-tags/v*' \
    | sed 's#^refs/upstream-sync/remote-tags/##' \
    | head -1
}

run_upstream_sync_skill() {
  local omx_cmd="${OMX_BIN:-}"
  if [[ -z "$omx_cmd" ]]; then
    omx_cmd=$(command -v omx 2>/dev/null || true)
  fi
  [[ -n "$omx_cmd" && -x "$omx_cmd" ]] || fail 'omx is not executable for the background watcher; set OMX_BIN or PATH'
  mkdir -p "$(dirname "$LOG_FILE")"

  local prompt="Run \$upstream-sync for this repository using --remote ${REMOTE}. Fully automatic: if the skill writes .omx/state/upstream-sync/last-handoff.json, resolve the conflict semantically, continue the merge/rebase, verify the result, and update the local linked CLI from this repo. Your final answer must be exactly three concise lines in this format: upstream: <ok|failed> — <target tag/version and CLI update status>; issues: <none or one short sentence>; release: <one short sentence, max 240 characters>. Do not include command logs, step-by-step narration, raw diff output, or long changelog excerpts."

  log "run: omx exec $prompt" | tee -a "$LOG_FILE"
  set +e
  "$omx_cmd" exec --skip-git-repo-check -C "$ROOT" "$prompt" 2>&1 | tee -a "$LOG_FILE"
  local code=${PIPESTATUS[0]}
  set -e
  log "exit: $code" | tee -a "$LOG_FILE"
  return "$code"
}

ROOT_ARG=""
REMOTE=""
MARK_CURRENT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || fail '--repo requires a value'
      ROOT_ARG="$2"
      shift 2
      ;;
    --remote)
      [[ $# -ge 2 ]] || fail '--remote requires a value'
      REMOTE="$2"
      shift 2
      ;;
    --mark-current)
      MARK_CURRENT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

if [[ -n "$ROOT_ARG" ]]; then
  ROOT=$(cd "$ROOT_ARG" && git rev-parse --show-toplevel 2>/dev/null) || fail "not a git repository: $ROOT_ARG"
else
  ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || fail 'run this inside the oh-my-codex git repository or pass --repo'
fi
ROOT=$(realpath_py "$ROOT")
cd "$ROOT"

REMOTE=$(select_remote)
STATE_FILE="$ROOT/.omx/state/upstream-sync/release-watch.json"
LOG_FILE="$ROOT/.omx/logs/upstream-sync/release-watch.log"
LOCK_DIR="$ROOT/.omx/state/upstream-sync/release-watch.lock"
mkdir -p "$(dirname "$LOCK_DIR")"
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    date -u '+%Y-%m-%dT%H:%M:%SZ' > "$LOCK_DIR/created_at"
    return 0
  fi

  local pid=""
  [[ -f "$LOCK_DIR/pid" ]] && pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    log "skip: watcher already running (pid=$pid)"
    exit 0
  fi

  log "recover: removing stale watcher lock"
  rm -rf "$LOCK_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    date -u '+%Y-%m-%dT%H:%M:%SZ' > "$LOCK_DIR/created_at"
    return 0
  fi

  log "skip: watcher already running"
  exit 0
}

acquire_lock
trap 'rm -rf "$LOCK_DIR"' EXIT

LATEST_TAG=$(latest_release_tag)
[[ -n "$LATEST_TAG" ]] || fail "no v* release tags merged into ${REMOTE}/main"

if [[ "$MARK_CURRENT" -eq 1 ]]; then
  write_state marked-current "$LATEST_TAG" 'baseline recorded without syncing'
  log "marked-current: $LATEST_TAG"
  exit 0
fi

LAST_SUCCESS_TAG=$(json_field "$STATE_FILE" last_success_tag || true)
if [[ "$LAST_SUCCESS_TAG" == "$LATEST_TAG" ]]; then
  write_state no-change "$LATEST_TAG" 'latest release already handled'
  log "no-change: $LATEST_TAG"
  exit 0
fi

write_state running "$LATEST_TAG" 'starting $upstream-sync via omx exec'
if run_upstream_sync_skill; then
  write_state success "$LATEST_TAG" '$upstream-sync completed'
  log "success: $LATEST_TAG"
  exit 0
fi

write_state failed "$LATEST_TAG" '$upstream-sync via omx exec failed; inspect logs'
fail "upstream-sync failed for $LATEST_TAG"
