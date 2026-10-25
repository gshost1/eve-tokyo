#!/usr/bin/env node
// Drives the eve-tokyo bench on an InstaBox machine (https://instabox.sh/docs/api.md) over its HTTP
// API; no SSH. INSTABOX_API_KEY comes from the environment, injected once with
//   keys env eve-instabox INSTABOX_API_KEY -- node bench/instabox.mjs <command> ...
// The model key never goes to the box: `run` reads a Keysrs grant/client token from stdin and the
// box calls the Keysrs relay (AI_GATEWAY_BASE_URL) with it. Nothing secret is printed or stored.
//
//   up   [--ref <git ref>]                 create or resume the machine, bootstrap, clone, bench/setup.sh
//   run  <tag> <model...> --token-stdin    model layer in the background on the box; waits; downloads results
//        [--base-url <relay>/jev-ass/v4/ai] [--seeds 1,2,3] [--turns 160] [--max-rounds 80] [--rounds 5] [--concurrency 3]
//   exec "<shell command>"                 one command on the box (<= 600 s)
//   fetch <tag> <model...>                 download results/gw-<tag>-*.json|.log again
//   down [--delete]                        stop the machine (or delete it)
// Machine name: INSTABOX_MACHINE (default eve-tokyo). Repo: EVE_TOKYO_REPO.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.instabox.sh";
const KEY = process.env.INSTABOX_API_KEY;
const NAME = process.env.INSTABOX_MACHINE ?? "eve-tokyo";
const REPO = process.env.EVE_TOKYO_REPO ?? "https://github.com/gshost1/eve-tokyo.git";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = "/data/home";
if (!KEY) fail("INSTABOX_API_KEY not set (run through `keys env eve-instabox INSTABOX_API_KEY -- ...`)");

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i].startsWith("--")) {
    const k = rest[i].slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[k] = next; i += 1; } else flags[k] = true;
  } else args.push(rest[i]);
}

const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
function fail(msg) { console.error(msg); process.exit(1); }

