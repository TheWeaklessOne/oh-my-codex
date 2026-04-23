#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: sync.sh [--branch <name>] [--remote <name>] [--check-only] [--no-cli-update]

Syncs the selected local work branch onto the current upstream release state, auto-resolves
rebase conflicts in favor of the current work where possible, relinks the repo-backed CLI,
and finishes with a short three-line report.
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
BRANCH=""
REMOTE=""
CHECK_ONLY=0
UPDATE_CLI=1
CURRENT_BRANCH=""
MAIN_REF=""
SUMMARY_STATUS="failed"
SUMMARY_BRANCH="unknown"
SUMMARY_TARGET="unknown"
SUMMARY_CLI="skipped"
SUMMARY_CONFLICTS="0"
LATEST_TAG=""
TARGET_REF=""
LOCAL_PACKAGE_VERSION=""
INSTALLED_VERSION=""
REMOTE_URL=""
RELEASE_SUMMARY="none"
FETCH_WARNING=""
REMOTE_TAG_NAMESPACE="refs/upstream-sync/remote-tags"
PROBE_DIR=""
APPLY_DIR=""
PRESERVE_PROBE_DIR=0
PRESERVE_APPLY_DIR=0
AUTO_RESOLVED_FILES=()
PROBLEMS=()
SUMMARY_PRINTED=0

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
  local auto_summary=""
  local joined=""

  if [[ ${#AUTO_RESOLVED_FILES[@]} -gt 0 ]]; then
    auto_summary=$(join_unique_array ', ' "${AUTO_RESOLVED_FILES[@]}")
    [[ -n "$auto_summary" ]] && PROBLEMS+=("auto-resolved $auto_summary")
  fi

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
  log "move: ${SUMMARY_STATUS} | branch=${SUMMARY_BRANCH} | target=${SUMMARY_TARGET} | cli=${SUMMARY_CLI} | conflicts=${SUMMARY_CONFLICTS}"
  log "problems: ${problems_line}"
  log "releases: ${RELEASE_SUMMARY:-none}"
}

fail() {
  append_problem "$1"
  SUMMARY_STATUS="failed"
  print_summary
  exit 1
}

cleanup_probe() {
  if [[ -n "$PROBE_DIR" && -d "$PROBE_DIR" && "$PRESERVE_PROBE_DIR" -eq 0 ]]; then
    git worktree remove --force "$PROBE_DIR" >/dev/null 2>&1 || rm -rf "$PROBE_DIR"
  fi
}

cleanup_apply() {
  if [[ -n "$APPLY_DIR" && -d "$APPLY_DIR" && "$PRESERVE_APPLY_DIR" -eq 0 ]]; then
    git worktree remove --force "$APPLY_DIR" >/dev/null 2>&1 || rm -rf "$APPLY_DIR"
  fi
}

trap 'cleanup_apply; cleanup_probe' EXIT

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

rebase_in_progress() {
  local dir="$1"
  local git_dir=""
  git_dir=$(git -C "$dir" rev-parse --git-dir 2>/dev/null) || return 1
  [[ -d "$git_dir/rebase-merge" || -d "$git_dir/rebase-apply" ]]
}

ensure_clean_current_branch() {
  if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
    return 0
  fi
  git diff --quiet || fail "current branch '$BRANCH' has unstaged changes"
  git diff --cached --quiet || fail "current branch '$BRANCH' has staged changes"
}

resolve_conflict_preferring_local() {
  local dir="$1"
  local path="$2"
  local stages=""

  stages=$(git -C "$dir" ls-files -u -- "$path" | awk '{print $3}' | sort -u | tr '\n' ' ')
  [[ -n "$stages" ]] || return 1

  if printf ' %s ' "$stages" | grep -q ' 3 '; then
    git -C "$dir" checkout --theirs -- "$path" >/dev/null 2>&1 || return 1
    git -C "$dir" add -- "$path" >/dev/null 2>&1 || return 1
  else
    git -C "$dir" rm --quiet --ignore-unmatch -- "$path" >/dev/null 2>&1 || return 1
  fi

  AUTO_RESOLVED_FILES+=("$path")
  return 0
}

continue_rebase_until_done() {
  local dir="$1"
  local stdout_file="$2"
  local stderr_file="$3"
  local unresolved_found=0
  local path=""

  while rebase_in_progress "$dir"; do
    unresolved_found=0
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      unresolved_found=1
      resolve_conflict_preferring_local "$dir" "$path" || return 1
    done < <(git -C "$dir" diff --name-only --diff-filter=U)

    if [[ "$unresolved_found" -eq 1 ]]; then
      if GIT_EDITOR=true git -C "$dir" rebase --continue >"$stdout_file" 2>"$stderr_file"; then
        continue
      fi
      if rebase_in_progress "$dir"; then
        continue
      fi
      return 1
    fi

    if GIT_EDITOR=true git -C "$dir" rebase --continue >"$stdout_file" 2>"$stderr_file"; then
      continue
    fi

    if ! rebase_in_progress "$dir"; then
      break
    fi

    if git -C "$dir" diff --name-only --diff-filter=U | grep -q .; then
      continue
    fi

    if GIT_EDITOR=true git -C "$dir" rebase --skip >"$stdout_file" 2>"$stderr_file"; then
      continue
    fi

    return 1
  done

  return 0
}

run_rebase_with_autofix() {
  local dir="$1"
  local target_ref="$2"
  local stdout_file="$3"
  local stderr_file="$4"

  if git -C "$dir" rebase -X theirs "$target_ref" >"$stdout_file" 2>"$stderr_file"; then
    return 0
  fi

  rebase_in_progress "$dir" || return 1
  continue_rebase_until_done "$dir" "$stdout_file" "$stderr_file" || return 1
  rebase_in_progress "$dir" && return 1
  return 0
}

abort_rebase_if_needed() {
  local dir="$1"
  if rebase_in_progress "$dir"; then
    git -C "$dir" rebase --abort >/dev/null 2>&1 || true
  fi
}

sync_local_main_branch() {
  local main_ahead=0
  local main_behind=0
  local main_sync_dir=""

  git show-ref --verify --quiet refs/heads/main || return 0
  read -r main_ahead main_behind < <(git rev-list --left-right --count "main...$MAIN_REF")

  if [[ "$main_behind" -eq 0 ]]; then
    return 0
  fi

  if [[ "$main_ahead" -gt 0 ]]; then
    append_problem 'local main diverged; left unchanged'
    return 0
  fi

  if [[ "$CURRENT_BRANCH" == 'main' ]]; then
    git diff --quiet || { append_problem "local main dirty; left unchanged"; return 0; }
    git diff --cached --quiet || { append_problem "local main dirty; left unchanged"; return 0; }
    git merge --ff-only "$MAIN_REF" >/dev/null 2>&1 || { append_problem 'local main fast-forward failed'; return 0; }
    return 0
  fi

  if git worktree list --porcelain | awk '/^branch /{print $2}' | grep -qx 'refs/heads/main'; then
    append_problem 'local main checked out elsewhere; left unchanged'
    return 0
  fi

  main_sync_dir=$(mktemp -d "${TMPDIR:-/tmp}/upstream-sync.main.XXXXXX")
  git worktree add "$main_sync_dir" main >/dev/null 2>&1 || { append_problem 'local main worktree setup failed'; rm -rf "$main_sync_dir"; return 0; }
  if ! (cd "$main_sync_dir" && git merge --ff-only "$MAIN_REF" >/dev/null 2>&1); then
    append_problem 'local main fast-forward failed'
  fi
  git worktree remove --force "$main_sync_dir" >/dev/null 2>&1 || rm -rf "$main_sync_dir"
}

have_remote_release_refs() {
  git for-each-ref --format='%(refname)' "${REMOTE_TAG_NAMESPACE}/v*" | grep -q .
}

refresh_remote_release_refs() {
  local remote="$1"

  if ! run_with_timeout 20 git fetch "$remote" --no-tags "+refs/heads/main:${MAIN_REF}" >/dev/null 2>&1; then
    FETCH_WARNING="git fetch main from '$remote' timed out or failed; used cached main ref"
    append_problem "$FETCH_WARNING"
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

print("; ".join(f"{tag} {summary}" for tag, summary in selected))
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

  if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
    SUMMARY_CLI='skipped'
    append_problem "cli relink skipped; branch '$BRANCH' is not the current checkout"
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

run_probe() {
  local stdout_file="$1"
  local stderr_file="$2"
  PROBE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/upstream-sync.probe.XXXXXX")
  git worktree add --detach "$PROBE_DIR" "$BRANCH" >/dev/null 2>&1 || fail 'probe worktree setup failed'
  run_rebase_with_autofix "$PROBE_DIR" "$TARGET_REF" "$stdout_file" "$stderr_file"
}

run_apply() {
  local stdout_file="$1"
  local stderr_file="$2"

  if [[ "$CURRENT_BRANCH" == "$BRANCH" ]]; then
    ensure_clean_current_branch
    run_rebase_with_autofix "$ROOT" "$TARGET_REF" "$stdout_file" "$stderr_file" || {
      abort_rebase_if_needed "$ROOT"
      return 1
    }
    return 0
  fi

  if git worktree list --porcelain | awk '/^branch /{print $2}' | grep -qx "refs/heads/$BRANCH"; then
    append_problem "branch '$BRANCH' is checked out in another worktree"
    return 1
  fi

  APPLY_DIR=$(mktemp -d "${TMPDIR:-/tmp}/upstream-sync.apply.XXXXXX")
  git worktree add "$APPLY_DIR" "$BRANCH" >/dev/null 2>&1 || {
    append_problem 'apply worktree setup failed'
    return 1
  }

  if ! run_rebase_with_autofix "$APPLY_DIR" "$TARGET_REF" "$stdout_file" "$stderr_file"; then
    abort_rebase_if_needed "$APPLY_DIR"
    return 1
  fi

  cleanup_apply
  APPLY_DIR=""
  return 0
}

main() {
  local probe_stdout=""
  local probe_stderr=""
  local apply_stdout=""
  local apply_stderr=""
  local github_repo=""
  local path_count="0"

  ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || fail 'run this inside the oh-my-codex git repository'
  cd "$ROOT"
  export GIT_TERMINAL_PROMPT=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --branch)
        [[ $# -ge 2 ]] || fail '--branch requires a value'
        BRANCH="$2"
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

  if [[ -z "$BRANCH" ]]; then
    if [[ -n "$CURRENT_BRANCH" && "$CURRENT_BRANCH" != 'main' ]]; then
      BRANCH="$CURRENT_BRANCH"
    else
      BRANCH=$(git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads | awk '$0 != "main" { print; exit }')
    fi
  fi
  [[ -n "$BRANCH" ]] || fail 'no local non-main branch found'
  git show-ref --verify --quiet "refs/heads/$BRANCH" || fail "branch '$BRANCH' not found"
  SUMMARY_BRANCH="$BRANCH"

  render_release_summary "$github_repo" "${LOCAL_PACKAGE_VERSION:-$INSTALLED_VERSION}" "$LATEST_TAG"

  probe_stdout=$(mktemp "${TMPDIR:-/tmp}/upstream-sync.probe.stdout.XXXXXX")
  probe_stderr=$(mktemp "${TMPDIR:-/tmp}/upstream-sync.probe.stderr.XXXXXX")
  if ! run_probe "$probe_stdout" "$probe_stderr"; then
    append_problem 'probe rebase failed'
    SUMMARY_STATUS='failed'
    SUMMARY_CLI='skipped'
    abort_rebase_if_needed "$PROBE_DIR"
    print_summary
    exit 1
  fi

  if (( CHECK_ONLY )); then
    SUMMARY_STATUS='dry-run'
    SUMMARY_CLI='skipped'
    SUMMARY_CONFLICTS='0'
    print_summary
    exit 0
  fi

  sync_local_main_branch

  apply_stdout=$(mktemp "${TMPDIR:-/tmp}/upstream-sync.apply.stdout.XXXXXX")
  apply_stderr=$(mktemp "${TMPDIR:-/tmp}/upstream-sync.apply.stderr.XXXXXX")
  if ! run_apply "$apply_stdout" "$apply_stderr"; then
    SUMMARY_STATUS='failed'
    SUMMARY_CLI='skipped'
    path_count=$(printf '%s\n' "${AUTO_RESOLVED_FILES[@]:-}" | awk 'NF && !seen[$0]++ { count++ } END { print count+0 }')
    SUMMARY_CONFLICTS="${path_count}(auto)"
    print_summary
    exit 1
  fi

  path_count=$(printf '%s\n' "${AUTO_RESOLVED_FILES[@]:-}" | awk 'NF && !seen[$0]++ { count++ } END { print count+0 }')
  if [[ "$path_count" -gt 0 ]]; then
    SUMMARY_CONFLICTS="${path_count}(auto)"
  else
    SUMMARY_CONFLICTS='0'
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
