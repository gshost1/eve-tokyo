#!/usr/bin/env node
// Drives the eve-tokyo bench on an InstaBox machine (https://instabox.sh/docs/api.md) over its HTTP
// API; no SSH. INSTABOX_API_KEY comes from the environment, injected once with
//   keys env eve-instabox INSTABOX_API_KEY -- node bench/instabox.mjs <command> ...
// The model key never goes to the box: `run` reads a Keysrs grant/client token from stdin and the
// box calls the Keysrs relay (AI_GATEWAY_BASE_URL) with it. Nothing secret is printed or stored.
//
//   up   [--ref <git ref>]                 create or resume the machine, bootstrap, clone, bench/setup.sh
//   run  <tag> <model...> --token-stdin    model layer in the background on the box; waits; downloads results\n//        [--smoke]                       first one verified summary with the first model (1 seed), then the full run
//        [--base-url <relay>/jev-ass/v4/ai] [--seeds 1,2,3] [--turns 160] [--max-rounds 80] [--rounds 5] [--concurrency 3]
//   exec "<shell command>"                 one command on the box (<= 600 s)
//   watch <tag> <model...>                 reattach to a running job, wait, download\n//   fetch <tag> <model...>                 download results/gw-<tag>-*.json|.log again
//   down [--delete]                        stop the machine (or delete it)
// Machine name: INSTABOX_MACHINE (default eve-tokyo). Template: INSTABOX_TEMPLATE (default agent-browser). Repo: EVE_TOKYO_REPO.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.instabox.sh";
const KEY = process.env.INSTABOX_API_KEY;
const NAME = process.env.INSTABOX_MACHINE ?? "eve-tokyo";
const REPO = process.env.EVE_TOKYO_REPO ?? "https://github.com/gshost1/eve-tokyo.git";
// Free-plan orgs may only create from agent-browser (or a snapshot); paid ones can use universal.
const TEMPLATE = process.env.INSTABOX_TEMPLATE ?? "agent-browser";
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

