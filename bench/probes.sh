#!/usr/bin/env bash
# Runs the eve-tokyo probes against the pinned eve engine (run bench/setup.sh first).
#   ./bench/probes.sh          # every probe: the bug repros pass at 0fd4240, the .fixed ones at a3654ef
#   ./bench/probes.sh fixed    # only the *.fixed.probe.test.ts files; "headcap.probe" or "recap.probe" for one bug repro
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVE="$ROOT/.cache/eve"
COMP="$EVE/packages/eve/src/harness/compaction"
pattern="${1:-}"
files=()
for f in "$ROOT"/probes/*"$pattern"*.ts; do
  cp "$f" "$COMP/"
  files+=("src/harness/compaction/$(basename "$f")")
done
cd "$EVE/packages/eve"
npx vitest run --config vitest.unit.config.ts --silent=false "${files[@]}"
