import { writeFileSync } from "node:fs";

import { it } from "vitest";

import type { CompactionConfig } from "#harness/types.js";

import { replay, type Summarizer } from "./replay.js";
import { generateSession } from "./sessions.js";
import { EVE_SHA, STRATEGIES } from "./strategies.js";

// Run from packages/eve (bench/setup.sh generates strategies.ts for the pinned eve commit):
//   BENCH_LAYER=offline BENCH_OUT=/abs/out.json npx vitest run --config vitest.bench.config.ts
const only = process.env.BENCH_STRATEGIES?.split(",");

const layer = process.env.BENCH_LAYER ?? "offline";
const out = process.env.BENCH_OUT ?? "/dev/stdout";
const seeds = (process.env.BENCH_SEEDS ?? "1,2,3").split(",").map(Number);
const turns = Number(process.env.BENCH_TURNS ?? 40);
const maxRounds = Number(process.env.BENCH_MAX_ROUNDS ?? 8);
const maxSummaryRounds = process.env.BENCH_SUMMARY_ROUNDS ? Number(process.env.BENCH_SUMMARY_ROUNDS) : undefined;
const config: CompactionConfig = {
  recentWindowSize: 10, // eve's default
  threshold: Number(process.env.BENCH_THRESHOLD ?? 60_000),
};

// Control arm: a summarizer that keeps nothing. Shows what survives without any summary.
const nullSummarizer: Summarizer = async () => ({ costUsd: 0, inputTokens: 0, ms: 0, outputTokens: 0, text: "(no summary)" });

const offlineSummarizer: Summarizer = async () => {
  throw new Error("offline layer never summarizes");
};

it(
  `eve-tokyo bench (${layer})`,
  async () => {
    const summarizer =
      layer === "offline"
        ? offlineSummarizer
        : layer === "null-summary"
          ? nullSummarizer
          : layer === "do"
            ? (await import("./digitalocean.js")).digitalOceanSummarizer()
            : (await import("./gateway.js")).gatewaySummarizer();
    const tasks = seeds.flatMap((seed) =>
      Object.entries(STRATEGIES)
        .filter(([strategy]) => !only || only.includes(strategy))
        .map(([strategy, engine]) => async () => {
          const session = generateSession(seed, turns);
          const run = await replay(session, engine, config, summarizer, { maxRounds, maxSummaryRounds, stopAtSummary: layer === "offline" });
          return { seed, session: session.name, strategy, ...run };
        }),
    );
    // Some providers drop connections under many parallel requests; BENCH_CONCURRENCY caps it.
    const limit = Number(process.env.BENCH_CONCURRENCY ?? tasks.length);
    const results: Awaited<ReturnType<(typeof tasks)[number]>>[] = new Array(tasks.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, tasks.length) }, async () => {
        while (next < tasks.length) {
          const i = next++;
          try {
            results[i] = await tasks[i]!();
          } catch (error) {
            // Keep the other sessions' results; record what failed.
            results[i] = { error: String(error).slice(0, 500), rounds: [], seed: -1, session: "", strategy: `task-${i}` } as never;
          }
        }
      }),
    );
    writeFileSync(out, JSON.stringify({ config, eve: EVE_SHA, layer, maxRounds, maxSummaryRounds, model: process.env.BENCH_MODEL, results, seeds, turns }, null, 1));
  },
  60 * 60 * 1000,
);
