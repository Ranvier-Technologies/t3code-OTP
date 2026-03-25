#!/usr/bin/env bash
# Guard: block 'gh pr create' unless it targets Ranvier-Technologies/t3code-OTP.
# This repo is a fork of pingdotgg/t3code — without --repo, gh defaults to upstream.
#
# PreToolUse hook on Bash. Exit 0 = allow, exit 2 = block.

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only intercept commands where gh pr create is the actual command being run
# (not just mentioned in a string like a commit message)
if ! echo "$COMMAND" | grep -qE '(^|\&\&|\|\||;)\s*gh\s+pr\s+create\b'; then
  exit 0
fi

# Allow if correct --repo is specified
if echo "$COMMAND" | grep -q '\-\-repo Ranvier-Technologies/t3code-OTP'; then
  exit 0
fi

echo "BLOCKED: 'gh pr create' without --repo Ranvier-Technologies/t3code-OTP" >&2
echo "This repo is a fork. Without --repo, gh defaults to upstream (pingdotgg/t3code)." >&2
echo "Fix: add --repo Ranvier-Technologies/t3code-OTP" >&2
exit 2
