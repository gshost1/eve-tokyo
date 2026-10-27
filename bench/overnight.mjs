#!/usr/bin/env node
// Long-horizon eve runs on InstaBox machines, driven from the Mac over the InstaBox API
// (bench/instabox.mjs helpers). The model key is a Keysrs grant token read from stdin and handed to
// each box only as a process environment variable; the boxes talk to the Keysrs relay.
//
//   keys grant jev-ass --task "eve-tokyo round two" --minutes 600 --max-usd 15 --json \
//     | keys env eve-instabox INSTABOX_API_KEY -- caffeinate -dis node bench/overnight.mjs run \
//         --base-url https://keysrs-relay.keys-repo-review.workers.dev/jev-ass/v4/ai
//
//   run    [--hours 7] [--budget 14] [--tasks spec,...] [--machines "name=spec,...;name2=spec,..."]
//          [--tag <tag>] [--smoke-only] [--skip-upload] [--skip-setup] [--skip-smoke] [--keep]
//   status [--machines ...]                        one line per driver on each box
//   fetch  --tag <tag> [--machines ...]            download results again
//   stop   [--kill] [--machines ...]               SIGTERM (or SIGKILL) the drivers
// A task spec is name@window[:thresholdPercent], e.g. taskr-48@16000 or taskr-48@64000:0.5; its run
// directory is <name>-<window>k[-t<percent>]. Without --machines the single machine INSTABOX_MACHINE
// (default eve-tokyo) runs --tasks. A machine that does not exist yet is created from the InstaBox
// template and set up (Node, Docker image, node_modules) before its drivers start.
// Results land in results/longrun/<tag>/<run>/ (summary.json, probes.json, verify.txt,
// transcript.md, drive.log) plus a runs tarball per machine with the context dumps.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { api, background, download, ensureRunning, exec, HOME, idem, log, machine, PATH_PREFIX, startJob, upload, waitOp, withRetry } from "./instabox.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LR = `${HOME}/eve-tokyo/bench/longrun`;
const RUNS = `${LR}/runs`;

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i += 1) {
  if (!rest[i].startsWith("--")) continue;
  const next = rest[i + 1];
  if (next !== undefined && !next.startsWith("--")) { flags[rest[i].slice(2)] = next; i += 1; } else flags[rest[i].slice(2)] = true;
}
const hours = Number(flags.hours ?? 7);
const totalBudget = Number(flags.budget ?? 14);
// Round two: staged tasks at 32k to 64k windows, so the compaction summary runs every few dozen
// steps and the rules from the first message survive only through checkpoints. (Round one ran
// commander-vitest@400000,commander-vitest@128000,jsyaml-ts@128000,spec-cli@128000.)
const DEFAULT_TASKS = "commander-stages@48000,jsyaml-stages@32000,taskr-48@32000,taskr-48@64000";
function parseTasks(list) {
  return String(list).split(",").filter(Boolean).map((spec) => {
    const [name, rest] = spec.split("@");
    const [window, threshold] = (rest ?? "128000").split(":");
    const w = Number(window);
    const t = threshold === undefined ? 0.9 : Number(threshold);
    return { name, window: w, threshold: t, run: `${name}-${Math.round(w / 1000)}k${t === 0.9 ? "" : `-t${Math.round(t * 100)}`}` };
  });
}
const MACHINES = String(flags.machines ?? `${process.env.INSTABOX_MACHINE ?? "eve-tokyo"}=${flags.tasks ?? DEFAULT_TASKS}`)
  .split(";").filter(Boolean).map((part) => {
    const [name, tasks] = part.split("=");
    return { name: name.trim(), tasks: parseTasks(tasks ?? flags.tasks ?? DEFAULT_TASKS), id: null };
  });
