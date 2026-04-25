#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: sync.sh [--branch <name>] [--remote <name>] [--check-only] [--no-cli-update]

Syncs local main to the newest release tag already merged into the selected remote main,
optionally rebases one explicit work branch onto the refreshed local main, relinks the
repo-backed CLI when the current checkout is main, and finishes with a short three-line report.
USAGE
}

log() {
  printf '%s\n' "$*"
}

run_with_timeout() {
  local seconds="$1"
  shift
  python3 - "$seconds" "$@" <<'PY'
import subprocess
import sys

timeout = int(sys.argv[1])
cmd = sys.argv[2:]

try:
    completed = subprocess.run(cmd, timeout=timeout)
    raise SystemExit(completed.returncode)
except subprocess.TimeoutExpired:
    raise SystemExit(124)
PY
}

realpath_py() {
  python3 - "$1" <<'PY'
import os
import sys
print(os.path.realpath(sys.argv[1]))
PY
}

read_local_package_version() {
  node -p "require('./package.json').version" 2>/dev/null || true
}

read_installed_version() {
  omx --version 2>/dev/null | awk '/oh-my-codex v/ { sub(/^.*v/, "", $0); print $0; exit }' || true
}

have_command() {
  command -v "$1" >/dev/null 2>&1
}

ROOT=""
REMOTE=""
FOLLOWUP_BRANCH=""
CHECK_ONLY=0
UPDATE_CLI=1
CURRENT_BRANCH=""
MAIN_REF=""
TARGET_REF=""
LATEST_TAG=""
REMOTE_URL=""
LOCAL_PACKAGE_VERSION=""
INSTALLED_VERSION=""
REMOTE_TAG_NAMESPACE="refs/upstream-sync/remote-tags"
HANDOFF_DIR=""
HANDOFF_PATH=""

SUMMARY_STATUS="failed"
SUMMARY_BRANCH="main"
SUMMARY_FOLLOWUP="none"
SUMMARY_TARGET="unknown"
SUMMARY_CLI="skipped"
SUMMARY_CONFLICTS="0"
SUMMARY_PRINTED=0
RELEASE_SUMMARY="none"

PROBE_MAIN_DIR=""
PROBE_MAIN_BRANCH=""
PROBE_FOLLOWUP_DIR=""
PROBE_FOLLOWUP_BRANCH=""
APPLY_MAIN_DIR=""
APPLY_MAIN_BRANCH=""
APPLY_FOLLOWUP_DIR=""

PRESERVE_PROBE_MAIN=0
PRESERVE_PROBE_FOLLOWUP=0
PRESERVE_APPLY_MAIN=0
PRESERVE_APPLY_FOLLOWUP=0

PROBLEMS=()

append_problem() {
  local message="$1"
  [[ -n "$message" ]] || return 0
  PROBLEMS+=("$message")
}

