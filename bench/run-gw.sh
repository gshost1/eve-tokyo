#!/usr/bin/env bash
# Runs the model layer on Vercel AI Gateway for each model given. Call through Keysrs so AI_GATEWAY_API_KEY is
# injected once:  keys env jev-ass AI_GATEWAY_API_KEY -- ./bench/run-gw.sh <tag> <model>...
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="$1"; shift
mkdir -p "$ROOT/results"
cd "$ROOT/.cache/eve/packages/eve"
for model in "$@"; do
  safe="${model//\//_}"
  out="$ROOT/results/gw-$TAG-$safe.json"
  echo "== $model"
  BENCH_LAYER=model BENCH_MODEL="$model" BENCH_OUT="$out" npx vitest run --config vitest.bench.config.ts \
    > "$ROOT/results/gw-$TAG-$safe.log" 2>&1 && echo "   ok" || { echo "   FAILED"; grep -m3 -E "Error|HTTP" "$ROOT/results/gw-$TAG-$safe.log"; }
done
