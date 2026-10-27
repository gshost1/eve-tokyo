#!/usr/bin/env node
// Drives one long-horizon eve session end to end and records everything needed to judge compaction
// quality afterwards:
//   node bench/longrun/drive.mjs <task> [--dir <run dir>] [--port 2101] [--window 400000]
//        [--budget <usd>] [--hours <h>] [--max-turns <n>] [--model <id>] [--provider <slug>]
//        [--sandbox docker|just-bash] [--threshold 0.9]
// It starts a headless `eve dev` for the run (its own app dir, so parallel runs do not share state),
// opens one session with the task prompt, answers any human-input request itself, sends the
// continue prompt until the agent says TASK COMPLETE (or turns/budget/time run out), asks the recall
// probes, verifies the workspace with `docker exec`, and writes summary.json. The run dir holds
// stream.jsonl (client events), transcript.md, probes.json, verify.json, server.log and log/ (the
// instrumentation's model-calls.jsonl, context dumps, tools, hook events).
import { spawn, execFile } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, createWriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { TASKS } from "./tasks.mjs";

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

const [taskName, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i += 1) {
  if (!rest[i].startsWith("--")) continue;
  const next = rest[i + 1];
  if (next !== undefined && !next.startsWith("--")) { flags[rest[i].slice(2)] = next; i += 1; } else flags[rest[i].slice(2)] = true;
}
const task = TASKS[taskName];
if (!task) { console.error(`unknown task ${taskName}; have: ${Object.keys(TASKS).join(", ")}`); process.exit(2); }

const model = flags.model ?? process.env.LONGRUN_MODEL ?? "deepseek/deepseek-v4.1-flash-1017";
const provider = flags.provider ?? process.env.LONGRUN_PROVIDER ?? "deepinfra";
const sandbox = flags.sandbox ?? process.env.LONGRUN_SANDBOX ?? "docker";
const window = Number(flags.window ?? task.window);
const threshold = Number(flags.threshold ?? process.env.LONGRUN_THRESHOLD ?? 0.9);
const budgetUsd = Number(flags.budget ?? task.budgetUsd);
const hours = Number(flags.hours ?? task.hours);
const port = Number(flags.port ?? 2101);
const stallMinutes = Number(flags["stall-minutes"] ?? 20);
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const runDir = resolve(flags.dir ?? join(HERE, "runs", `${taskName}-${stamp}`));
const logDir = join(runDir, "log");
const appDir = join(runDir, "app");
mkdirSync(logDir, { recursive: true });

