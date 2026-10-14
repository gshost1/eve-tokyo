# eve-tokyo notes

## Prior-art sweep (2026-10-13)

Searched: general web, arXiv, Factory blog, eve docs (unpkg), GitHub (repos, issues, code), X via OpenCLI.

### Verdict

- "Measuring compaction drift" is not new in general. Don't claim the term or the idea as first.
- Still open (as far as found): **numbers for eve**, and **recall scored across repeated
  summary-update cycles** (summary of a summary at 1, 2, 3, 5 compactions), per detail type
  (file paths, error strings, commands, decisions).
- Jev-scored pruning has already been benchmarked negatively by Nous Research. Use it as a
  known-weak baseline and cite their result; don't headline it as the contender.

### Closest prior work

**Nous Research, Hermes compaction eval** — <https://github.com/NousResearch/hermes-agent/tree/main/evals/compaction>
- Method: real 500K-token session lineages, compact, a fresh model answers a 15-question recall
  exam from post-compaction context only, LLM judge grades. Also tracks retained tokens,
  compaction cost and wall time. Transcripts not committed.
- `jev_arm.py` is a Python port of tamaratran/fast-jev-compaction.
- `results/SCORECARD-2026-09-19-jev.md` ("do not adopt Jev"):
  - Jev 75.5% recall @ 115K retained vs Hermes summary + one session_search 78.9% @ 55K.
  - At a matched token budget Jev ranked no better than recency (77.8 vs 77.8).
  - Recall gain came from keeping user/assistant text verbatim and deleting old tool output,
    not from Jev's scoring.
  - Repeated cycles (`scripts/jev_cycles.py`): freed-per-compaction decayed 89%→55%, 76%→20%,
    63%→8% over 32–40 cycles; one 200K-window run got stuck after 0.4M tokens of work.
  - Jev: 1.4 s and <1¢ per compaction vs 37 s and 6¢ for the summary.
- `results/SCORECARD-2026-08-15.md`: lost facts were delegation ids, root causes, config keys,
  exact error strings. A mechanical anchor index of exact identifiers fixed much of it
  (GUI closed-book 23.3→60.0). Candidate fix to test on eve.
- Gap: recall is scored after one compaction; repeated-cycle runs track only freed tokens, Jev arm only.
- Teknium's X thread (2026-09-19): <https://x.com/i/status/2101398453578555898>. Scoped as a
  critique of that compaction repo, not of Jev in general.

**Papers**
- The Compaction Cliff (arXiv 2608.22752, Aug 2026, CIKM 2026): Claude Code `/compact` keeps
  53% of safety rules after 1 round, 10% after 5. Safety rules / log entries only, not eve.
  Read abstract only.
- Lost in Compaction: Side-Constraint Loss (arXiv 2608.11242): compactors keep ~17% of planted
  session constraints.
- Lost in Compaction: Measuring Information Loss (HF forum preprint, code on GitHub): very low
  fact recall from compacted region; compaction nondeterministic at temperature 0. Not opened
  in full; unknown whether multi-round.
- ContextEcho (arXiv 2605.24279): persona drift across 5 compactions in coding sessions.
- CliffCompaction (arXiv 2609.26779): discards previous compacted output at each new compaction
  to avoid drift. Opposite design to eve's update-the-checkpoint.
- Slipstream (arXiv 2605.08580), Parallel Context Compaction (arXiv 2605.23296): background.

**Industry**
- Factory.ai, Dec 2025 (<https://factory.com/news/evaluating-compression>): probe-based eval on
  real sessions. Overall 3.70 Factory / 3.44 Anthropic / 3.35 OpenAI (of 5); artifact trail
  weakest for all (~2.2–2.45). No repeated-compaction experiment; dataset not released.

### Name and neighbours

- `kbipul/compaction-drift` already uses the name "Compaction Drift": arithmetic simulator of
  standing-rule survival, no real measurements. No overlap on substance, but name clashes.
- Jev compaction already ported to pi (`joelhooks/pi-fast-jev-compaction`) and oh-my-pi
  (`Reamd7/omp-fast-jev-compaction`), plus ~30 other forks.
- `n3pt7un/agentsec#2`: proposal for a behavioural compaction-drift probe (security framing).

### eve-specific

- No Vercel eval of checkpoint quality found. eve docs describe the checkpoint prompt only.
- eve issues: nothing on drift benchmarks. Related: #749 (compaction can reset task progress and
  repeat tool calls), #1844, #2653 (evals discard token usage), #3483 (no durable usage evidence
  for compaction calls). Already proposed by others, don't claim: #1040, #905.
