#!/usr/bin/env bash
# The Bringup adopt check, as the GitHub Action runs it (adopt/action.yml), and as anyone can run it locally with the
# same variables. Fails (exit 1) only when the repo breaks the agreed contract; the full report goes to the job
# summary either way. With INPUT_COMMENT=true on a pull request it also keeps one PR comment with the change impact.
set -euo pipefail

root="$(cd "${GITHUB_ACTION_PATH:-$(dirname "$0")}/.." && pwd)"
cd "${GITHUB_WORKSPACE:-$PWD}"

args=("${INPUT_PATH:-.}" --check "${INPUT_CONTRACT:-.bringup/adopt}")
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then args+=(--markdown "$GITHUB_STEP_SUMMARY"); fi
if [ -n "${INPUT_VARIANT:-}" ]; then args+=(--variant "$INPUT_VARIANT"); fi

comment=false
if [ "${INPUT_COMMENT:-false}" = "true" ]; then
	case "${GITHUB_EVENT_NAME:-}" in pull_request | pull_request_target) comment=true ;; esac
fi
if $comment; then
	impact="$(mktemp)"
	trap 'rm -f "$impact"' EXIT
	args+=(--impact "$impact")
fi

# The check's exit code is the Action's; the comment never changes it.
status=0
"$root/node_modules/.bin/tsx" "$root/src/adopt/cli.ts" "${args[@]}" || status=$?

# Every GitHub call goes through here. BRINGUP_DRY_RUN=1 prints the call instead of making it (the tests use this;
# BRINGUP_DRY_RUN_COMMENT_ID stands in for a comment already on the PR).
gh_api() {
	if [ -n "${BRINGUP_DRY_RUN:-}" ]; then
		echo "dry run: gh api $*" >&2
		case "$*" in *"/comments --paginate"*) echo "${BRINGUP_DRY_RUN_COMMENT_ID:-}" ;; esac
		return 0
	fi
	GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" gh api "$@"
}

# One comment per PR, found by its hidden marker and updated, so each push rewrites it instead of adding another.
post_comment() {
	local body="$1" pr list id
	pr="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).pull_request?.number ?? "")' "${GITHUB_EVENT_PATH:?}")"
	[ -n "$pr" ] || { echo "no pull request number in $GITHUB_EVENT_PATH" >&2; return 1; }
	# A failed lookup stops here: posting anyway would add a second comment next to one it couldn't see.
	list="$(gh_api "repos/${GITHUB_REPOSITORY:?}/issues/$pr/comments" --paginate --jq '.[] | select(.body | contains("<!-- bringup-impact -->")) | .id')" || return 1
	id="${list%%$'\n'*}"
	if [ -n "$id" ]; then
		gh_api -X PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$id" -f body="$(cat "$body")" >/dev/null || return 1
		echo "updated the change-impact comment on PR #$pr"
	else
		gh_api -X POST "repos/$GITHUB_REPOSITORY/issues/$pr/comments" -f body="$(cat "$body")" >/dev/null || return 1
		echo "commented the change impact on PR #$pr"
	fi
}

# No body means the check itself failed before it could say anything: nothing worth a comment.
if $comment && [ -s "$impact" ]; then
	if [ -n "${BRINGUP_DRY_RUN:-}" ]; then
		echo "dry run: comment body:"
		cat "$impact"
	fi
	post_comment "$impact" || echo "::warning::could not comment on the pull request (does the workflow grant pull-requests: write?)"
fi
exit "$status"