const startedAt = Date.now();
const deadline = startedAt + hours * 3600_000;
const log = (...a) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${a.join(" ")}`;
  console.error(line);
  appendFileSync(join(runDir, "drive.log"), `${line}\n`);
};
const SKIP = new Set(["message.appended", "reasoning.appended", "action.input.appended", "action.partial"]);

// ---- state -------------------------------------------------------------------------------------
const S = {
  task: taskName, model, provider, sandbox, window, threshold, budgetUsd, hours,
  startedAt: new Date(startedAt).toISOString(), endedAt: null,
  sessionId: null, turns: [], steps: 0, toolCalls: 0, spentUsd: 0, inputTokens: 0, outputTokens: 0,
  cachedInputTokens: 0, compactions: [], failures: [], stalls: 0, inputRequests: 0,
  completed: false, stoppedBecause: null, probes: [], stages: [], verify: null, serverExit: null,
};
let lastEventAt = Date.now();
let lastMessage = "";
let stopping = null; // reason string when the driver must wind down

const transcript = (text) => appendFileSync(join(runDir, "transcript.md"), text);
const streamOut = createWriteStream(join(runDir, "stream.jsonl"), { flags: "a" });
const save = () => writeFileSync(join(runDir, "summary.json"), JSON.stringify({ ...S, endedAt: S.endedAt ?? null, elapsedMin: Math.round((Date.now() - startedAt) / 60_000) }, null, 2));

writeFileSync(join(runDir, "task.json"), JSON.stringify({ taskName, model, provider, sandbox, window, threshold, budgetUsd, hours, port, stages: task.stages ?? [{ id: "s1", prompt: task.prompt }], probes: task.probes, verify: task.verify }, null, 2));

// ---- app dir + server ----------------------------------------------------------------------------
if (!existsSync(join(appDir, "package.json"))) {
  mkdirSync(appDir, { recursive: true });
  cpSync(join(HERE, "agent"), join(appDir, "agent"), { recursive: true });
  cpSync(join(HERE, "package.json"), join(appDir, "package.json"));
  symlinkSync(join(HERE, "node_modules"), join(appDir, "node_modules"), "dir");
}
const serverLog = createWriteStream(join(runDir, "server.log"), { flags: "a" });
const server = spawn(process.execPath, [join(HERE, "node_modules/eve/bin/eve.js"), "dev", "--no-ui", "--port", String(port), "--no-default-extensions", "--logs", "error"], {
  cwd: appDir,
  env: {
    ...process.env,
    PORT: String(port),
    LONGRUN_MODEL: model, LONGRUN_PROVIDER: provider, LONGRUN_SANDBOX: sandbox,
    LONGRUN_CONTEXT_TOKENS: String(window), LONGRUN_THRESHOLD: String(threshold), LONGRUN_LOG_DIR: logDir,
    EVE_TELEMETRY_DISABLED: "1", NO_COLOR: "1", FORCE_COLOR: "0", CI: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverUrl;
const urlFound = new Promise((res) => {
  const onData = (chunk) => {
    const text = chunk.toString();
    serverLog.write(text);
    const m = text.match(/server listening at (\S+)/);
    if (m && !serverUrl) { serverUrl = m[1].replace(/\x1b\[[0-9;]*m/g, ""); res(serverUrl); }
  };
  server.stdout.on("data", onData);
  server.stderr.on("data", onData);
});
server.on("exit", (code, signal) => {
  S.serverExit = { code, signal, at: new Date().toISOString() };
  log(`eve dev exited (code ${code}, signal ${signal})`);
  if (!stopping) stopping = "server-exit";
});

async function waitForServer() {
  const exited = new Promise((r) => server.on("exit", () => r(null)));
  const url = await Promise.race([urlFound, exited, new Promise((r) => setTimeout(() => r(null), 90_000))]);
  if (S.serverExit) throw new Error(`eve dev exited before it was healthy: ${readFileSync(join(runDir, "server.log"), "utf8").slice(-600)}`);
  const base = (url ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${base}/eve/v1/health`, { signal: AbortSignal.timeout(5_000) });
      if (r.ok) return base;
    } catch { /* not up yet */ }
    if (S.serverExit) throw new Error("eve dev exited before it was healthy");
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`eve dev not healthy at ${base}`);
}

// ---- event handling ------------------------------------------------------------------------------
function chooseAnswer(request) {
  const options = request.options ?? [];
  const pick = (re) => options.find((o) => re.test(o.id) || re.test(o.label));
  const option = pick(/^(approve|allow|yes|continue|proceed|accept|always|ok)/i) ?? pick(/approve|allow|continue|proceed|yes/i) ?? options[0];
  if (option) return { requestId: request.requestId, optionId: option.id };
  return { requestId: request.requestId, text: "Proceed as you see fit; decide yourself, do not ask me questions, and remember the rules from my first message." };
}