async function api(method, path, { body, raw, headers = {}, timeoutMs = 120_000 } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { "X-API-Key": KEY, ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return { status: 404 };
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
  return { status: res.status, json };
}
const idem = () => ({ "Idempotency-Key": crypto.randomUUID() });

async function waitOp(id) {
  for (;;) {
    const { json } = await api("GET", `/v1/operations/${id}?wait=25s`, { timeoutMs: 60_000 });
    if (json.state === "succeeded") return json;
    if (json.state === "failed") throw new Error(`operation ${id} failed: ${JSON.stringify(json.error)}`);
  }
}
async function machine() {
  const r = await api("GET", `/v1/machines/${NAME}`);
  return r.status === 404 ? null : r.json;
}
async function ensureRunning() {
  let m = await machine();
  if (!m) {
    log(`creating machine ${NAME} (universal template)`);
    const { json: op } = await api("POST", "/v1/machines", {
      body: { name: NAME, templateId: "universal", autoSuspendAfterSeconds: 1800, metadata: { project: "eve-tokyo" } },
      headers: idem(),
    });
    await waitOp(op.id);
    m = await machine();
  } else if (m.state === "suspended" || m.state === "stopped") {
    const verb = m.state === "suspended" ? "resume" : "start";
    log(`${verb} machine ${NAME}`);
    const { json: op } = await api("POST", `/v1/machines/${m.id}/${verb}`, { headers: idem() });
    await waitOp(op.id);
    m = await machine();
  } else if (m.operationId) {
    await waitOp(m.operationId);
    m = await machine();
  }
  for (let i = 0; m.state !== "running" && i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 5_000));
    m = await machine();
  }
  if (m.state !== "running") throw new Error(`machine ${NAME} is ${m.state}`);
  return m;
}
async function exec(id, shell, { envs, timeoutSeconds = 120, cwd } = {}) {
  const { json } = await api("POST", `/v1/machines/${id}/exec`, {
    body: { cmd: shell, ...(cwd ? { cwd } : {}), ...(envs ? { envs } : {}), timeoutSeconds },
    timeoutMs: (timeoutSeconds + 30) * 1000,
  });
  return json;
}
async function upload(id, path, content, mode = "0644") {
  const q = new URLSearchParams({ path, mode, parents: "true" });
  await api("PUT", `/v1/machines/${id}/files?${q}`, { raw: content, headers: { "Content-Type": "application/octet-stream" } });
}
async function download(id, path) {
  const res = await fetch(`${API}/v1/machines/${id}/files/content?${new URLSearchParams({ path })}`, {
    headers: { "X-API-Key": KEY }, signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) throw new Error(`download ${path} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
// Long jobs: exec is synchronous and capped at 600 s, so the job goes into a script on the box,
// starts detached (inheriting the exec call's envs, so nothing secret touches the disk) and an exit
// file is polled.
async function background(id, name, shell, envs) {
  await upload(id, `${HOME}/runs/${name}.sh`, `#!/usr/bin/env bash\n${shell}\necho $? > ~/runs/${name}.exit\n`, "0755");
  const start = `rm -f ~/runs/${name}.exit; nohup bash ~/runs/${name}.sh > ~/runs/${name}.log 2>&1 < /dev/null & echo started`;
  const r = await exec(id, start, { envs, timeoutSeconds: 60 });
  if (r.exitCode !== 0) throw new Error(`could not start ${name}: ${r.stderr}`);
  let lastTail = "";
  for (;;) {
    await new Promise((res) => setTimeout(res, 30_000));
    const s = await exec(id, `cat ~/runs/${name}.exit 2>/dev/null; echo ---; tail -n 3 ~/runs/${name}.log 2>/dev/null`, { timeoutSeconds: 30 });
    const [exit, ...tailLines] = s.stdout.split("---");
    const tail = tailLines.join("---").trim();
    if (tail && tail !== lastTail) { log(`[${name}] ${tail.split("\n").slice(-1)[0]}`); lastTail = tail; }
    if (exit.trim() !== "") {
      const code = Number(exit.trim());
      const full = await exec(id, `tail -n 40 ~/runs/${name}.log`, { timeoutSeconds: 30 });
      if (code !== 0) { console.error(full.stdout); throw new Error(`${name} exited ${code}`); }
      return full.stdout;
    }
  }
}
const PATH_PREFIX = `export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"; `;
const safe = (model) => model.replaceAll("/", "_");

async function main() {
  if (!cmd || flags.help) return console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 15).join("\n"));
  if (cmd === "down") {
    const m = await machine();
    if (!m) return log("no machine");
    if (flags.delete) {
      const { json: op } = await api("DELETE", `/v1/machines/${m.id}`, { headers: { ...idem(), "X-Confirm-Delete": m.id } });
      await waitOp(op.id); return log(`deleted ${NAME}`);
    }
    if (m.state === "running") { const { json: op } = await api("POST", `/v1/machines/${m.id}/stop`, { headers: idem() }); await waitOp(op.id); }
    return log(`${NAME} stopped`);
  }
  const m = await ensureRunning();
  log(`machine ${NAME} ${m.id} running`);
  if (cmd === "exec") {
    const r = await exec(m.id, PATH_PREFIX + args.join(" "), { timeoutSeconds: 600 });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.exitCode);
  }
  if (cmd === "up") {
    const ref = flags.ref ?? "main";
    await upload(m.id, `${HOME}/box-bootstrap.sh`, readFileSync(join(ROOT, "bench/box-bootstrap.sh")), "0755");
    const out = await background(m.id, "bootstrap", `bash ${HOME}/box-bootstrap.sh ${REPO} ${ref}`);
    return log(out.trim().split("\n").slice(-1)[0]);
  }
  if (cmd === "run" || cmd === "fetch") {
    const [tag, ...models] = args;
    if (!tag || models.length === 0) fail("usage: run <tag> <model...> --token-stdin");
    if (cmd === "run") {
      if (!flags["token-stdin"]) fail("run needs --token-stdin (pipe `keys grant ... --json` or `keys client issue ...` into it)");
      const token = readFileSync(0, "utf8").match(/ksfc?_[A-Za-z0-9._~-]+/)?.[0];
      if (!token) fail("no ksf_/ksfc_ token on stdin");
      const envs = {
        AI_GATEWAY_API_KEY: token,
        ...(flags["base-url"] ? { AI_GATEWAY_BASE_URL: flags["base-url"] } : {}),
        // Same shape as the published runs: 160 turns, up to 80 compactions, 5 summaries, 3 seeds.
        BENCH_SEEDS: flags.seeds ?? "1,2,3",
        BENCH_TURNS: String(flags.turns ?? 160),
        BENCH_MAX_ROUNDS: String(flags["max-rounds"] ?? 80),
        BENCH_SUMMARY_ROUNDS: String(flags.rounds ?? 5),
        BENCH_CONCURRENCY: String(flags.concurrency ?? 3),
      };
      log(`run ${tag}: ${models.join(", ")} via ${flags["base-url"] ?? "ai-gateway.vercel.sh"}`);
      await background(m.id, `run-${tag}`, `${PATH_PREFIX}cd ~/eve-tokyo && ./bench/run-gw.sh ${tag} ${models.join(" ")}`, envs);
    }
    mkdirSync(join(ROOT, "results"), { recursive: true });
    for (const model of models) {
      for (const ext of ["json", "log"]) {
        const file = `gw-${tag}-${safe(model)}.${ext}`;
        try {
          const buf = await download(m.id, `${HOME}/eve-tokyo/results/${file}`);
          writeFileSync(join(ROOT, "results", file), buf);
          log(`fetched results/${file} (${(buf.length / 1024).toFixed(0)} KiB)`);
        } catch (e) { log(`missing ${file}: ${e.message}`); }
      }
    }
    return;
  }
  fail(`unknown command ${cmd}`);
}
main().catch((e) => fail(e.stack ?? String(e)));
