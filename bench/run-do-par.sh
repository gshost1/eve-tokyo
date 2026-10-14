#!/usr/bin/env bash
# One process per model, in parallel, each with a few concurrent requests.
#   keys env hack-token DO_KEY -- ./bench/run-do-par.sh <tag> <model>...
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="$1"; shift
for model in "$@"; do
  (BENCH_CONCURRENCY="${BENCH_CONCURRENCY:-3}" "$ROOT/bench/run-do.sh" "$TAG" "$model") &
done
wait
