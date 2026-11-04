#!/usr/bin/env bash
# The Bringup adopt check, as the GitHub Action runs it (adopt/action.yml), and as anyone can run it locally with the
# same variables. Fails (exit 1) only when the repo breaks the agreed contract; the full report goes to the job
# summary either way.
set -euo pipefail

root="$(cd "${GITHUB_ACTION_PATH:-$(dirname "$0")}/.." && pwd)"
cd "${GITHUB_WORKSPACE:-$PWD}"

args=("${INPUT_PATH:-.}" --check "${INPUT_CONTRACT:-.bringup/adopt}")
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then args+=(--markdown "$GITHUB_STEP_SUMMARY"); fi
if [ -n "${INPUT_VARIANT:-}" ]; then args+=(--variant "$INPUT_VARIANT"); fi

exec "$root/node_modules/.bin/tsx" "$root/src/adopt/cli.ts" "${args[@]}"
