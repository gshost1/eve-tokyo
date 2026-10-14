# eve-tokyo

Compaction drift benchmark for [eve](https://github.com/vercel/eve) agents.

Long agent runs compact more than once, and each compaction rewrites the last
checkpoint. eve-tokyo measures what survives: it replays long coding sessions through
eve's real compaction engine, compacts them repeatedly, and scores which exact details
(file paths, error strings, commands, decisions) are still in context after each round,
alongside context reduction, cost and latency.

## Results

**Every build and test run in these sessions failed. Under eve's head-only tool-result cap,
the checkpoint model reported some of them as successful in 7 of 30 checkpoints
("`tsc` compile ran cleanly (empty stderr)"). With a head + tail cap: 0 of 30.**

Measured against eve at [`0fd4240`](https://github.com/vercel/eve/commit/0fd4240d31c0fdf18e61dfdedf3c203eb595bba2)
(eve 0.79.0), 3 synthetic sessions, summarizer `anthropic/claude-haiku-5.5` via Vercel AI Gateway.
60 summary calls, about $0.80 in total.

### Two bugs found and filed

- [vercel/eve#4769](https://github.com/vercel/eve/issues/4769): an already-capped tool result is
  capped again at every later compaction, so its content shrinks each round (400-line grep:
  60 → 48 → 35 paths visible). Confirmed by the eve team; fix in
  [vercel/eve#4771](https://github.com/vercel/eve/pull/4771).
  Repro: [gshost1/eve-recap-repro](https://github.com/gshost1/eve-recap-repro).
- [vercel/eve#4772](https://github.com/vercel/eve/issues/4772): the cap keeps only the first
  2,000 chars of a result, so test failures, compiler errors and bash's `exitCode` are lost
  first, while eve's own `bash` tool deliberately keeps the end of output.

### Cap path (no model)

eve first caps old tool results to 2,000 chars and only summarizes if that isn't enough.
After the first cap, by where a detail sat inside a tool result (all 3 sessions):

| Strategy | Start of result | Middle | End of result | Error strings |
|---|---|---|---|---|
| eve default | 100% | 23% | 11% | 8% |
| head + tail cap | 100% | 21% | 100% | 100% |

Capping alone ratchets: it never shrinks anything but tool results, so each round frees less
(58% of context in round 1, ~5% by round 8) and compactions come closer together (every ~27
steps, then every 1–4). The #4769 bug makes eve fall back to a model summary sooner: after 5–6
cap rounds instead of 8–12 with the fix.

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

- After one summary, ~95% of exact error strings are gone; after five, ~99%.
- Only the identifier index holds steady across rounds (paths 9–11% at every round). Its
  6,000-char budget is the ceiling, not the summarizer.
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

- The recall-after-compaction framing and the identifier ("anchor") index come from
  [Nous Research's Hermes compaction eval](https://github.com/NousResearch/hermes-agent/tree/main/evals/compaction).
  Their [2026-09-19 scorecard](https://github.com/NousResearch/hermes-agent/blob/main/evals/compaction/results/SCORECARD-2026-09-19-jev.md)
  also covers Jev-scored pruning ([tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)),
  which this benchmark does not re-run.
- eve is Apache-2.0, © Vercel.
