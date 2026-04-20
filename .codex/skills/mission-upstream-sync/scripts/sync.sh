#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: sync.sh [--branch <name>] [--remote <name>] [--check-only] [--no-cli-update]

Checks upstream OMX release state, probes and rebases the freshest mission branch onto upstream main,
and refreshes the local repo-linked CLI from the current checkout. Conflict resolution is intentionally
left to the invoking agent instead of scripted auto-resolution.
USAGE
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '%s\n' "$*"
}

have_command() {
  command -v "$1" >/dev/null 2>&1
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

rebase_in_progress() {
  local dir="$1"
  local git_dir=""
  git_dir=$(git -C "$dir" rev-parse --git-dir 2>/dev/null) || return 1
  [[ -d "$git_dir/rebase-merge" || -d "$git_dir/rebase-apply" ]]
}

collect_conflict_files() {
  local dir="$1"
  REBASE_CONFLICT_FILES=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && REBASE_CONFLICT_FILES+=("$line")
  done < <(git -C "$dir" diff --name-only --diff-filter=U)
}

report_conflicts() {
  local label="$1"
  local dir="$2"
  local stderr_file="$3"

  collect_conflict_files "$dir"
  log "$label result:      conflict"
  if [[ ${#REBASE_CONFLICT_FILES[@]} -gt 0 ]]; then
    log 'Conflicts:'
    for path in "${REBASE_CONFLICT_FILES[@]}"; do
      log "  - $path"
    done
  fi
  log 'git status --short:'
  git -C "$dir" status --short | sed 's/^/  /'
  log 'stderr tail:'
  tail -20 "$stderr_file" | sed 's/^/  /'
}

report_rebase_success() {
  local label="$1"
  local dir="$2"
  local head_sha=""

  head_sha=$(git -C "$dir" rev-parse --short HEAD)
  log "$label result:      clean"
  log "$label HEAD:        $head_sha"
}

sync_local_main_branch() {
  local main_ahead=0
  local main_behind=0
  local main_sync_dir=""

  git show-ref --verify --quiet refs/heads/main || return 0
  read -r main_ahead main_behind < <(git rev-list --left-right --count "main...$MAIN_REF")

  log ''
  log '==> Local main branch'
  log "Ahead of ${REMOTE}/main:  $main_ahead"
  log "Behind ${REMOTE}/main: $main_behind"

  if [[ "$main_behind" -eq 0 ]]; then
    log 'Local main already includes the selected remote main.'
    return 0
  fi

  if [[ "$main_ahead" -gt 0 ]]; then
    log 'Local main diverges from the selected remote main; leaving it untouched.'
    return 0
  fi

  if [[ "$CURRENT_BRANCH" == "main" ]]; then
    git diff --quiet || die "current branch 'main' has unstaged changes; clean it first or rerun with --check-only"
    git diff --cached --quiet || die "current branch 'main' has staged changes; clean it first or rerun with --check-only"
    git merge --ff-only "$MAIN_REF" >/dev/null
    log "Fast-forwarded local main to ${REMOTE}/main"
    return 0
  fi

  if git worktree list --porcelain | awk '/^branch /{print $2}' | grep -qx 'refs/heads/main'; then
    log 'Local main is checked out in another worktree; leaving it untouched there.'
    return 0
  fi

  main_sync_dir=$(mktemp -d "${TMPDIR:-/tmp}/mission-upstream-sync.main.XXXXXX")
  git worktree add "$main_sync_dir" main >/dev/null
  (
    cd "$main_sync_dir"
    git merge --ff-only "$MAIN_REF" >/dev/null
  )
  git worktree remove --force "$main_sync_dir" >/dev/null 2>&1 || rm -rf "$main_sync_dir"
  log "Fast-forwarded local main to ${REMOTE}/main in a temporary worktree"
}

refresh_local_linked_cli() {
  local root_realpath=""
  local global_root=""
  local linked_root=""
  local new_installed=""

  if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
    log ''
    log '==> Local CLI sync'
    log "Skipping relink:    target branch '$BRANCH' is not the current checkout '$CURRENT_BRANCH'."
    log 'Linked CLI follows the repo root checkout; switch to the rebased branch and rerun if needed.'
    return 0
  fi

  root_realpath=$(realpath_py "$ROOT")
  LOCAL_PACKAGE_VERSION=$(read_local_package_version)

  log ''
  log '==> Local CLI sync'
  log "Repo package.json:  ${LOCAL_PACKAGE_VERSION:-unknown}"

  npm run build
  npm link

  global_root=$(npm root -g 2>/dev/null || true)
  if [[ -n "$global_root" && -e "$global_root/oh-my-codex" ]]; then
    linked_root=$(realpath_py "$global_root/oh-my-codex")
  fi
  new_installed=$(read_installed_version)

  log "Linked CLI root:    ${linked_root:-unknown}"
  if [[ -n "$linked_root" && "$linked_root" != "$root_realpath" ]]; then
    log 'Link warning:       npm link did not point the global package back at this repo root'
  fi
  log "omx --version:      ${new_installed:-unknown}"
}

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die 'run this inside the oh-my-codex git repository'
cd "$ROOT"

export GIT_TERMINAL_PROMPT=0

BRANCH=""
REMOTE=""
CHECK_ONLY=0
UPDATE_CLI=1
REBASE_CONFLICT_FILES=()
PROBE_DIR=""
PRESERVE_PROBE_DIR=0
APPLY_DIR=""
PRESERVE_APPLY_DIR=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      [[ $# -ge 2 ]] || die '--branch requires a value'
      BRANCH="$2"
      shift 2
      ;;
    --remote)
      [[ $# -ge 2 ]] || die '--remote requires a value'
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
      die "unknown argument: $1"
      ;;
  esac
done

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
    git remote get-url "$REMOTE" >/dev/null 2>&1 || die "remote '$REMOTE' not found"
    printf '%s\n' "$REMOTE"
    return
  fi

  local candidate=""
  local url=""
  for candidate in upstream origin; do
    if url=$(git remote get-url "$candidate" 2>/dev/null); then
      if [[ "$url" == *Yeachan-Heo/oh-my-codex* ]]; then
        printf '%s\n' "$candidate"
        return
      fi
    fi
  done

  if git remote get-url origin >/dev/null 2>&1; then
    printf 'origin\n'
    return
  fi

  candidate=$(git remote | head -1)
  [[ -n "$candidate" ]] || die 'no git remotes configured'
  printf '%s\n' "$candidate"
}

REMOTE=$(select_remote)
MAIN_REF="refs/remotes/${REMOTE}/main"
LOCAL_PACKAGE_VERSION=$(read_local_package_version)
INSTALLED_VERSION=$(read_installed_version)
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || true)

log "==> Fetching $REMOTE tags and main"
FETCH_WARNING=""
if ! run_with_timeout 20 git fetch "$REMOTE" --tags >/dev/null; then
  FETCH_WARNING="git fetch from '$REMOTE' failed or timed out after 20s; continuing with cached refs"
fi

git show-ref --verify --quiet "$MAIN_REF" || die "remote '$REMOTE' does not expose main"

REMOTE_URL=$(git remote get-url "$REMOTE")
GITHUB_REPO=""
if [[ "$REMOTE_URL" =~ github\.com[:/]([^/]+/[^/.]+)(\.git)?$ ]]; then
  GITHUB_REPO="${BASH_REMATCH[1]}"
fi

LATEST_TAG=$(git tag --merged "$MAIN_REF" --sort=-version:refname 'v*' | head -1)
[[ -n "$LATEST_TAG" ]] || die "no release tags merged into ${REMOTE}/main"
LATEST_TAG_COMMIT=$(git rev-list -n 1 "$LATEST_TAG")
LATEST_TAG_DATE=$(git show -s --format='%cI' "$LATEST_TAG_COMMIT")
LATEST_TAG_SUBJECT=$(git show -s --format='%s' "$LATEST_TAG_COMMIT")
MAIN_HEAD=$(git rev-parse --short "$MAIN_REF")
MAIN_DATE=$(git show -s --format='%cI' "$MAIN_REF")
MAIN_SUBJECT=$(git show -s --format='%s' "$MAIN_REF")

fetch_release_payload() {
  local repo="$1"
  [[ -n "$repo" ]] || return 1

  if have_command gh; then
    run_with_timeout 20 env GH_PAGER=cat gh api "repos/${repo}/releases?per_page=20" 2>/dev/null && return 0
  fi

  if have_command curl; then
    run_with_timeout 20 curl -fsSL -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/${repo}/releases?per_page=20" 2>/dev/null && return 0
  fi

  return 1
}

render_release_summary() {
  local repo="$1"
  local baseline_version="$2"
  local baseline_label="$3"
  local latest_tag="$4"

  [[ -n "$repo" ]] || return 0
  [[ -n "$baseline_version" ]] || return 0

  local payload=""
  local rendered=""
  local payload_file=""
  if ! payload=$(fetch_release_payload "$repo"); then
    RELEASE_SUMMARY_WARNING="GitHub release descriptions unavailable; skipping short release summary"
    return 0
  fi

  payload_file=$(mktemp "${TMPDIR:-/tmp}/mission-upstream-sync.release-notes.XXXXXX.json")
  printf '%s' "$payload" >"$payload_file"

  if ! rendered=$(PAYLOAD_FILE="$payload_file" BASELINE_VERSION="$baseline_version" BASELINE_LABEL="$baseline_label" LATEST_TAG="$latest_tag" python3 - <<'PY'
import json
import os
import re


def parse_version(value: str):
    match = re.search(r"v?(\d+)\.(\d+)\.(\d+)", value or "")
    if not match:
        return None
    return tuple(int(match.group(i)) for i in range(1, 4))


def extract_summary(body: str, fallback: str) -> str:
    text = (body or "").replace("\r\n", "\n").strip()
    if not text:
        return fallback

    summary_match = re.search(r"(?ims)^##\s+Summary\s*$\n+(.*?)(?=^##\s+|\Z)", text)
    if summary_match:
        candidate = summary_match.group(1).strip().split("\n\n", 1)[0].strip()
    else:
        paragraphs = []
        current = []
        in_code = False
        for raw_line in text.splitlines():
            line = raw_line.strip()
            if line.startswith("```"):
                in_code = not in_code
                continue
            if in_code:
                continue
            if not line:
                if current:
                    paragraphs.append(" ".join(current).strip())
                    current = []
                continue
            if line.startswith("#"):
                continue
            if line.lower().startswith("**full changelog**"):
                continue
            if line.startswith(("- ", "* ", "+ ")):
                continue
            if line.startswith(">"):
                line = line.lstrip(">").strip()
            current.append(line)
        if current:
            paragraphs.append(" ".join(current).strip())
        candidate = paragraphs[0] if paragraphs else fallback

    candidate = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", candidate)
    candidate = candidate.replace("`", "")
    candidate = re.sub(r"\s+", " ", candidate).strip(" -")
    if not candidate:
        candidate = fallback
    if len(candidate) > 280:
        trimmed = candidate[:277].rsplit(" ", 1)[0].strip()
        candidate = (trimmed or candidate[:277]).rstrip(" ,;:") + "…"
    return candidate


baseline_raw = os.environ["BASELINE_VERSION"]
baseline_label = os.environ["BASELINE_LABEL"]
latest_tag = os.environ["LATEST_TAG"]
payload_file = os.environ["PAYLOAD_FILE"]

try:
    with open(payload_file, "r", encoding="utf-8") as fh:
        releases = json.load(fh)
except (OSError, json.JSONDecodeError):
    raise SystemExit(1)

baseline_version = parse_version(baseline_raw)
latest_version = parse_version(latest_tag)
normalized_baseline = baseline_raw.lstrip("v") or baseline_raw

print(f"==> What's new since {baseline_label} v{normalized_baseline}")
if baseline_version is None:
    print("Release summary:   couldn't parse the local baseline version")
    raise SystemExit(0)

missing = []
for release in releases:
    if release.get("draft") or release.get("prerelease"):
        continue
    version = parse_version(release.get("tag_name") or "")
    if version is None:
        continue
    if latest_version is not None and version > latest_version:
        continue
    if version <= baseline_version:
        continue
    missing.append((version, release))

if not missing:
    print("Missing releases:  none")
    print("Release summary:   local baseline already includes the latest published release")
    raise SystemExit(0)

missing.sort(key=lambda item: item[0])
max_items = 5
omitted = max(0, len(missing) - max_items)
selected = missing[-max_items:]

print(f"Missing releases:  {len(missing)}")
if omitted:
    print(f"Showing:           most recent {len(selected)} release summaries")

for _, release in selected:
    tag = release.get("tag_name") or "unknown"
    date = (release.get("published_at") or release.get("created_at") or "")[:10] or "unknown-date"
    title = release.get("name") or tag
    summary = extract_summary(release.get("body") or "", title)
    print(f"  - {tag} ({date}): {summary}")
    html_url = release.get("html_url")
    if html_url:
        print(f"    {html_url}")

if omitted:
    print(f"  … plus {omitted} older missing release(s).")
PY
); then
    rm -f "$payload_file"
    RELEASE_SUMMARY_WARNING="GitHub release descriptions were fetched but could not be summarized"
    return 0
  fi

  rm -f "$payload_file"
  RELEASE_SUMMARY="$rendered"
}

if [[ -z "$BRANCH" ]]; then
  if [[ -n "$CURRENT_BRANCH" && "$CURRENT_BRANCH" =~ [Mm][Ii][Ss][Ss][Ii][Oo][Nn] ]]; then
    BRANCH="$CURRENT_BRANCH"
  else
    BRANCH=$(git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads | awk 'BEGIN{IGNORECASE=1} /mission/ { print; exit }')
  fi
fi
[[ -n "$BRANCH" ]] || die 'no local branch matching /mission/i found; pass --branch explicitly'
git show-ref --verify --quiet "refs/heads/$BRANCH" || die "branch '$BRANCH' not found"

BRANCH_HEAD=$(git rev-parse --short "$BRANCH")
BRANCH_DATE=$(git show -s --format='%cI' "$BRANCH")
BRANCH_SUBJECT=$(git show -s --format='%s' "$BRANCH")
read -r BRANCH_AHEAD BRANCH_BEHIND < <(git rev-list --left-right --count "$BRANCH...$MAIN_REF")
MERGE_BASE=$(git merge-base "$BRANCH" "$MAIN_REF")

RELEASE_URL=''
COMPARE_URL=''
if [[ -n "$GITHUB_REPO" ]]; then
  RELEASE_URL="https://github.com/${GITHUB_REPO}/releases/tag/${LATEST_TAG}"
  COMPARE_URL="https://github.com/${GITHUB_REPO}/compare/${LATEST_TAG}...main"
fi

RELEASE_SUMMARY=''
RELEASE_SUMMARY_WARNING=''
RELEASE_BASELINE_VERSION="$LOCAL_PACKAGE_VERSION"
RELEASE_BASELINE_LABEL='repo package.json'
if [[ -z "$RELEASE_BASELINE_VERSION" ]]; then
  RELEASE_BASELINE_VERSION="$INSTALLED_VERSION"
  RELEASE_BASELINE_LABEL='installed CLI'
fi
render_release_summary "$GITHUB_REPO" "$RELEASE_BASELINE_VERSION" "$RELEASE_BASELINE_LABEL" "$LATEST_TAG"

log ''
log '==> Upstream status'
log "Remote:            $REMOTE ($REMOTE_URL)"
[[ -n "$FETCH_WARNING" ]] && log "Fetch warning:     $FETCH_WARNING"
log "Latest release:    $LATEST_TAG @ ${LATEST_TAG_COMMIT:0:7} (${LATEST_TAG_DATE})"
log "Release commit:    $LATEST_TAG_SUBJECT"
[[ -n "$RELEASE_URL" ]] && log "Release URL:       $RELEASE_URL"
log "Remote main HEAD:  $MAIN_HEAD (${MAIN_DATE})"
log "Remote main tip:   $MAIN_SUBJECT"
[[ -n "$COMPARE_URL" ]] && log "Release..main:     $COMPARE_URL"
if [[ -n "$RELEASE_SUMMARY" ]]; then
  log ''
  printf '%s\n' "$RELEASE_SUMMARY"
fi
[[ -n "$RELEASE_SUMMARY_WARNING" ]] && log "Release summary:   $RELEASE_SUMMARY_WARNING"

log ''
log '==> Mission branch status'
log "Target branch:     $BRANCH @ $BRANCH_HEAD (${BRANCH_DATE})"
log "Branch head:       $BRANCH_SUBJECT"
log "Ahead of main:     $BRANCH_AHEAD"
log "Behind main:       $BRANCH_BEHIND"

PROBE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mission-upstream-sync.probe.XXXXXX")
git worktree add --detach "$PROBE_DIR" "$BRANCH" >/dev/null
PROBE_STDOUT="$PROBE_DIR/.rebase.stdout"
PROBE_STDERR="$PROBE_DIR/.rebase.stderr"

log ''
log '==> Rebase probe'
if (
  cd "$PROBE_DIR"
  git rebase --onto "$MAIN_REF" "$MERGE_BASE" HEAD >"$PROBE_STDOUT" 2>"$PROBE_STDERR"
); then
  PROBE_OK=1
  report_rebase_success 'Probe' "$PROBE_DIR"
else
  PROBE_OK=0
  report_conflicts 'Probe' "$PROBE_DIR" "$PROBE_STDERR"
fi

if (( CHECK_ONLY )); then
  if (( PROBE_OK == 0 )); then
    PRESERVE_PROBE_DIR=1
    log "Preserved probe worktree: $PROBE_DIR"
    log 'Resolve there manually if you want to inspect the exact conflict, then git rebase --continue or --abort.'
    exit 1
  fi

  log ''
  log 'Check-only mode enabled; no rebase or CLI update performed.'
  exit 0
fi

sync_local_main_branch

log ''
log '==> Rebase execution'
if [[ "$CURRENT_BRANCH" == "$BRANCH" ]]; then
  git diff --quiet || die "current branch '$BRANCH' has unstaged changes; clean it first or rerun with --check-only"
  git diff --cached --quiet || die "current branch '$BRANCH' has staged changes; clean it first or rerun with --check-only"

  APPLY_STDOUT=$(mktemp "${TMPDIR:-/tmp}/mission-upstream-sync.current-rebase.stdout.XXXXXX")
  APPLY_STDERR=$(mktemp "${TMPDIR:-/tmp}/mission-upstream-sync.current-rebase.stderr.XXXXXX")

  if git rebase "$MAIN_REF" >"$APPLY_STDOUT" 2>"$APPLY_STDERR"; then
    report_rebase_success 'Rebase' "$ROOT"
  else
    report_conflicts 'Rebase' "$ROOT" "$APPLY_STDERR"
    log "Current checkout now contains the rebase conflicts for '$BRANCH'. Resolve files, git add them, then run git rebase --continue or --abort."
    exit 1
  fi
else
  if git worktree list --porcelain | awk '/^branch /{print $2}' | grep -qx "refs/heads/$BRANCH"; then
    die "branch '$BRANCH' is checked out in another worktree; switch there and rerun for the real rebase"
  fi

  APPLY_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mission-upstream-sync.apply.XXXXXX")
  git worktree add "$APPLY_DIR" "$BRANCH" >/dev/null
  APPLY_STDOUT="$APPLY_DIR/.rebase.stdout"
  APPLY_STDERR="$APPLY_DIR/.rebase.stderr"

  if (
    cd "$APPLY_DIR"
    git rebase "$MAIN_REF" >"$APPLY_STDOUT" 2>"$APPLY_STDERR"
  ); then
    report_rebase_success 'Rebase' "$APPLY_DIR"
    cleanup_apply
    APPLY_DIR=""
    log "Rebased branch '$BRANCH' onto ${REMOTE}/main in a temporary worktree"
  else
    PRESERVE_APPLY_DIR=1
    report_conflicts 'Rebase' "$APPLY_DIR" "$APPLY_STDERR"
    log "Preserved apply worktree: $APPLY_DIR"
    log 'Resolve files there manually, git add them, then run git rebase --continue or --abort in that worktree.'
    exit 1
  fi
fi

if (( UPDATE_CLI == 0 )); then
  log ''
  log 'Skipping local CLI relink because --no-cli-update was set.'
  exit 0
fi

refresh_local_linked_cli
