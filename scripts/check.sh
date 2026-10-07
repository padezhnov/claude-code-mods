#!/bin/sh
# Validate, type-check and test every plugin in this marketplace.
# CLAUDE: a Claude Code CLI with mods (>= 2.1.287); TSC: TypeScript >= 5.4.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLAUDE=${CLAUDE:-claude}
TSC=${TSC:-npx -y -p typescript@5.9 tsc}

for dir in "$ROOT"/plugins/*/; do
  dir=${dir%/}
  echo "== $(basename "$dir")"
  "$CLAUDE" plugin validate "$dir"
  # The engine lays the API types beside a mod when it loads it; outside a
  # session, take them from the newest plugin-authoring skill on this machine.
  if [ ! -f "$dir/.claude-plugin/types/claude-code/index.d.ts" ]; then
    src=$(ls -t /tmp/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts 2>/dev/null | head -1 || true)
    [ -n "$src" ] || { echo "no API types found: load the mod once or the plugin-authoring skill" >&2; exit 1; }
    mkdir -p "$dir/.claude-plugin/types/claude-code"
    cp "$src" "$dir/.claude-plugin/types/claude-code/index.d.ts"
  fi
  $TSC -p "$dir"
  out=$("$CLAUDE" plugin test "$dir" 2>&1) || status=$?
  # Another, older Claude Code on the same machine can save the mods rollout
  # switch as off; one networked start of this CLI refreshes it.
  if printf '%s' "$out" | grep -q 'rollout switch'; then
    echo "(refreshing the mods rollout switch with one short run)"
    (cd /tmp && "$CLAUDE" -p "reply: ok" --model haiku >/dev/null 2>&1) || true
    status=0; out=$("$CLAUDE" plugin test "$dir" 2>&1) || status=$?
  fi
  printf '%s\n' "$out"
  [ "${status:-0}" -eq 0 ] || exit "$status"
done
