#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: install-release-watch-launchagent.sh [--repo <path>] [--remote <name>] [--interval <seconds>] [--uninstall]

Install a macOS LaunchAgent that runs watch-release.sh in the background.
The watcher has one behavior only: when a new upstream release appears, run
`omx exec` with $upstream-sync and let that skill sync, resolve conflicts, and
update the local CLI.
USAGE
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

realpath_py() {
  python3 - "$1" <<'PY'
import os
import sys
print(os.path.realpath(sys.argv[1]))
PY
}

ROOT_ARG=""
REMOTE=""
INTERVAL=3600
UNINSTALL=0
LABEL="com.oh-my-codex.upstream-sync.watch"

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
    --interval)
      [[ $# -ge 2 ]] || fail '--interval requires a value'
      INTERVAL="$2"
      shift 2
      ;;
    --uninstall)
      UNINSTALL=1
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

case "$INTERVAL" in
  ''|*[!0-9]*) fail '--interval must be a positive integer' ;;
esac
[[ "$INTERVAL" -ge 60 ]] || fail '--interval must be at least 60 seconds'

if [[ -n "$ROOT_ARG" ]]; then
  ROOT=$(cd "$ROOT_ARG" && git rev-parse --show-toplevel 2>/dev/null) || fail "not a git repository: $ROOT_ARG"
else
  ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || fail 'run this inside the oh-my-codex git repository or pass --repo'
fi
ROOT=$(realpath_py "$ROOT")

PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"
SERVICE="${DOMAIN}/${LABEL}"

if [[ "$UNINSTALL" -eq 1 ]]; then
  launchctl bootout "$DOMAIN" "$PLIST_PATH" >/dev/null 2>&1 || true
  rm -f "$PLIST_PATH"
  printf 'removed: %s\n' "$PLIST_PATH"
  exit 0
fi

WATCH_SCRIPT="$ROOT/.codex/skills/upstream-sync/scripts/watch-release.sh"
[[ -x "$WATCH_SCRIPT" ]] || fail "watch script is not executable: $WATCH_SCRIPT"
mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/.omx/logs/upstream-sync"

ARGS=("$WATCH_SCRIPT" --repo "$ROOT")
[[ -n "$REMOTE" ]] && ARGS+=(--remote "$REMOTE")

LAUNCH_LABEL="$LABEL" \
LAUNCH_INTERVAL="$INTERVAL" \
LAUNCH_STDOUT="$ROOT/.omx/logs/upstream-sync/release-watch.launchd.log" \
LAUNCH_STDERR="$ROOT/.omx/logs/upstream-sync/release-watch.launchd.err.log" \
LAUNCH_PATH_VALUE="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
LAUNCH_OMX_BIN="$(command -v omx 2>/dev/null || true)" \
python3 - "$PLIST_PATH" "${ARGS[@]}" <<'PY'
import os
import plistlib
import sys

plist = {
    "Label": os.environ["LAUNCH_LABEL"],
    "ProgramArguments": sys.argv[2:],
    "StartInterval": int(os.environ["LAUNCH_INTERVAL"]),
    "RunAtLoad": True,
    "StandardOutPath": os.environ["LAUNCH_STDOUT"],
    "StandardErrorPath": os.environ["LAUNCH_STDERR"],
    "EnvironmentVariables": {
        "HOME": os.environ.get("HOME", ""),
        "PATH": os.environ["LAUNCH_PATH_VALUE"],
        "OMX_BIN": os.environ.get("LAUNCH_OMX_BIN", ""),
    },
}
with open(sys.argv[1], "wb") as handle:
    plistlib.dump(plist, handle, sort_keys=False)
PY

launchctl bootout "$DOMAIN" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
launchctl kickstart -k "$SERVICE" >/dev/null 2>&1 || true
printf 'loaded: %s\n' "$SERVICE"
printf 'interval: %ss | repo: %s\n' "$INTERVAL" "$ROOT"