join_unique_array() {
  local separator="$1"
  shift || true
  if [[ $# -eq 0 ]]; then
    return 0
  fi

  printf '%s\n' "$@" | awk 'NF && !seen[$0]++ { items[++count]=$0 } END { for (i=1; i<=count; i++) printf "%s%s", items[i], (i<count ? sep : "") }' sep="$separator"
}

format_problems() {
  local joined=""

  if [[ ${#PROBLEMS[@]} -eq 0 ]]; then
    printf 'none'
    return 0
  fi

  joined=$(join_unique_array '; ' "${PROBLEMS[@]}")
  printf '%s' "${joined:-none}"
}

print_summary() {
  local problems_line=""
  if [[ "$SUMMARY_PRINTED" -eq 1 ]]; then
    return 0
  fi
  SUMMARY_PRINTED=1
  problems_line=$(format_problems)
  log "move: ${SUMMARY_STATUS} | branch=${SUMMARY_BRANCH} | followup=${SUMMARY_FOLLOWUP} | target=${SUMMARY_TARGET} | cli=${SUMMARY_CLI} | conflicts=${SUMMARY_CONFLICTS}"
  log "problems: ${problems_line}"
  log "releases: ${RELEASE_SUMMARY:-none}"
}

fail() {
  append_problem "$1"
  SUMMARY_STATUS="failed"
  print_summary
  exit 1
}

delete_branch_if_exists() {
  local branch="$1"
  [[ -n "$branch" ]] || return 0
  git show-ref --verify --quiet "refs/heads/$branch" || return 0
  git branch -D "$branch" >/dev/null 2>&1 || true
}

cleanup_worktree() {
  local dir="$1"
  local branch="$2"
  local preserve="$3"

  if [[ -n "$dir" && -d "$dir" && "$preserve" -eq 0 ]]; then
    git worktree remove --force "$dir" >/dev/null 2>&1 || rm -rf "$dir"
  fi

  if [[ -n "$branch" && "$preserve" -eq 0 ]]; then
    delete_branch_if_exists "$branch"
  fi
}

cleanup_probe_main() {
  cleanup_worktree "$PROBE_MAIN_DIR" "$PROBE_MAIN_BRANCH" "$PRESERVE_PROBE_MAIN"
}

cleanup_probe_followup() {
  cleanup_worktree "$PROBE_FOLLOWUP_DIR" "$PROBE_FOLLOWUP_BRANCH" "$PRESERVE_PROBE_FOLLOWUP"
}

cleanup_apply_main() {
  cleanup_worktree "$APPLY_MAIN_DIR" "$APPLY_MAIN_BRANCH" "$PRESERVE_APPLY_MAIN"
}

cleanup_apply_followup() {
  cleanup_worktree "$APPLY_FOLLOWUP_DIR" "" "$PRESERVE_APPLY_FOLLOWUP"
}

trap 'cleanup_apply_followup; cleanup_apply_main; cleanup_probe_followup; cleanup_probe_main' EXIT

select_remote() {
  if [[ -n "$REMOTE" ]]; then
    git remote get-url "$REMOTE" >/dev/null 2>&1 || fail "remote '$REMOTE' not found"
    printf '%s\n' "$REMOTE"
    return 0
  fi

  local candidate=""
  local url=""
  for candidate in upstream origin; do
    if url=$(git remote get-url "$candidate" 2>/dev/null); then
      if [[ "$url" == *Yeachan-Heo/oh-my-codex* ]]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    fi
  done

  if git remote get-url origin >/dev/null 2>&1; then
    printf 'origin\n'
    return 0
  fi

  candidate=$(git remote | head -1)
  [[ -n "$candidate" ]] || fail 'no git remotes configured'
  printf '%s\n' "$candidate"
}

ensure_clean_worktree() {
  local dir="$1"
  git -C "$dir" diff --quiet || return 1
  git -C "$dir" diff --cached --quiet || return 1
}

branch_checked_out_elsewhere() {
  local branch="$1"
  local current_realpath=""
  current_realpath=$(realpath_py "$ROOT")
  git worktree list --porcelain | awk -v branch="refs/heads/${branch}" -v current="$current_realpath" '
    /^worktree / { worktree=$2; next }
    /^branch / {
      if ($2 == branch && worktree != current) {
        print worktree
      }
    }
  ' | grep -q .
}

sanitize_for_branch() {
  printf '%s' "$1" | tr -cs 'A-Za-z0-9._-' '-' | sed 's/^-//; s/-$//'
}

count_conflicted_paths() {
  local dir="$1"
  git -C "$dir" diff --name-only --diff-filter=U | awk 'NF && !seen[$0]++ { count++ } END { print count+0 }'
}

collect_conflicted_paths() {
  local dir="$1"
  git -C "$dir" diff --name-only --diff-filter=U | awk 'NF && !seen[$0]++'
}

clear_handoff_record() {
  [[ -n "$HANDOFF_PATH" ]] || return 0
  rm -f "$HANDOFF_PATH"
}

write_handoff_record() {
  local operation="$1"
  local worktree_path="$2"
  local temp_branch="$3"
  local branch_name="$4"
  local conflict_scope="$5"
  local conflict_paths="$6"

  mkdir -p "$HANDOFF_DIR"
  HANDOFF_OPERATION="$operation" \
  HANDOFF_WORKTREE="$worktree_path" \
  HANDOFF_TEMP_BRANCH="$temp_branch" \
  HANDOFF_BRANCH_NAME="$branch_name" \
  HANDOFF_CONFLICT_SCOPE="$conflict_scope" \
  HANDOFF_CONFLICT_PATHS="$conflict_paths" \
  HANDOFF_TARGET_REF="$TARGET_REF" \
  HANDOFF_TARGET_TAG="$LATEST_TAG" \
  HANDOFF_CURRENT_BRANCH="$CURRENT_BRANCH" \
  HANDOFF_REMOTE="$REMOTE" \
  python3 - "$HANDOFF_PATH" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

payload = {
    "operation": os.environ.get("HANDOFF_OPERATION"),
    "worktree_path": os.environ.get("HANDOFF_WORKTREE"),
    "temp_branch": os.environ.get("HANDOFF_TEMP_BRANCH") or None,
    "branch_name": os.environ.get("HANDOFF_BRANCH_NAME") or None,
    "conflict_scope": os.environ.get("HANDOFF_CONFLICT_SCOPE"),
    "conflict_paths": [line for line in os.environ.get("HANDOFF_CONFLICT_PATHS", "").splitlines() if line],
    "target_ref": os.environ.get("HANDOFF_TARGET_REF"),
    "target_tag": os.environ.get("HANDOFF_TARGET_TAG"),
    "current_branch": os.environ.get("HANDOFF_CURRENT_BRANCH") or None,
    "remote": os.environ.get("HANDOFF_REMOTE"),
    "created_at": datetime.now(timezone.utc).isoformat(),
}

with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
}

record_conflict_handoff() {
  local operation="$1"
  local worktree_path="$2"
  local temp_branch="$3"
  local branch_name="$4"
  local conflict_scope="$5"
  local conflict_paths=""

  conflict_paths=$(collect_conflicted_paths "$worktree_path")
  write_handoff_record "$operation" "$worktree_path" "$temp_branch" "$branch_name" "$conflict_scope" "$conflict_paths"
}

validate_main_ready_for_apply() {
  if [[ "$CURRENT_BRANCH" == "main" ]]; then
    ensure_clean_worktree "$ROOT" || {
      append_problem "current main worktree is dirty"
      return 1
    }
    return 0
  fi

  if branch_checked_out_elsewhere "main"; then
    append_problem "local main is checked out in another worktree"
    return 1
  fi

  return 0
}

validate_followup_ready_for_apply() {
  [[ -n "$FOLLOWUP_BRANCH" ]] || return 0

  if [[ "$FOLLOWUP_BRANCH" == "main" ]]; then
    append_problem "--branch main is invalid; omit --branch to sync only local main"
    return 1
  fi

  if [[ "$CURRENT_BRANCH" == "$FOLLOWUP_BRANCH" ]]; then
    ensure_clean_worktree "$ROOT" || {
      append_problem "current branch '$FOLLOWUP_BRANCH' has local changes"
      return 1
    }
    return 0
  fi

  if branch_checked_out_elsewhere "$FOLLOWUP_BRANCH"; then
    append_problem "followup branch '$FOLLOWUP_BRANCH' is checked out in another worktree"
    return 1
  fi

  return 0
}

run_merge() {
  local dir="$1"
  local target_ref="$2"
  local stdout_file="$3"
  local stderr_file="$4"
  git -C "$dir" merge --no-edit "$target_ref" >"$stdout_file" 2>"$stderr_file"
}

run_rebase() {
  local dir="$1"
  local target_ref="$2"
  local stdout_file="$3"
  local stderr_file="$4"
  GIT_EDITOR=true git -C "$dir" rebase "$target_ref" >"$stdout_file" 2>"$stderr_file"
}

abort_merge_if_needed() {
  local dir="$1"
  git -C "$dir" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 || return 0
  git -C "$dir" merge --abort >/dev/null 2>&1 || true
}

abort_rebase_if_needed() {
  local dir="$1"
  local git_dir=""
  git_dir=$(git -C "$dir" rev-parse --git-dir 2>/dev/null) || return 0
  if [[ -d "$git_dir/rebase-merge" || -d "$git_dir/rebase-apply" ]]; then
    git -C "$dir" rebase --abort >/dev/null 2>&1 || true
  fi
}

have_remote_release_refs() {
  git for-each-ref --format='%(refname)' "${REMOTE_TAG_NAMESPACE}/v*" | grep -q .
}

refresh_remote_release_refs() {
  local remote="$1"

  if ! run_with_timeout 20 git fetch "$remote" --no-tags "+refs/heads/main:${MAIN_REF}" >/dev/null 2>&1; then
    append_problem "git fetch main from '$remote' timed out or failed; used cached main ref"
  fi

  if ! run_with_timeout 20 git fetch --prune "$remote" "+refs/tags/*:${REMOTE_TAG_NAMESPACE}/*" >/dev/null 2>&1; then
    append_problem "git fetch release tags from '$remote' timed out or failed; used cached release refs"
  fi
}

resolve_latest_release_ref() {
  git for-each-ref --merged="$MAIN_REF" --sort=-version:refname --format='%(refname)' "${REMOTE_TAG_NAMESPACE}/v*" | head -1
}

write_release_tags_file() {
  local tags_file="$1"

  if have_remote_release_refs; then
    git for-each-ref --sort=version:refname --format='%(refname)%09%(subject)' "${REMOTE_TAG_NAMESPACE}/v*" \
      | sed "s#^${REMOTE_TAG_NAMESPACE}/##" >"$tags_file"
    return 0
  fi

  git for-each-ref --sort=version:refname --format='%(refname:short)%09%(subject)' refs/tags >"$tags_file"
}

fetch_release_payload() {
  local repo="$1"
  [[ -n "$repo" ]] || return 1

  if [[ -n "${UPSTREAM_SYNC_RELEASES_JSON:-}" ]]; then
    printf '%s' "$UPSTREAM_SYNC_RELEASES_JSON"
    return 0
  fi

  if [[ -n "${UPSTREAM_SYNC_RELEASES_FILE:-}" && -f "${UPSTREAM_SYNC_RELEASES_FILE}" ]]; then
    cat "$UPSTREAM_SYNC_RELEASES_FILE"
    return 0
  fi

  if have_command gh; then
    run_with_timeout 20 env GH_PAGER=cat gh api "repos/${repo}/releases?per_page=20" 2>/dev/null && return 0
  fi

  if have_command curl; then
    run_with_timeout 20 curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/${repo}/releases?per_page=20" 2>/dev/null && return 0
  fi

  return 1
}

render_release_summary() {
  local repo="$1"
  local baseline_version="$2"
  local target_tag="$3"
  local payload_file=""
  local tags_file=""
  local payload=""

  tags_file=$(mktemp "${TMPDIR:-/tmp}/upstream-sync.tags.XXXXXX")
  write_release_tags_file "$tags_file"

  if payload=$(fetch_release_payload "$repo"); then
    payload_file=$(mktemp "${TMPDIR:-/tmp}/upstream-sync.releases.XXXXXX.json")
    printf '%s' "$payload" >"$payload_file"
  fi

  RELEASE_SUMMARY=$(BASELINE_VERSION="$baseline_version" TARGET_TAG="$target_tag" TAGS_FILE="$tags_file" PAYLOAD_FILE="${payload_file:-}" python3 - <<'PY'
import json
import os
import re


def parse_version(value: str):
    match = re.search(r"v?(\d+)\.(\d+)\.(\d+)", value or "")
    if not match:
        return None
    return tuple(int(match.group(i)) for i in range(1, 4))


def clean_summary(text: str, fallback: str) -> str:
    raw = (text or "").replace("\r\n", "\n").strip()
    if not raw:
        raw = fallback
    summary_match = re.search(r"(?ims)^##\s+Summary\s*$\n+(.*?)(?=^##\s+|\Z)", raw)
    if summary_match:
        raw = summary_match.group(1).strip().split("\n\n", 1)[0].strip()
    else:
        paragraphs = [part.strip() for part in re.split(r"\n\s*\n", raw) if part.strip()]
        raw = paragraphs[0] if paragraphs else fallback
    raw = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", raw)
    raw = re.sub(r"\s+", " ", raw.replace("`", " ")).strip(" -")
    if not raw:
        raw = fallback
    if len(raw) > 90:
        raw = (raw[:87].rsplit(" ", 1)[0] or raw[:87]).rstrip(" ,;:") + "…"
    return raw

baseline_raw = os.environ.get("BASELINE_VERSION", "")
target_tag = os.environ.get("TARGET_TAG", "")
tags_file = os.environ.get("TAGS_FILE", "")
payload_file = os.environ.get("PAYLOAD_FILE", "")

baseline_version = parse_version(baseline_raw)
target_version = parse_version(target_tag)

release_summaries = {}
if payload_file and os.path.exists(payload_file):
    try:
        with open(payload_file, "r", encoding="utf-8") as fh:
            for release in json.load(fh):
                if release.get("draft") or release.get("prerelease"):
                    continue
                tag = release.get("tag_name") or ""
                title = release.get("name") or tag or "release"
                release_summaries[tag] = clean_summary(release.get("body") or "", title)
    except Exception:
        release_summaries = {}

selected = []
with open(tags_file, "r", encoding="utf-8") as fh:
    for raw in fh:
        raw = raw.rstrip("\n")
        if not raw:
            continue
        parts = raw.split("\t", 1)
        tag = parts[0]
        subject = parts[1] if len(parts) > 1 else tag
        version = parse_version(tag)
        if target_version is not None and version is not None and version > target_version:
            continue
        if baseline_version is not None and version is not None and version <= baseline_version:
            continue
        if target_tag and tag != target_tag and target_version is None:
            continue
        selected.append((tag, clean_summary(release_summaries.get(tag, ""), subject)))

if not selected and target_tag:
    fallback = None
    with open(tags_file, "r", encoding="utf-8") as fh:
        for raw in fh:
            raw = raw.rstrip("\n")
            if not raw:
                continue
            parts = raw.split("\t", 1)
            if parts[0] == target_tag:
                fallback = clean_summary(release_summaries.get(parts[0], ""), parts[1] if len(parts) > 1 else parts[0])
                break
    if fallback and baseline_version is None:
        print(f"{target_tag} {fallback}")
    else:
        print("none")
    raise SystemExit(0)

if not selected:
    print("none")
    raise SystemExit(0)

shown = selected[-2:]
omitted = len(selected) - len(shown)
text = "; ".join(f"{tag} {summary}" for tag, summary in shown)
if omitted > 0:
    text = f"{text}; +{omitted} earlier release{'s' if omitted != 1 else ''}"
if len(text) > 240:
    text = (text[:237].rsplit(" ", 1)[0] or text[:237]).rstrip(" ,;:") + "…"
print(text)
PY
)

  rm -f "$tags_file"
  [[ -n "$payload_file" ]] && rm -f "$payload_file"
  [[ -n "$RELEASE_SUMMARY" ]] || RELEASE_SUMMARY='none'
}

refresh_local_linked_cli() {
  local root_realpath=""
  local global_root=""
  local linked_root=""
  local new_installed=""
  local build_stdout=""
  local build_stderr=""
  local link_stdout=""
  local link_stderr=""

  if [[ "$UPDATE_CLI" -eq 0 ]]; then
    SUMMARY_CLI='skipped'
    return 0
  fi

  if [[ "$CURRENT_BRANCH" != "main" ]]; then
    SUMMARY_CLI='skipped'
    return 0
  fi

  root_realpath=$(realpath_py "$ROOT")
  build_stdout=$(mktemp "${TMPDIR:-/tmp}/upstream-sync.build.stdout.XXXXXX")
  build_stderr=$(mktemp "${TMPDIR:-/tmp}/upstream-sync.build.stderr.XXXXXX")
  link_stdout=$(mktemp "${TMPDIR:-/tmp}/upstream-sync.link.stdout.XXXXXX")
  link_stderr=$(mktemp "${TMPDIR:-/tmp}/upstream-sync.link.stderr.XXXXXX")

  if ! npm run build >"$build_stdout" 2>"$build_stderr"; then
    SUMMARY_CLI='failed'
    append_problem 'npm run build failed'
    rm -f "$build_stdout" "$build_stderr" "$link_stdout" "$link_stderr"
    return 1
  fi

  if ! npm link >"$link_stdout" 2>"$link_stderr"; then
    SUMMARY_CLI='failed'
    append_problem 'npm link failed'
    rm -f "$build_stdout" "$build_stderr" "$link_stdout" "$link_stderr"
    return 1
  fi

  global_root=$(npm root -g 2>/dev/null || true)
  if [[ -n "$global_root" && -e "$global_root/oh-my-codex" ]]; then
    linked_root=$(realpath_py "$global_root/oh-my-codex")
  fi
  new_installed=$(read_installed_version)

  if [[ -n "$linked_root" && "$linked_root" != "$root_realpath" ]]; then
    SUMMARY_CLI='failed'
    append_problem 'global CLI did not relink to this repo'
    rm -f "$build_stdout" "$build_stderr" "$link_stdout" "$link_stderr"
    return 1
  fi

  SUMMARY_CLI='linked'
  if [[ -z "$new_installed" ]]; then
    append_problem 'linked CLI version could not be read'
  fi

  rm -f "$build_stdout" "$build_stderr" "$link_stdout" "$link_stderr"
  return 0
}

run_probe_main_merge() {
  local stdout_file="$1"
  local stderr_file="$2"
  PROBE_MAIN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/upstream-sync.probe.main.XXXXXX")
  PROBE_MAIN_BRANCH="upstream-sync-probe-main-$(sanitize_for_branch "${LATEST_TAG}")-$$"
  git worktree add -b "$PROBE_MAIN_BRANCH" "$PROBE_MAIN_DIR" main >/dev/null 2>&1 || fail 'probe main worktree setup failed'
  run_merge "$PROBE_MAIN_DIR" "$TARGET_REF" "$stdout_file" "$stderr_file"
}

run_probe_followup_rebase() {
  local stdout_file="$1"
  local stderr_file="$2"
  [[ -n "$FOLLOWUP_BRANCH" && "$FOLLOWUP_BRANCH" != "main" ]] || return 0
  PROBE_FOLLOWUP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/upstream-sync.probe.followup.XXXXXX")
  PROBE_FOLLOWUP_BRANCH="upstream-sync-probe-$(sanitize_for_branch "${FOLLOWUP_BRANCH}")-$$"
  git worktree add -b "$PROBE_FOLLOWUP_BRANCH" "$PROBE_FOLLOWUP_DIR" "$FOLLOWUP_BRANCH" >/dev/null 2>&1 || fail "probe followup worktree setup failed for '$FOLLOWUP_BRANCH'"
  run_rebase "$PROBE_FOLLOWUP_DIR" "$PROBE_MAIN_BRANCH" "$stdout_file" "$stderr_file"
}

fast_forward_main_to_ref() {
  local target_ref="$1"

  if [[ "$CURRENT_BRANCH" == "main" ]]; then
    ensure_clean_worktree "$ROOT" || {
      append_problem "current main worktree is dirty"
      return 1
    }
    git merge --ff-only "$target_ref" >/dev/null 2>&1 || {
      append_problem "failed to fast-forward local main"
      return 1
    }
    return 0
  fi

  if branch_checked_out_elsewhere "main"; then
    append_problem "local main is checked out in another worktree"
    return 1
  fi

  git update-ref refs/heads/main "$(git rev-parse "$target_ref")" || {
    append_problem "failed to update local main"
    return 1
  }
}

run_apply_main_merge() {
  local stdout_file="$1"
  local stderr_file="$2"

  APPLY_MAIN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/upstream-sync.apply.main.XXXXXX")
  APPLY_MAIN_BRANCH="upstream-sync-main-$(sanitize_for_branch "${LATEST_TAG}")-$$"
  git worktree add -b "$APPLY_MAIN_BRANCH" "$APPLY_MAIN_DIR" main >/dev/null 2>&1 || {
    append_problem 'main apply worktree setup failed'
    return 1
  }

  if ! run_merge "$APPLY_MAIN_DIR" "$TARGET_REF" "$stdout_file" "$stderr_file"; then
    SUMMARY_CONFLICTS="$(count_conflicted_paths "$APPLY_MAIN_DIR")(main)"
    append_problem "main merge conflict left in $APPLY_MAIN_DIR on branch $APPLY_MAIN_BRANCH; continue there with an agent"
    PRESERVE_APPLY_MAIN=1
    return 1
  fi

  if ! fast_forward_main_to_ref "$APPLY_MAIN_BRANCH"; then
    PRESERVE_APPLY_MAIN=1
    return 1
  fi

  return 0
}

run_apply_followup_rebase() {
  local stdout_file="$1"
  local stderr_file="$2"
  [[ -n "$FOLLOWUP_BRANCH" && "$FOLLOWUP_BRANCH" != "main" ]] || return 0

  if [[ "$CURRENT_BRANCH" == "$FOLLOWUP_BRANCH" ]]; then
    ensure_clean_worktree "$ROOT" || {
      append_problem "current branch '$FOLLOWUP_BRANCH' has local changes"
      return 1
    }
    if ! run_rebase "$ROOT" main "$stdout_file" "$stderr_file"; then
      SUMMARY_CONFLICTS="$(count_conflicted_paths "$ROOT")(followup)"
      append_problem "followup rebase conflict on current branch '$FOLLOWUP_BRANCH'; resolve in $ROOT and continue the rebase with an agent"
      return 1
    fi
    return 0
  fi

  if branch_checked_out_elsewhere "$FOLLOWUP_BRANCH"; then
    append_problem "followup branch '$FOLLOWUP_BRANCH' is checked out in another worktree"
    return 1
  fi

  APPLY_FOLLOWUP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/upstream-sync.apply.followup.XXXXXX")
  git worktree add "$APPLY_FOLLOWUP_DIR" "$FOLLOWUP_BRANCH" >/dev/null 2>&1 || {
    append_problem "followup worktree setup failed for '$FOLLOWUP_BRANCH'"
    return 1
  }

  if ! run_rebase "$APPLY_FOLLOWUP_DIR" main "$stdout_file" "$stderr_file"; then
    SUMMARY_CONFLICTS="$(count_conflicted_paths "$APPLY_FOLLOWUP_DIR")(followup)"
    append_problem "followup rebase conflict left in $APPLY_FOLLOWUP_DIR for '$FOLLOWUP_BRANCH'; continue there with an agent"
    PRESERVE_APPLY_FOLLOWUP=1
    return 1
  fi

  return 0
}

main() {
  local probe_main_stdout=""
  local probe_main_stderr=""
  local probe_followup_stdout=""
  local probe_followup_stderr=""
  local apply_main_stdout=""
  local apply_main_stderr=""
  local apply_followup_stdout=""
  local apply_followup_stderr=""
  local github_repo=""
  local probe_main_ok=1
  local probe_followup_ok=1
  local main_preflight_ok=1
  local followup_preflight_ok=1

  ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || fail 'run this inside the oh-my-codex git repository'
  cd "$ROOT"
  export GIT_TERMINAL_PROMPT=0
  HANDOFF_DIR="$ROOT/.omx/state/upstream-sync"
  HANDOFF_PATH="$HANDOFF_DIR/last-handoff.json"
  clear_handoff_record

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --branch)
        [[ $# -ge 2 ]] || fail '--branch requires a value'
        FOLLOWUP_BRANCH="$2"
        shift 2
        ;;
      --remote)
        [[ $# -ge 2 ]] || fail '--remote requires a value'
        REMOTE="$2"
        shift 2
        ;;
      --check-only)
        CHECK_ONLY=1
        shift
        ;;
      --no-cli-update)
        UPDATE_CLI=0
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

  REMOTE=$(select_remote)
  MAIN_REF="refs/remotes/${REMOTE}/main"
  CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || true)
  LOCAL_PACKAGE_VERSION=$(read_local_package_version)
  INSTALLED_VERSION=$(read_installed_version)

  refresh_remote_release_refs "$REMOTE"

  git show-ref --verify --quiet "$MAIN_REF" || fail "remote '$REMOTE' does not expose main"
  git show-ref --verify --quiet refs/heads/main || fail 'local main branch not found'

  if [[ -n "$FOLLOWUP_BRANCH" ]]; then
    git show-ref --verify --quiet "refs/heads/$FOLLOWUP_BRANCH" || fail "branch '$FOLLOWUP_BRANCH' not found"
  fi

  REMOTE_URL=$(git remote get-url "$REMOTE")
  if [[ "$REMOTE_URL" =~ github\.com[:/]([^/]+/[^/.]+)(\.git)?$ ]]; then
    github_repo="${BASH_REMATCH[1]}"
  fi

  TARGET_REF=$(resolve_latest_release_ref)
  if [[ -n "$TARGET_REF" ]]; then
    LATEST_TAG="${TARGET_REF#${REMOTE_TAG_NAMESPACE}/}"
  else
    if have_remote_release_refs; then
      fail "no release tags merged into ${REMOTE}/main"
    fi
    append_problem "remote release refs unavailable; used local tags"
    LATEST_TAG=$(git tag --merged "$MAIN_REF" --sort=-version:refname 'v*' | head -1)
    TARGET_REF="$LATEST_TAG"
  fi
  [[ -n "$LATEST_TAG" ]] || fail "no release tags merged into ${REMOTE}/main"
  SUMMARY_TARGET="release ${LATEST_TAG}"

  render_release_summary "$github_repo" "${LOCAL_PACKAGE_VERSION:-$INSTALLED_VERSION}" "$LATEST_TAG"

  if ! validate_main_ready_for_apply; then
    main_preflight_ok=0
  fi

  if ! validate_followup_ready_for_apply; then
    followup_preflight_ok=0
  fi

  if [[ "$main_preflight_ok" -ne 1 || "$followup_preflight_ok" -ne 1 ]]; then
    SUMMARY_STATUS='failed'
    if [[ -n "$FOLLOWUP_BRANCH" && "$FOLLOWUP_BRANCH" != "main" ]]; then
      SUMMARY_FOLLOWUP="${FOLLOWUP_BRANCH}(blocked)"
    fi
    SUMMARY_CLI='skipped'
    print_summary
    exit 1
  fi

  probe_main_stdout=$(mktemp "${TMPDIR:-/tmp}/upstream-sync.probe.main.stdout.XXXXXX")
  probe_main_stderr=$(mktemp "${TMPDIR:-/tmp}/upstream-sync.probe.main.stderr.XXXXXX")
  if ! run_probe_main_merge "$probe_main_stdout" "$probe_main_stderr"; then
    probe_main_ok=0
  fi

  if [[ -n "$FOLLOWUP_BRANCH" && "$FOLLOWUP_BRANCH" != "main" ]]; then
    probe_followup_stdout=$(mktemp "${TMPDIR:-/tmp}/upstream-sync.probe.followup.stdout.XXXXXX")
    probe_followup_stderr=$(mktemp "${TMPDIR:-/tmp}/upstream-sync.probe.followup.stderr.XXXXXX")
    if ! run_probe_followup_rebase "$probe_followup_stdout" "$probe_followup_stderr"; then
      probe_followup_ok=0
    fi
  fi

  if (( CHECK_ONLY )); then
    if [[ "$probe_main_ok" -ne 1 ]]; then
      append_problem 'probe main merge failed'
      SUMMARY_STATUS='failed'
      SUMMARY_CLI='skipped'
      print_summary
      exit 1
    fi
    if [[ -n "$FOLLOWUP_BRANCH" && "$FOLLOWUP_BRANCH" != "main" && "$probe_followup_ok" -ne 1 ]]; then
      append_problem "probe followup rebase failed for '$FOLLOWUP_BRANCH'"
      SUMMARY_STATUS='failed'
      SUMMARY_FOLLOWUP="${FOLLOWUP_BRANCH}(probe-failed)"
      SUMMARY_CLI='skipped'
      print_summary
      exit 1
    fi
    SUMMARY_STATUS='dry-run'
    SUMMARY_CLI='skipped'
    if [[ -n "$FOLLOWUP_BRANCH" && "$FOLLOWUP_BRANCH" != "main" ]]; then
      SUMMARY_FOLLOWUP="${FOLLOWUP_BRANCH}(probed)"
    fi
    print_summary
    exit 0
  fi

  if [[ "$probe_main_ok" -ne 1 ]]; then
    if [[ "$(count_conflicted_paths "$PROBE_MAIN_DIR")" -gt 0 ]]; then
      SUMMARY_CONFLICTS="$(count_conflicted_paths "$PROBE_MAIN_DIR")(main)"
      PRESERVE_PROBE_MAIN=1
      record_conflict_handoff "probe-main-merge-conflict" "$PROBE_MAIN_DIR" "$PROBE_MAIN_BRANCH" "main" "main"
      append_problem "main merge conflict; handoff=${HANDOFF_PATH#$ROOT/}"
    else
      append_problem 'probe main merge failed'
    fi
    SUMMARY_STATUS='failed'
    SUMMARY_CLI='skipped'
    print_summary
    exit 1
  fi

  if [[ -n "$FOLLOWUP_BRANCH" && "$FOLLOWUP_BRANCH" != "main" && "$probe_followup_ok" -ne 1 ]]; then
    if [[ "$(count_conflicted_paths "$PROBE_FOLLOWUP_DIR")" -gt 0 ]]; then
      SUMMARY_CONFLICTS="$(count_conflicted_paths "$PROBE_FOLLOWUP_DIR")(followup)"
      PRESERVE_PROBE_FOLLOWUP=1
      record_conflict_handoff "probe-followup-rebase-conflict" "$PROBE_FOLLOWUP_DIR" "$PROBE_FOLLOWUP_BRANCH" "$FOLLOWUP_BRANCH" "followup"
      append_problem "followup rebase conflict; handoff=${HANDOFF_PATH#$ROOT/}"
    else
      append_problem "probe followup rebase failed for '$FOLLOWUP_BRANCH'"
    fi
    SUMMARY_STATUS='failed'
    SUMMARY_FOLLOWUP="${FOLLOWUP_BRANCH}(probe-failed)"
    SUMMARY_CLI='skipped'
    print_summary
    exit 1
  fi

  apply_main_stdout=$(mktemp "${TMPDIR:-/tmp}/upstream-sync.apply.main.stdout.XXXXXX")
  apply_main_stderr=$(mktemp "${TMPDIR:-/tmp}/upstream-sync.apply.main.stderr.XXXXXX")
  if ! run_apply_main_merge "$apply_main_stdout" "$apply_main_stderr"; then
    if [[ "$PRESERVE_APPLY_MAIN" -eq 1 ]]; then
      record_conflict_handoff "apply-main-merge-conflict" "$APPLY_MAIN_DIR" "$APPLY_MAIN_BRANCH" "main" "main"
      append_problem "main merge conflict; handoff=${HANDOFF_PATH#$ROOT/}"
    fi
    SUMMARY_STATUS='failed'
    SUMMARY_CLI='skipped'
    print_summary
    exit 1
  fi

  if [[ -n "$FOLLOWUP_BRANCH" && "$FOLLOWUP_BRANCH" != "main" ]]; then
    apply_followup_stdout=$(mktemp "${TMPDIR:-/tmp}/upstream-sync.apply.followup.stdout.XXXXXX")
    apply_followup_stderr=$(mktemp "${TMPDIR:-/tmp}/upstream-sync.apply.followup.stderr.XXXXXX")
    if ! run_apply_followup_rebase "$apply_followup_stdout" "$apply_followup_stderr"; then
      if [[ "$PRESERVE_APPLY_FOLLOWUP" -eq 1 ]]; then
        record_conflict_handoff "apply-followup-rebase-conflict" "$APPLY_FOLLOWUP_DIR" "" "$FOLLOWUP_BRANCH" "followup"
        append_problem "followup rebase conflict; handoff=${HANDOFF_PATH#$ROOT/}"
      elif [[ "$CURRENT_BRANCH" == "$FOLLOWUP_BRANCH" && "$(count_conflicted_paths "$ROOT")" -gt 0 ]]; then
        record_conflict_handoff "apply-followup-current-branch-rebase-conflict" "$ROOT" "" "$FOLLOWUP_BRANCH" "followup"
        append_problem "followup rebase conflict in current checkout; handoff=${HANDOFF_PATH#$ROOT/}"
      fi
      SUMMARY_STATUS='partial'
      SUMMARY_FOLLOWUP="${FOLLOWUP_BRANCH}(conflict)"
      SUMMARY_CLI='skipped'
      print_summary
      exit 1
    fi
    SUMMARY_FOLLOWUP="${FOLLOWUP_BRANCH}(rebased)"
  fi

  refresh_local_linked_cli || {
    SUMMARY_STATUS='failed'
    print_summary
    exit 1
  }

  SUMMARY_STATUS='ok'
  print_summary
}

main "$@"