function record(ev, turn) {
  lastEventAt = Date.now();
  if (!SKIP.has(ev.type)) {
    let data = ev.data;
    if (ev.type === "action.result") {
      const text = JSON.stringify(data) ?? "";
      if (text.length > 4000) data = { truncated: true, chars: text.length, head: text.slice(0, 2000) };
    }
    streamOut.write(`${JSON.stringify({ at: new Date().toISOString(), turn: turn.label, type: ev.type, data })}\n`);
  }
  switch (ev.type) {
    case "step.completed": {
      S.steps += 1; turn.steps += 1;
      const u = ev.data.usage ?? {};
      const cost = Number(u.costUsd ?? 0);
      S.spentUsd += cost; turn.costUsd += cost;
      S.inputTokens += Number(u.inputTokens ?? 0); S.outputTokens += Number(u.outputTokens ?? 0);
      S.cachedInputTokens += Number(u.cachedInputTokens ?? u.cacheReadInputTokens ?? 0);
      turn.lastInputTokens = u.inputTokens ?? null;
      const routing = ev.data.providerMetadata?.gateway?.routing;
      const prov = routing?.finalProvider ?? routing?.resolvedProvider;
      if (prov) turn.providers.add(String(prov));
      break;
    }
    case "actions.requested": {
      for (const action of ev.data.actions ?? []) {
        S.toolCalls += 1; turn.toolCalls += 1;
        const input = JSON.stringify(action.input ?? {}) ?? "";
        transcript(`\n> tool ${action.toolName ?? action.kind} ${input.replace(/\s+/g, " ").slice(0, 240)}\n`);
      }
      break;
    }
    case "message.completed":
      lastMessage = ev.data.message ?? "";
      turn.messages.push(lastMessage);
      transcript(`\n**assistant (step ${ev.data.stepIndex}, ${ev.data.finishReason}):**\n\n${lastMessage}\n`);
      break;
    case "compaction.requested":
      S.compactions.push({ at: new Date().toISOString(), turn: turn.label, stepIndex: ev.data.stepIndex, usageInputTokens: ev.data.usageInputTokens, completed: false });
      turn.compactions += 1;
      log(`compaction requested at step ${ev.data.stepIndex}, ${ev.data.usageInputTokens} input tokens`);
      break;
    case "compaction.completed": {
      const c = [...S.compactions].reverse().find((x) => !x.completed);
      if (c) { c.completed = true; c.completedAt = new Date().toISOString(); }
      break;
    }
    case "input.requested":
      S.inputRequests += 1;
      turn.pending.push(...ev.data.requests);
      transcript(`\n> input requested: ${JSON.stringify(ev.data.requests).slice(0, 600)}\n`);
      break;
    case "turn.failed":
    case "session.failed":
      S.failures.push({ at: new Date().toISOString(), turn: turn.label, type: ev.type, code: ev.data.code, message: String(ev.data.message).slice(0, 500), terminal: ev.data.terminal });
      turn.failed = { code: ev.data.code, message: String(ev.data.message).slice(0, 300) };
      log(`${ev.type}: ${ev.data.code} ${String(ev.data.message).slice(0, 200)}`);
      break;
    default:
  }
  return true;
}

async function runTurn(session, firstResponse, label, text) {
  const turn = { label, text: text.slice(0, 200), startedAt: new Date().toISOString(), steps: 0, toolCalls: 0, costUsd: 0, compactions: 0, messages: [], pending: [], providers: new Set(), failed: null, lastInputTokens: null, cancelled: null };
  S.turns.push(turn);
  transcript(`\n\n---\n\n## ${label}\n\n**user:**\n\n${text}\n`);
  let response = firstResponse;
  for (let round = 0; round < 50; round += 1) {
    turn.pending = [];
    try {
      for await (const ev of response) record(ev, turn);
    } catch (e) {
      S.failures.push({ at: new Date().toISOString(), turn: label, type: "stream-error", message: String(e.message ?? e).slice(0, 500) });
      log(`stream error: ${String(e.message ?? e).slice(0, 200)}`);
      break;
    }
    if (turn.pending.length === 0 || stopping) break;
    const answers = turn.pending.map(chooseAnswer);
    log(`answering ${answers.length} input request(s): ${JSON.stringify(answers).slice(0, 200)}`);
    transcript(`\n> driver answered: ${JSON.stringify(answers).slice(0, 400)}\n`);
    response = await session.respond(answers);
  }
  turn.endedAt = new Date().toISOString();
  turn.providers = [...turn.providers];
  turn.finalMessage = turn.messages.at(-1) ?? "";
  save();
  return turn;
}

