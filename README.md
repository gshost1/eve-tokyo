# eve-tokyo

Compaction drift benchmark for [eve](https://github.com/vercel/eve) agents.

eve's compaction is a thoughtful design: it trims old tool output before ever calling a
model, so most compactions are fast and free, and it only writes a summary when trimming isn't
enough. Long agent runs still compact many times, and each summary updates the last one.
eve-tokyo measures what survives: it replays long coding sessions through
eve's real compaction engine, compacts them repeatedly, and scores which exact details
(file paths, error strings, commands, decisions) are still in context after each round,
alongside context reduction, cost and latency.

## Results

**The biggest easy win: keep the end of each trimmed tool output, not just the start.**
Every build and test run in these sessions failed, and the failure was always at the end of
the output. Keeping only the start, the summary described a failing build as passing in 7 of 30
checkpoints ("`tsc` compile ran cleanly (empty stderr)"). Keeping the start and the end: 0 of 30.

Measured against eve at [`0fd4240`](https://github.com/vercel/eve/commit/0fd4240d31c0fdf18e61dfdedf3c203eb595bba2)
(eve 0.79.0), 3 synthetic sessions, summarizer `anthropic/claude-haiku-5.5` via Vercel AI Gateway.
60 summary calls, about $0.80 in total.

### Contributed upstream

- [vercel/eve#4769](https://github.com/vercel/eve/issues/4769): an already-capped tool result is
  capped again at every later compaction, so its content shrinks each round (400-line grep:
  60 → 48 → 35 paths visible). The eve team confirmed it and had a fix up within hours:
  [vercel/eve#4771](https://github.com/vercel/eve/pull/4771).
  Repro: [gshost1/eve-recap-repro](https://github.com/gshost1/eve-recap-repro).
- [vercel/eve#4772](https://github.com/vercel/eve/issues/4772): proposes keeping the start and
  the end of a capped result. eve's `bash` tool already keeps the end of output because that's
  where errors appear; compaction can follow the same idea so test failures, compiler errors and
  `exitCode` survive.

### Cap path (no model)

eve first caps old tool results to 2,000 chars and only summarizes if that isn't enough.
After the first cap, by where a detail sat inside a tool result (all 3 sessions):

| Strategy | Start of result | Middle | End of result | Error strings |
|---|---|---|---|---|
| eve default | 100% | 23% | 11% | 8% |
| head + tail cap | 100% | 21% | 100% | 100% |

Trimming only ever touches tool results, so over a long run each round frees less
(58% of context in round 1, ~5% by round 8) and compactions come closer together (every ~27
steps, then every 1–4). That's when the summary takes over. With the #4771 fix, trimming lasts
longer before a summary is needed: 8–12 rounds instead of 5–6.

### Summary path (summary of a summary)

Share of every exact detail introduced so far that is still in context, mean of 3 seeds,
after the 1st and 5th summary. "Decisions" counts a paraphrase that keeps the chosen option,
the rejected one and the area in one sentence.

| Strategy | Paths | Errors | Commands | Decisions |
|---|---|---|---|---|
| eve default | 26% → 3% | 5% → 1% | 62% → 1% | 81% → 40% |
| #4771 fix | 20% → 5% | 6% → 1% | 69% → 33% | 68% → 32% |
| head + tail cap | 17% → 1% | 6% → 1% | 11% → 2% | 78% → 36% |
| head + tail + identifier index | 11% → 9% | 11% → 2% | 12% → 3% | 67% → 76% |

- Summaries keep the meaning well (decisions survive as paraphrase) but drop exact strings:
  after one summary ~5% of exact error strings remain, after five ~1%. That's expected of any
  summarizer, and it's what an exact-reference list is for.
- The identifier index holds steady across rounds (paths 9–11% at every round), limited mainly by
  its 6,000-char budget.
- Per summary: $0.012–0.015, 18–34 s, ~93–96K input tokens. eve budgets the summary prompt at
  the 60K threshold using a chars/4 estimate; real input was ~1.55× that on this content.

Per-round tables: `python3 bench/report.py results/model-haiku.json --md`.

### Caveats

- 3 seeds, and the gateway ignores `temperature` for Haiku 5.5, so summaries vary run to run.
  Read the tables as direction, not precision; the middle rows move between rounds.
- Sessions are synthetic. Errors are planted at the end of outputs (as with real test and build
  runs), which favours a head + tail cap by construction.
- Retention is exact substring match over the whole kept context, against every detail ever
  introduced, so long sessions score low by design.
- False-success claims were counted with a regex over the checkpoint texts.

## Strategies

| Name | Change to eve's engine |
|---|---|
| eve default | none |
| #4771 fix | skip results that already start with the cap annotation |
| head + tail cap | #4771 fix, and keep the first 60% / last 40% of an oversized payload, in both the history cap and the summarizer transcript |
| head + tail + identifier index | head + tail, and append a mechanically extracted list of paths, error lines and commands to every checkpoint |

Each is a small patch in [`bench/patches/`](bench/patches) applied to a copy of eve's real
`engine.ts` / `prompt.ts`; everything else is eve's own code.

## Run it

Needs Node 24+ and pnpm.

```bash
./bench/setup.sh
cd .cache/eve/packages/eve
BENCH_LAYER=offline BENCH_OUT=$PWD/offline.json npx vitest run --config vitest.bench.config.ts
python3 ../../../../bench/summarize.py offline.json
```

Layers: `offline` (cap path only, stops when a summary would be needed), `null-summary`
(a summarizer that keeps nothing, free), `model` (real summarizer; needs `AI_GATEWAY_API_KEY`,
`BENCH_MODEL` defaults to `anthropic/claude-haiku-5.5`). Other knobs: `BENCH_SEEDS`,
`BENCH_TURNS`, `BENCH_SUMMARY_ROUNDS`, `BENCH_MAX_ROUNDS`, `BENCH_STRATEGIES`, `BENCH_THRESHOLD`.

## Credits

Thanks to the eve team at Vercel for an open, readable codebase and a very fast turnaround on
#4769.

- The recall-after-compaction framing and the identifier ("anchor") index come from
  [Nous Research's Hermes compaction eval](https://github.com/NousResearch/hermes-agent/tree/main/evals/compaction).
  Their [2026-09-19 scorecard](https://github.com/NousResearch/hermes-agent/blob/main/evals/compaction/results/SCORECARD-2026-09-19-jev.md)
  also covers Jev-scored pruning ([tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)),
  which this benchmark does not re-run.
- eve is Apache-2.0, © Vercel.