const tag = flags.tag ?? `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
const resultsDir = join(ROOT, "results", "longrun", tag);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(msg) { console.error(msg); process.exit(1); }
const mlog = (m, ...a) => log(`{${m.name}}`, ...a);

async function uploadBundle(m) {
  mlog(m, "uploading bench/longrun (agent, driver, tasks, package files)");
  const tgz = execFileSync("tar", ["czf", "-", "--exclude=longrun/node_modules", "--exclude=longrun/runs", "--exclude=longrun/.eve", "--exclude=.DS_Store", "-C", join(ROOT, "bench"), "longrun"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  await upload(m.id, `${HOME}/runs/longrun-bundle.b64`, tgz.toString("base64"));
  const r = await exec(m.id, `mkdir -p ${HOME}/eve-tokyo/bench && base64 -d ${HOME}/runs/longrun-bundle.b64 | tar xzf - -C ${HOME}/eve-tokyo/bench && ls ${LR}`, { timeoutSeconds: 60 });
  if (r.exitCode !== 0) throw new Error(`bundle extract failed on ${m.name}: ${r.stderr}`);
  mlog(m, `bundle on box: ${r.stdout.trim().split("\n").join(" ")} (${(tgz.length / 1024).toFixed(0)} KiB)`);
}

async function smoke(m, envs) {
  mlog(m, "smoke: one tiny eve session through the relay, DeepInfra pinned, Docker sandbox");
  await exec(m.id, `rm -rf ${RUNS}/smoke`, { timeoutSeconds: 30 });
  try {
    await background(m.id, "longrun-smoke", `${PATH_PREFIX}cd ${LR} && node drive.mjs smoke --port 2100 --dir runs/smoke --hours 0.25`, envs);
  } catch (e) {
    const tails = await exec(m.id, `tail -n 15 ${RUNS}/smoke/drive.log; echo ---server---; tail -n 15 ${RUNS}/smoke/server.log; echo ---llm---; tail -n 3 ${RUNS}/smoke/log/llm-calls.jsonl | cut -c1-600`, { timeoutSeconds: 30 });
    console.error(tails.stdout);
    throw e;
  }
  const summary = JSON.parse((await download(m.id, `${RUNS}/smoke/summary.json`)).toString("utf8"));
  const calls = (await download(m.id, `${RUNS}/smoke/log/llm-calls.jsonl`).catch(() => Buffer.from(""))).toString("utf8");
  const providerOk = /deepinfra/i.test(calls);
  const verifyOk = Array.isArray(summary.verify?.exits) && summary.verify.exits.every((x) => x === 0);
  const probe = summary.probes?.[0]?.answer ?? "";
  mlog(m, `smoke: completed=${summary.completed} steps=${summary.steps} spent=$${Number(summary.spentUsd).toFixed(4)} deepinfra=${providerOk} docker-verify=${verifyOk} failures=${summary.failures.length}`);
  mlog(m, `smoke probe answer: ${probe.replace(/\s+/g, " ").slice(0, 160)}`);
  if (!summary.completed || !providerOk || !verifyOk) {
    const tails = await exec(m.id, `tail -n 20 ${RUNS}/smoke/drive.log; echo ---server---; tail -n 20 ${RUNS}/smoke/server.log; echo ---verify---; cat ${RUNS}/smoke/verify.txt 2>/dev/null | head -20`, { timeoutSeconds: 30 });
    console.error(tails.stdout);
    throw new Error(`smoke failed on ${m.name} (see above)`);
  }
  if (!(summary.spentUsd > 0)) mlog(m, "warning: the gateway reported no cost through the relay; the Keysrs grant cap is the only money stop");
}

async function launch(m, envs) {
  const perBudget = Math.floor((totalBudget / m.tasks.length) * 100) / 100;
  const runHours = Math.max(0.5, hours - 0.75);
  for (const [i, t] of m.tasks.entries()) {
    await exec(m.id, `rm -rf ${RUNS}/${t.run}`, { timeoutSeconds: 60 });
    await startJob(m.id, `longrun-${t.run}`, `${PATH_PREFIX}cd ${LR} && node drive.mjs ${t.name} --window ${t.window} --threshold ${t.threshold} --port ${2101 + i} --dir runs/${t.run} --hours ${runHours} --budget ${perBudget}`, envs);
    mlog(m, `started ${t.run} (port ${2101 + i}, $${perBudget}, ${runHours} h)`);
    await sleep(20_000); // stagger the clones and installs
  }
}

async function statusLines(m) {
  const script = m.tasks.map((t) => `printf '%s|%s|%s\\n' ${t.run} "$(cat ~/runs/longrun-${t.run}.exit 2>/dev/null)" "$(tail -n 1 ${RUNS}/${t.run}/drive.log 2>/dev/null | cut -c1-150)"`).join("; ");
  const r = await exec(m.id, script, { timeoutSeconds: 30 });
  return r.stdout.trim().split("\n").filter(Boolean).map((l) => { const [run, exit, last] = l.split("|"); return { machine: m.name, run, exit: exit === "" ? null : Number(exit), last }; });
}

async function pollAll(machines) {
  const launchAt = Date.now();
  const hardDeadline = launchAt + hours * 3600_000;
  let graceUntil = null;
  let failures = 0;
  let lastPrint = 0;
  for (;;) {
    await sleep(30_000);
    let rows;
    try {
      rows = [];
      for (const m of machines) rows.push(...(await statusLines(m)));
      failures = 0;
    } catch (e) {
      failures += 1;
      log(`poll failed (${failures}/30): ${String(e.message).slice(0, 120)}`);
      if (failures >= 30) throw e;
      continue;
    }
    const now = Date.now();
    if (now - lastPrint > 10 * 60_000) {
      lastPrint = now;
      for (const r of rows) log(`[${r.machine}/${r.run}${r.exit === null ? "" : ` exit ${r.exit}`}] ${r.last}`);
    }
    if (rows.every((r) => r.exit !== null)) { log("all drivers finished"); return rows; }
    if (graceUntil === null && now > hardDeadline) {
      log("deadline: SIGTERM to the drivers (they cancel, probe, verify)");
      for (const m of machines) await exec(m.id, "pkill -TERM -f 'drive.mjs' || true", { timeoutSeconds: 30 });
      graceUntil = now + 45 * 60_000;
    } else if (graceUntil !== null && now > graceUntil) {
      log("grace over: SIGKILL");
      for (const m of machines) await exec(m.id, "pkill -KILL -f 'drive.mjs' || true; pkill -KILL -f 'eve.js dev' || true", { timeoutSeconds: 30 });
      return rows;
    }
  }
}

async function fetchResults(m) {
  mkdirSync(resultsDir, { recursive: true });
  const runs = [...m.tasks.map((t) => t.run), "smoke"];
  for (const run of runs) {
    for (const f of ["summary.json", "probes.json", "verify.txt", "transcript.md", "drive.log"]) {
      try {
        const buf = await download(m.id, `${RUNS}/${run}/${f}`);
        mkdirSync(join(resultsDir, run), { recursive: true });
        writeFileSync(join(resultsDir, run, f), buf);
      } catch { /* not produced */ }
    }
  }
  const t = await exec(m.id, `cd ${RUNS} && tar czf ~/runs/longrun-${tag}.tgz --exclude='*/app' . && stat -c %s ~/runs/longrun-${tag}.tgz`, { timeoutSeconds: 600 });
  if (t.exitCode !== 0) throw new Error(`tar on ${m.name} failed: ${t.stderr}`);
  const size = Number(t.stdout.trim());
  mlog(m, `downloading runs tarball (${(size / 1048576).toFixed(1)} MiB, with the context dumps)`);
  const buf = await withRetry(() => download(m.id, `${HOME}/runs/longrun-${tag}.tgz`), `download runs tarball from ${m.name}`, 8);
  const tgz = join(resultsDir, `runs-${m.name}.tgz`);
  writeFileSync(tgz, buf);
  execFileSync("tar", ["xzf", tgz, "-C", resultsDir]);
  mlog(m, `results in results/longrun/${tag}/`);
  for (const run of runs) {
    try {
      const s = JSON.parse(readFileSync(join(resultsDir, run, "summary.json"), "utf8"));
      const stages = (s.stages ?? []).map((x) => `${x.id}:${x.completed ? "ok" : "no"}/${x.compactionsDuring}c`).join(" ");
      log(`${run}: completed=${s.completed} stopped=${s.stoppedBecause} $${Number(s.spentUsd).toFixed(2)} steps=${s.steps} compactions=${s.compactions.length} failures=${s.failures.length} probes=${s.probes.length} ${stages} verify=${JSON.stringify(s.verify?.exits ?? s.verify).slice(0, 60)}`);
    } catch { log(`${run}: no summary.json`); }
  }
}

async function stopMachine(m) {
  const box = await machine(m.name);
  if (box?.state === "running") { const { json: op } = await api("POST", `/v1/machines/${box.id}/stop`, { headers: idem() }); await waitOp(op.id); mlog(m, "machine stopped"); }
}

async function bringUp(m) {
  const box = await ensureRunning(m.name);
  m.id = box.id;
  mlog(m, `machine ${box.id} running`);
}

async function main() {
  if (!cmd || cmd === "--help" || flags.help) return console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 20).join("\n"));
  if (cmd === "stop") {
    for (const m of MACHINES) {
      await bringUp(m);
      const r = await exec(m.id, flags.kill ? "pkill -KILL -f 'drive.mjs'; pkill -KILL -f 'eve.js dev'; echo killed" : "pkill -TERM -f 'drive.mjs'; echo signalled", { timeoutSeconds: 30 });
      mlog(m, r.stdout.trim());
    }
    return;
  }
  if (cmd === "status") {
    for (const m of MACHINES) {
      await bringUp(m);
      for (const r of await statusLines(m)) log(`[${r.machine}/${r.run}${r.exit === null ? "" : ` exit ${r.exit}`}] ${r.last}`);
    }
    return;
  }
  if (cmd === "fetch") {
    if (!flags.tag) fail("fetch needs --tag");
    for (const m of MACHINES) { await bringUp(m); await fetchResults(m); }
    return;
  }
  if (cmd !== "run") fail(`unknown command ${cmd}`);
  if (!flags["base-url"]) fail("run needs --base-url <keysrs relay>/jev-ass/v4/ai");
  const token = readFileSync(0, "utf8").match(/ksfc?_[A-Za-z0-9._~-]+/)?.[0];
  if (!token) fail("no ksf_/ksfc_ token on stdin (pipe `keys grant ... --json` into this command)");
  const envs = { AI_GATEWAY_API_KEY: token, AI_GATEWAY_BASE_URL: flags["base-url"] };
  log(`tag ${tag}: ${MACHINES.map((m) => `${m.name} -> ${m.tasks.map((t) => t.run).join(", ")}`).join(" | ")}; ${hours} h, $${totalBudget} per machine`);
  for (const m of MACHINES) {
    await bringUp(m);
    if (!flags["skip-upload"]) await uploadBundle(m);
    if (!flags["skip-setup"]) {
      const out = await background(m.id, "longrun-setup", `${PATH_PREFIX}bash ${LR}/box-setup.sh`);
      mlog(m, out.trim().split("\n").at(-1));
    }
    if (!flags["skip-smoke"]) await smoke(m, envs);
    if (flags["smoke-only"]) continue;
    await launch(m, envs);
  }
  if (flags["smoke-only"]) return;
  log(`all started; polling every 30 s, deadline in ${hours} h. Reattach later with: node bench/overnight.mjs fetch --tag ${tag}${flags.machines ? ` --machines "${flags.machines}"` : ""}`);
  await pollAll(MACHINES);
  for (const m of MACHINES) await fetchResults(m);
  if (!flags.keep) for (const m of MACHINES) await stopMachine(m);
}
main().catch((e) => fail(e.stack ?? String(e)));