// Watchdog: stall, budget and deadline checks while a turn streams.
let activeSession = null;
const watchdog = setInterval(async () => {
  if (!activeSession) return;
  const now = Date.now();
  let reason = null;
  if (S.spentUsd >= budgetUsd) reason = "budget";
  else if (now >= deadline) reason = "deadline";
  else if (now - lastEventAt > stallMinutes * 60_000) reason = "stall";
  if (!reason) return;
  if (reason === "stall") { S.stalls += 1; lastEventAt = now; } else stopping ??= reason;
  log(`${reason}: cancelling the current turn`);
  try { await activeSession.cancel(); } catch (e) { log(`cancel failed: ${e.message}`); }
}, 15_000);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = sig;
    log(`${sig}: winding down (cancel, probes if affordable, verify)`);
    try { await activeSession?.cancel(); } catch { /* ignore */ }
  });
}

// ---- verification --------------------------------------------------------------------------------
async function verify() {
  if (task.verify.length === 0) return { skipped: "no verify commands" };
  if (sandbox !== "docker") return { skipped: `sandbox ${sandbox}` };
  let container = null;
  try {
    const lines = readFileSync(join(logDir, "sandbox.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    container = (lines.filter((l) => l.sessionId === S.sessionId).at(-1) ?? lines.at(-1))?.container ?? null;
  } catch { /* no sandbox record */ }
  if (!container) return { skipped: "no container recorded in log/sandbox.jsonl" };
  const results = [];
  await execFileP("docker", ["start", container]).catch((e) => log(`docker start: ${String(e.message).slice(0, 120)}`));
  for (const cmd of task.verify) {
    const t0 = Date.now();
    try {
      const { stdout, stderr } = await execFileP("docker", ["exec", container, "bash", "-lc", cmd], { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 });
      results.push({ cmd, exit: 0, ms: Date.now() - t0, stdout: stdout.slice(0, 20_000), stderr: stderr.slice(0, 4_000) });
    } catch (e) {
      results.push({ cmd, exit: e.code ?? null, ms: Date.now() - t0, stdout: String(e.stdout ?? "").slice(0, 20_000), stderr: String(e.stderr ?? e.message).slice(0, 4_000) });
    }
  }
  // Keep the workspace (with .git) for the morning review; node_modules is reproducible.
  try {
    await execFileP("bash", ["-c", `docker exec ${container} tar czf - --exclude=node_modules -C / workspace > ${JSON.stringify(join(runDir, "workspace.tgz"))}`], { timeout: 10 * 60_000, maxBuffer: 1024 });
  } catch (e) { log(`workspace export failed: ${String(e.message).slice(0, 160)}`); }
  await execFileP("docker", ["stop", "-t", "0", container]).catch(() => {});
  writeFileSync(join(runDir, "verify.json"), JSON.stringify({ container, results }, null, 2));
  writeFileSync(join(runDir, "verify.txt"), results.map((r) => `$ ${r.cmd}\n[exit ${r.exit}, ${r.ms} ms]\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}\n`).join("\n"));
  return { container, exits: results.map((r) => r.exit) };
}

// ---- main ------------------------------------------------------------------------------------------
// A task is a list of stages (a single-prompt task is one stage). Each stage is a user message; the
// agent works until its final message says STAGE COMPLETE or TASK COMPLETE, with continue prompts
// in between. After every stage the recall probes run, so recall is measured after whatever
// compactions the stage caused, and then the next stage adds a rule and more work.
async function probeTurn(session, label, text) {
  const timer = setTimeout(() => { log(`${label}: 5 min cap, cancelling`); session.cancel().catch(() => {}); }, 5 * 60_000);
  try { return await runTurn(session, await session.send(text), label, text); } finally { clearTimeout(timer); }
}

// Forced compaction between turns (eve's session.compact(), a different code path from the
// in-turn threshold compaction): queued at every stage boundary so the probes that follow always
// run on a fresh checkpoint. Waits for compaction.completed on the session stream.
async function forceCompact(session, label) {
  const t0 = Date.now();
  let res;
  try { res = await session.compact(); } catch (e) {
    log(`${label}: compact() failed: ${String(e.message ?? e).slice(0, 200)}`);
    return { status: "error", error: String(e.message ?? e).slice(0, 300) };
  }
  if (res.status !== "accepted") { log(`${label}: compact() -> ${res.status}`); return { status: res.status }; }
  const pseudo = { label, steps: 0, toolCalls: 0, costUsd: 0, compactions: 0, messages: [], pending: [], providers: new Set(), failed: null, lastInputTokens: null };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 180_000);
  let requested = false;
  let completed = false;
  try {
    for await (const ev of session.stream({ startIndex: -1, follow: true, signal: ac.signal })) {
      record(ev, pseudo);
      if (ev.type === "compaction.requested") requested = true;
      if (ev.type === "compaction.completed") { completed = true; break; }
      if (ev.type === "session.failed") break;
    }
  } catch (e) {
    if (!ac.signal.aborted) log(`${label}: stream error while waiting for compaction: ${String(e.message ?? e).slice(0, 200)}`);
  } finally { clearTimeout(timer); }
  const result = { status: "accepted", requested, completed, timedOut: ac.signal.aborted, ms: Date.now() - t0, inputTokens: pseudo.lastInputTokens };
  log(`${label}: forced compaction requested=${requested} completed=${completed} in ${Math.round(result.ms / 1000)} s`);
  transcript(`\n> forced compaction (${label}): ${JSON.stringify(result)}\n`);
  return result;
}

async function main() {
  const base = await waitForServer();
  log(`eve dev at ${base}; task ${taskName}, model ${model} via ${provider}, window ${window}, budget $${budgetUsd}, ${hours} h`);
  const { Client } = await import("eve/client");
  const client = new Client({ host: base });
  const stages = task.stages ?? [{ id: "s1", prompt: task.prompt }];
  const maxContinues = Number(flags["max-continues"] ?? task.maxContinues ?? 6);
  const stageMinutes = Number(flags["stage-minutes"] ?? task.stageMinutes ?? 150);
  const DONE = /STAGE COMPLETE|TASK COMPLETE/;
  let session = null;
  S.stages = [];
  for (const [si, stage] of stages.entries()) {
    if (stopping) break;
    const rec = { id: stage.id, startedAt: new Date().toISOString(), endedAt: null, turns: 0, steps: 0, toolCalls: 0, costUsd: 0, compactionsBefore: S.compactions.length, compactionsDuring: 0, completed: false, finalHead: "", forcedCompaction: null, probes: [] };
    S.stages.push(rec);
    const stageStart = Date.now();
    let turn;
    if (si === 0) {
      const created = await client.sessions.create({ message: stage.prompt });
      session = created.session;
      activeSession = session;
      S.sessionId = created.response.sessionId ?? null;
      log(`session ${S.sessionId}`);
      save();
      turn = await runTurn(session, created.response, `${stage.id}-turn-1`, stage.prompt);
    } else {
      turn = await runTurn(session, await session.send(stage.prompt), `${stage.id}-turn-1`, stage.prompt);
    }
    rec.turns = 1;
    let done = DONE.test(turn.finalMessage);
    for (let n = 2; !done && !stopping && n <= maxContinues + 1; n += 1) {
      if (S.spentUsd >= budgetUsd) { stopping = "budget"; break; }
      if (Date.now() >= deadline) { stopping = "deadline"; break; }
      if (Date.now() - stageStart > stageMinutes * 60_000) { log(`${stage.id}: stage time cap reached`); break; }
      if (turn.failed?.terminal) { stopping = "session-failed"; break; }
      log(`${stage.id} turn ${n}: continue (spent $${S.spentUsd.toFixed(3)}, ${S.compactions.length} compactions, ${S.steps} steps)`);
      turn = await runTurn(session, await session.send(task.continuePrompt), `${stage.id}-turn-${n}`, task.continuePrompt);
      rec.turns = n;
      done = DONE.test(turn.finalMessage);
    }
    const stageTurns = S.turns.filter((t) => t.label.startsWith(`${stage.id}-turn`));
    rec.completed = done;
    rec.finalHead = turn.finalMessage.replace(/\s+/g, " ").slice(0, 300);
    rec.compactionsDuring = S.compactions.length - rec.compactionsBefore;
    rec.steps = stageTurns.reduce((a, t) => a + t.steps, 0);
    rec.toolCalls = stageTurns.reduce((a, t) => a + t.toolCalls, 0);
    rec.costUsd = stageTurns.reduce((a, t) => a + t.costUsd, 0);
    rec.endedAt = new Date().toISOString();
    log(`${stage.id} ${done ? "complete" : "NOT complete"}: ${rec.steps} steps, ${rec.compactionsDuring} compactions, $${rec.costUsd.toFixed(3)}, ${rec.turns} turn(s)`);
    // Recall probes after the stage: cheap, and the point of the run. The watchdog is paused so a
    // deadline or SIGTERM does not cancel them; each probe has its own 5-minute cap. A forced
    // compaction first (unless --no-force-compact), so every probe set follows a fresh checkpoint.
    if (!S.serverExit && S.spentUsd < budgetUsd * 1.2) {
      const paused = activeSession;
      activeSession = null;
      if (task.stages && !flags["no-force-compact"]) rec.forcedCompaction = await forceCompact(session, `${stage.id}-compact`);
      for (const probe of task.probes ?? []) {
        if (S.serverExit) break;
        const t = await probeTurn(session, `${stage.id}-probe-${probe.id}`, probe.text);
        const p = { stage: stage.id, id: probe.id, text: probe.text, answer: t.finalMessage, toolCalls: t.toolCalls, costUsd: t.costUsd, failed: t.failed, compactionsSoFar: S.compactions.length };
        S.probes.push(p);
        rec.probes.push(probe.id);
      }
      activeSession = paused;
      writeFileSync(join(runDir, "probes.json"), JSON.stringify(S.probes, null, 2));
    }
    save();
  }
  S.completed = S.stages.length === stages.length && S.stages.every((s) => s.completed);
  S.stoppedBecause = stopping ?? (S.completed ? "completed" : "incomplete");
  activeSession = null;
  clearInterval(watchdog);
  log(`main work over: ${S.stoppedBecause}; spent $${S.spentUsd.toFixed(3)}, ${S.compactions.length} compactions, ${S.steps} steps`);

  log("verifying workspace");
  try { S.verify = await verify(); } catch (e) { S.verify = { error: String(e.message ?? e).slice(0, 500) }; }
  S.endedAt = new Date().toISOString();
  save();
  log(`done: completed=${S.completed}, stopped=${S.stoppedBecause}, $${S.spentUsd.toFixed(3)}, ${S.steps} steps, ${S.compactions.length} compactions, ${S.failures.length} failures, verify ${JSON.stringify(S.verify).slice(0, 200)}`);
}

async function shutdown(code) {
  clearInterval(watchdog);
  streamOut.end();
  if (!server.exitCode && !server.killed) {
    server.kill("SIGTERM");
    await Promise.race([new Promise((r) => server.on("exit", r)), new Promise((r) => setTimeout(r, 10_000))]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  process.exit(code);
}

main().then(() => shutdown(0)).catch(async (e) => {
  log(`driver failed: ${e.stack ?? e}`);
  S.failures.push({ at: new Date().toISOString(), type: "driver", message: String(e.message ?? e).slice(0, 500) });
  S.stoppedBecause ??= "driver-error";
  S.endedAt = new Date().toISOString();
  save();
  await shutdown(1);
});
