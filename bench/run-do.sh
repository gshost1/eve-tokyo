#!/usr/bin/env bash
# Runs the model layer on DigitalOcean for each model given. Call through Keysrs so DO_KEY is
# injected once:  keys env hack-token DO_KEY -- ./bench/run-do.sh <tag> <model>...
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="$1"; shift
cd "$ROOT/.cache/eve/packages/eve"
for model in "$@"; do
  safe="${model//\//_}"
  out="$ROOT/results/do-$TAG-$safe.json"
  echo "== $model"
  BENCH_LAYER=do BENCH_MODEL="$model" BENCH_OUT="$out" npx vitest run --config vitest.bench.config.ts \
    > "$ROOT/results/do-$TAG-$safe.log" 2>&1 && echo "   ok" || { echo "   FAILED"; grep -m3 -E "Error|HTTP" "$ROOT/results/do-$TAG-$safe.log"; }
done