async function api(method, path, { body, raw, headers = {}, timeoutMs = 120_000, allow404 = false } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { "X-API-Key": KEY, ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404 && allow404) return { status: 404 };
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
  const r = await api("GET", `/v1/machines/${NAME}`, { allow404: true });
  return r.status === 404 ? null : r.json;
}
async function ensureRunning() {
  let m = await machine();
  if (!m) {
    log(`creating machine ${NAME} (${TEMPLATE} template)`);
    const { json: op } = await api("POST", "/v1/machines", {
      body: { name: NAME, templateId: TEMPLATE, autoSuspendAfterSeconds: 1800, metadata: { project: "eve-tokyo" } },
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
// The API has no file-write route; small files go in through exec's stdin (<= 1 MiB).
async function upload(id, path, content, mode = "0644") {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
  const { json } = await api("POST", `/v1/machines/${id}/exec`, {
    body: { cmd: `mkdir -p ${JSON.stringify(dirname(path))} && cat > ${JSON.stringify(path)} && chmod ${mode} ${JSON.stringify(path)}`, stdin: text, timeoutSeconds: 30 },
  });
  if (json.exitCode !== 0) throw new Error(`upload ${path} failed: ${json.stderr}`);
}
const q = (x) => JSON.stringify(x);
async function download(id, path) {
  const res = await fetch(`${API}/v1/machines/${id}/files/content?${new URLSearchParams({ path })}`, {
    headers: { "X-API-Key": KEY }, signal: AbortSignal.timeout(600_000),
  });
  if (res.ok) return Buffer.from(await res.arrayBuffer());
  if (res.status !== 404) throw new Error(`download ${path} -> ${res.status}`);
  // No content route on this API: gzip on the box and pull base64 chunks through exec stdout.
  const gz = `/tmp/dl-${process.pid}.gz`;
  const st = await exec(id, `gzip -c ${q(path)} > ${gz} && stat -c %s ${gz}`, { timeoutSeconds: 120 });
  if (st.exitCode !== 0) throw new Error(`gzip ${path}: ${st.stderr}`);
  const size = Number(st.stdout.trim());
  const CHUNK = 96 * 1024;
  const parts = [];
  for (let off = 0; off < size; off += CHUNK) {
    const r = await exec(id, `tail -c +${off + 1} ${gz} | head -c ${CHUNK} | base64 -w0`, { timeoutSeconds: 60 });
    if (r.exitCode !== 0 || r.truncated) throw new Error(`chunk at ${off} of ${path}: exit ${r.exitCode}, truncated ${r.truncated}`);
    parts.push(Buffer.from(r.stdout.trim(), "base64"));
  }
  await exec(id, `rm -f ${gz}`, { timeoutSeconds: 30 });
  const { gunzipSync } = await import("node:zlib");
  return gunzipSync(Buffer.concat(parts));
}
// Long jobs: exec is synchronous and capped at 600 s, so the job goes into a script on the box,
// starts detached (inheriting the exec call's envs, so nothing secret touches the disk) and an exit
// file is polled. Polling tolerates transient API errors (502s happen); the job itself is unaffected.
async function startJob(id, name, shell, envs) {
  await upload(id, `${HOME}/runs/${name}.sh`, `#!/usr/bin/env bash\n${shell}\necho $? > ~/runs/${name}.exit\n`, "0755");
  const start = `rm -f ~/runs/${name}.exit; setsid nohup bash ~/runs/${name}.sh > ~/runs/${name}.log 2>&1 < /dev/null & disown; sleep 1; pgrep -f ~/runs/${name}.sh > /dev/null && echo started || { echo 'job died immediately'; cat ~/runs/${name}.log; exit 3; }`;
  const r = await exec(id, start, { envs, timeoutSeconds: 60 });
  if (r.exitCode !== 0) throw new Error(`could not start ${name}: ${r.stdout} ${r.stderr}`);
}
async function waitJob(id, name) {
  let lastTail = "";
  let failures = 0;
  for (;;) {
    await new Promise((res) => setTimeout(res, 30_000));
    let s;
    try {
      s = await exec(id, `cat ~/runs/${name}.exit 2>/dev/null; echo ---; tail -n 3 ~/runs/${name}.log 2>/dev/null`, { timeoutSeconds: 30 });
      failures = 0;
    } catch (e) {
      failures += 1;
      log(`poll failed (${failures}/20): ${String(e.message).slice(0, 120)}`);
      if (failures >= 20) throw e;
      continue;
    }
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
async function background(id, name, shell, envs) {
  await startJob(id, name, shell, envs);
  return waitJob(id, name);
}
async function withRetry(fn, what, tries = 5) {
  for (let i = 1; ; i += 1) {
    try { return await fn(); } catch (e) {
      if (i >= tries) throw e;
      log(`${what} failed (${i}/${tries}), retrying: ${String(e.message).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 10_000 * i));
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
  if (cmd === "probe") {
    await exec(m.id, "mkdir -p ~/runs && ls -la ~ ~/runs; echo HOME=$HOME USER=$(id -un) SHELL=$SHELL; which setsid tmux systemd-run git curl python3 xz node; setsid nohup sleep 300 > ~/runs/probe.log 2>&1 < /dev/null & disown; sleep 1; pgrep -af 'sleep 300'", { timeoutSeconds: 30 }).then((r) => console.log(r.stdout, r.stderr));
    await new Promise((r) => setTimeout(r, 8_000));
    const r = await exec(m.id, "pgrep -af 'sleep 300' || echo 'detached process did NOT survive'; ls -la ~/runs", { timeoutSeconds: 30 });
    return console.log(r.stdout, r.stderr);
  }
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
  if (cmd === "run" || cmd === "fetch" || cmd === "watch") {
    const [tag, ...models] = args;
    if (!tag || models.length === 0) fail("usage: run|watch|fetch <tag> <model...>");
    if (cmd === "watch") {
      log(`watching run-${tag} on the box`);
      await waitJob(m.id, `run-${tag}`);
    }
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
      const via = flags["base-url"] ?? "ai-gateway.vercel.sh";
      if (flags.smoke) {
        const smokeEnvs = { ...envs, BENCH_SEEDS: "1", BENCH_SUMMARY_ROUNDS: "1" };
        log(`smoke: one summary with ${models[0]} via ${via}`);
        await background(m.id, "run-smoke", `${PATH_PREFIX}mkdir -p ~/eve-tokyo/results && cd ~/eve-tokyo && ./bench/run-gw.sh smoke ${models[0]}`, smokeEnvs);
        const buf = await download(m.id, `${HOME}/eve-tokyo/results/gw-smoke-${safe(models[0])}.json`);
        const d = JSON.parse(buf.toString("utf8"));
        const r = d.results[0];
        const summaries = (r.rounds ?? []).filter((x) => x.path === "summary");
        if (r.error || summaries.length === 0 || !(summaries[0].summary.inputTokens > 0)) {
          const logTail = await exec(m.id, `tail -n 30 ~/eve-tokyo/results/gw-smoke-${safe(models[0])}.log`, { timeoutSeconds: 30 });
          console.error(logTail.stdout);
          throw new Error(`smoke failed: ${r.error ?? "no summary produced"}`);
        }
        const sm = summaries[0].summary;
        log(`smoke ok: summary at round ${summaries[0].round}, ${sm.inputTokens} in / ${sm.outputTokens} out, $${sm.costUsd}, ${Math.round(sm.ms / 1000)} s`);
      }
      log(`run ${tag}: ${models.join(", ")} via ${via}`);
      await background(m.id, `run-${tag}`, `${PATH_PREFIX}mkdir -p ~/eve-tokyo/results && cd ~/eve-tokyo && ./bench/run-gw.sh ${tag} ${models.join(" ")}`, envs);
    }
    mkdirSync(join(ROOT, "results"), { recursive: true });
    for (const model of models) {
      for (const ext of ["json", "log"]) {
        const file = `gw-${tag}-${safe(model)}.${ext}`;
        try {
          const buf = await withRetry(() => download(m.id, `${HOME}/eve-tokyo/results/${file}`), `download ${file}`);
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
