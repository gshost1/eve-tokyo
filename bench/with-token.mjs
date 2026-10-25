#!/usr/bin/env node
// Runs a command with AI_GATEWAY_API_KEY set from a Keysrs grant or client token read on stdin, so the
// token never appears in a shell history or transcript:
//   keys grant jev-ass --task "eve-tokyo" --minutes 60 --max-usd 5 --paths /v4/ai --json \
//     | node bench/with-token.mjs -- env AI_GATEWAY_BASE_URL=http://127.0.0.1:12767/jev-ass/v4/ai ./bench/run-gw.sh fix anthropic/claude-haiku-5.5
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const sep = process.argv.indexOf("--");
const command = process.argv.slice(sep + 1);
if (sep < 0 || command.length === 0) { console.error("usage: <token on stdin> | node bench/with-token.mjs -- <command...>"); process.exit(2); }
const token = readFileSync(0, "utf8").match(/ksfc?_[A-Za-z0-9._~-]+/)?.[0];
if (!token) { console.error("no ksf_/ksfc_ token on stdin"); process.exit(2); }
const r = spawnSync(command[0], command.slice(1), { env: { ...process.env, AI_GATEWAY_API_KEY: token }, stdio: "inherit" });
process.exit(r.status ?? 1);