- X: only anecdotes about eve compaction, no numbers.

### Revised pitch angle

Measure eve's summary-of-a-summary loop over 1, 2, 3, 5 compactions with Nous's recall-exam
method (credited), score by detail type, and test an exact-identifier index as the fix.
Cite Nous for Jev instead of re-running it as the headline.

## eve compaction engine (read at vercel/eve 0fd4240, 2026-10-13)

Files: `packages/eve/src/harness/compaction/engine.ts`, `prompt.ts`.

1. Trigger: last provider-reported input tokens + estimate of newer messages + prompt
   envelope > threshold (default 90% of window). `engine.ts:66`
2. Cap pass, no model: every older tool result whose JSON exceeds 2,000 chars becomes
   annotation + the **first** 2,000 chars of that JSON. Previous checkpoint carried over
   unchanged. If under threshold, done, no summary. `engine.ts:121`, `:270`
3. Summary fallback: older region + previous checkpoint (never truncated) → "Update the
   previous checkpoint". Prompt asks to preserve exact file paths, function names, commands,
   error messages, identifiers. That promise is the scoring target. `prompt.ts:22`
4. Still over: keep recent tail verbatim → strip it to text → shrink window by one. `engine.ts:215`
5. Over-budget transcript: oldest text capped to 2,000 chars, tool payloads to 280. `prompt.ts:85`
6. `CompactionHeuristic` is sync; `COMPACTION_HEURISTICS = [toolResultCapHeuristic]`. `engine.ts:105`, `:113`

### Bug: capped tool results are re-capped every compaction (confirmed)

`capToolResults` has no already-capped check. A capped result's JSON (annotation + escaped
payload) is over 2,000 chars again, so each later compaction wraps and re-escapes it.

Repro: [`probes/recap.probe.test.ts`](probes/recap.probe.test.ts), run against eve's real engine
(passes; eve's own 44 engine tests still pass). 4 compactions, cap path only (summarizer throws
if called, never called), a 400-path grep result ending in a FAIL line:

| Round | Annotations | Backslashes | Module paths kept (of 400) | FAIL line kept |
|---|---|---|---|---|
| 1 | 1 | 180 | 60 | no |
| 2 | 2 | 393 | 48 | no |
| 3 | 3 | 663 | 35 | no |
| 4 | 4 | 917 | 22 | no |

- Length stays 2,113 chars; real content is displaced by stacked annotations and backslashes.
- Bites while compactions keep taking the cap path. Once the summary path runs, those older
  messages are folded into the checkpoint and the chain ends.
- Head-only cap: tail content (test failures, compiler errors, stack traces) is lost in round 1.
- Fix: skip results whose value already starts with the annotation (`engine.ts:270`).
  Separately, keep head + tail.
- No existing report found on vercel/eve (searched issues and PRs). Nearest: #1040 (different change).

Run it (eve clone, Node 24, pnpm):

```bash
pnpm install --frozen-lockfile --ignore-scripts --filter eve...
cp probes/recap.probe.test.ts <eve>/packages/eve/src/harness/compaction/
cd <eve>/packages/eve && npx vitest run --config vitest.unit.config.ts --silent=false src/harness/compaction/recap.probe.test.ts
```

### Benchmark implications

- Log per round whether the cap path or summary path ran; they drift differently.
- Score head-of-output vs tail-of-output errors separately.

### Not confirmed (prior-art sweep)

- Read only the abstract of The Compaction Cliff and the forum post for the HF preprint.
- Read only the Nous README and the two scorecards, not runner code or the Codex head-to-head in full.
- X search returns ~15 top results per query; not exhaustive.
- GitHub code search covered `TRANSCRIPT_PAYLOAD_LIMIT` and compaction-eval terms only.
