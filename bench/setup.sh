#!/usr/bin/env bash
# Pinned eve checkout with the eve-tokyo bench copied in. Re-run after editing bench/src.
set -euo pipefail
EVE_SHA=0fd4240d31c0fdf18e61dfdedf3c203eb595bba2
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVE="$ROOT/.cache/eve"
if [ ! -d "$EVE/.git" ]; then
  git init -q "$EVE"
  git -C "$EVE" remote add origin https://github.com/vercel/eve.git
  git -C "$EVE" fetch -q --depth 1 origin "$EVE_SHA"
  git -C "$EVE" checkout -q FETCH_HEAD
  (cd "$EVE" && pnpm install --frozen-lockfile --ignore-scripts --filter eve... >/dev/null)
fi
COMP="$EVE/packages/eve/src/harness/compaction"
DEST="$EVE/packages/eve/src/eve-tokyo"
rm -rf "$DEST" && mkdir -p "$DEST"
cp "$ROOT"/bench/src/*.ts "$DEST/"
cp "$ROOT/bench/vitest.bench.config.ts" "$EVE/packages/eve/"
# Strategy variants: sibling copies of the real engine/prompt with one patch each.
for p in "$ROOT"/bench/patches/*.patch; do
  [ -e "$p" ] || continue
  name="$(basename "$p" .patch)"
  work="$(mktemp -d)"
  cp "$COMP/engine.ts" "$COMP/prompt.ts" "$work/"
  (cd "$work" && patch -s -p1 < "$p")
  sed "s#\"\#harness/compaction/prompt.js\"#\"\#harness/compaction/prompt.$name.js\"#" "$work/engine.ts" > "$COMP/engine.$name.ts"
  cp "$work/prompt.ts" "$COMP/prompt.$name.ts"
  rm -rf "$work"
done
echo "eve at $EVE_SHA, bench in $DEST"
