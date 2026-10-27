#!/usr/bin/env bash
# Runs ON the InstaBox machine (uploaded by bench/overnight.mjs): Docker access, the sandbox image,
# and the long-horizon runner's node_modules. Idempotent.
set -euo pipefail
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
cd "$HOME/eve-tokyo/bench/longrun"
echo "[0/3] node"
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
command -v git >/dev/null 2>&1 || { echo "git missing on the box" >&2; exit 2; }
echo "[1/3] docker"
if ! docker info >/dev/null 2>&1; then
  sudo -n chmod 666 /var/run/docker.sock 2>/dev/null || sudo -n systemctl start docker 2>/dev/null || true
  sleep 2
  docker info >/dev/null 2>&1 || { echo "docker not usable:"; docker info 2>&1 | tail -3; exit 2; }
fi
docker image inspect node:24-bookworm >/dev/null 2>&1 || docker pull -q node:24-bookworm
echo "[2/3] npm install (eve $(node -p 'require("./package.json").dependencies.eve'))"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund --silent || npm install --no-audit --no-fund --silent; else npm install --no-audit --no-fund --silent; fi
echo "[3/3] import check"
node -e 'import("eve/client").then(() => console.log("eve client import ok"))'
mkdir -p runs
echo "setup ok: node $(node --version), $(docker --version | cut -d, -f1), eve $(node -p 'require("./node_modules/eve/package.json").version'), $(nproc) cpu, $(free -g | awk '/Mem:/{print $2}') GiB"
