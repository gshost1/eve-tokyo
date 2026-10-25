#!/usr/bin/env bash
# Runs ON the InstaBox machine (uploaded by bench/instabox.mjs): Node 24, pnpm, git, the repo.
#   bash box-bootstrap.sh <repo-url> <git-ref>
set -euo pipefail
REPO="$1"; REF="$2"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.local" "$HOME/runs"
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 24 ] && need_node=0
fi
if [ "$need_node" = 1 ]; then
  ver="$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(next(v["version"] for v in json.load(sys.stdin) if v["version"].startswith("v24.")))')"
  curl -fsSL "https://nodejs.org/dist/$ver/node-$ver-linux-x64.tar.xz" -o /tmp/node.tar.xz
  rm -rf "$HOME/.local/node" && mkdir -p "$HOME/.local/node"
  tar -xJf /tmp/node.tar.xz -C "$HOME/.local/node" --strip-components=1
fi
command -v pnpm >/dev/null 2>&1 || npm install -g --prefix "$HOME/.local" pnpm@12 >/dev/null
command -v git >/dev/null 2>&1 || { echo "git missing on the box" >&2; exit 2; }
if [ ! -d "$HOME/eve-tokyo/.git" ]; then git clone -q "$REPO" "$HOME/eve-tokyo"; fi
git -C "$HOME/eve-tokyo" fetch -q origin && git -C "$HOME/eve-tokyo" checkout -q "$REF"
cd "$HOME/eve-tokyo" && ./bench/setup.sh
echo "bootstrap ok: node $(node --version), pnpm $(pnpm --version), eve-tokyo at $(git rev-parse --short HEAD)"
