import { writeFileSync } from "node:fs";

import { it } from "vitest";

import * as anchors from "#harness/compaction/engine.anchors.js";
import * as fix4771 from "#harness/compaction/engine.fix4771.js";
import * as headtail from "#harness/compaction/engine.headtail.js";
import * as eveDefault from "#harness/compaction/engine.js";
import type { CompactionConfig } from "#harness/types.js";

import { replay, type Engine, type Summarizer } from "./replay.js";
import { generateSession } from "./sessions.js";

// Run from packages/eve:
//   BENCH_LAYER=offline BENCH_OUT=/abs/out.json npx vitest run --config vitest.bench.config.ts

const STRATEGIES: Record<string, Engine> = {
  "eve-default": eveDefault,
  "fix-4771": fix4771,
  "head-tail": headtail,
  "head-tail+anchors": anchors,
};
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
          : (await import("./gateway.js")).gatewaySummarizer();
    const jobs = seeds.flatMap((seed) =>
      Object.entries(STRATEGIES)
        .filter(([strategy]) => !only || only.includes(strategy))
        .map(async ([strategy, engine]) => {
          const session = generateSession(seed, turns);
          const run = await replay(session, engine, config, summarizer, { maxRounds, maxSummaryRounds, stopAtSummary: layer === "offline" });
          return { seed, session: session.name, strategy, ...run };
        }),
    );
    const results = await Promise.all(jobs);
    writeFileSync(out, JSON.stringify({ config, layer, maxRounds, maxSummaryRounds, model: process.env.BENCH_MODEL, results, seeds, turns }, null, 1));
  },
  60 * 60 * 1000,
);
