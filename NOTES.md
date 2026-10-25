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

## Rerun at the merged fix (vercel/eve a3654ef7e, read 2026-10-25)

a3654ef7e is the merge of #4773 (head + tail cap) and contains #4771 (idempotent cap). Between
0fd4240 and a3654ef7e nothing else in `harness/compaction/` changed (#4770 added a test). The next
compaction change upstream is #5199 (2026-10-24, mid-turn announcement), unrelated to capping.

Upstream's implementation vs the eve-tokyo `head-tail` patch: same shape. `clipMiddleUtf16Safe`
keeps `ceil(0.6 * kept)` head chars and the rest as tail with a ` … [N chars omitted] … ` marker,
sized so the whole value stays within `TRANSCRIPT_PAYLOAD_LIMIT`; applied in `capToolResults` and,
through `capPayload`, to tool results and tool calls in the summarizer transcript. The patch used
the same 60/40 split and marker but did not count the marker against the limit.

### Engine level (free, deterministic)

Probes, `./bench/probes.sh` at a3654ef7e:

| Probe | At 0fd4240 (bug) | At a3654ef7e |
|---|---|---|
| headcap: FAIL line / error / summary line / `exitCode` kept after one cap | no / no / no / no, 44 passing lines | yes / yes / yes / yes, 35 passing lines, elision marker present |
| recap: annotations per round, module paths kept (of 400) | 1,2,3,4; 60 → 48 → 35 → 22 | 1,1,1,1; 57 every round, value byte-identical, FAIL line kept |

The original bug probes fail at a3654ef7e on exactly the assertions that encoded the bug
(`failLineKept` is now true; annotations are `[1,1,1,1]`). `probes/*.fixed.probe.test.ts` pass.

Offline layer (cap path only, 3 seeds, `results/offline-4773.json`), eve as shipped (`eve-4773`):

| | eve default at 0fd4240 | head-tail patch at 0fd4240 | eve-4773 |
|---|---|---|---|
| tail details after cap 1 (seed 1) | 5/43 | 43/43 | 43/43 |
| exact errors after cap 1 (seed 1) | 1/21 | 21/21 | 21/21 |
| paths after cap 1 (seed 1) | 23/52 | 40/52 | 40/52 |
| cap rounds before a summary is needed | 5–6 | 8+ (run cap) | 8+ (run cap) |

eve-4773 tracks the head-tail patch within a few paths per round (e.g. seed 1 r8: 112/153 vs
108/146 paths, tails 126/126 vs 121/121) and keeps 100% of tail details on every round.

### Model level (2026-10-25, InstaBox + Keysrs relay)

Same shape as the published runs (160 turns, up to 80 compactions, 5 summaries, seeds 1–3), eve at
a3654ef7e unpatched (`eve-4773`), all summarizers through Vercel AI Gateway. `results/gw-fix-*.json`.

| Summarizer | false "passed": default @0fd4240 → head-tail patch → eve @a3654ef | paths S1→S5 | errors S1→S5 | $/15 summaries | s/summary |
|---|---|---|---|---|---|
| anthropic/claude-haiku-5.5 | 3 → 0 → 0 | 13% → 1% | 4% → 1% | 0.22 | 35 |
| openai/gpt-6-luna-fast | 1 → 0 → 0 | 9% → 2% | 10% → 2% | 0.21 | 7 |
| google/gemini-3.8-flash | 0 → 0 → 0 | 10% → 4% | 4% → 1% | 0.94 | 16 |
| deepseek/deepseek-v4.1-flash | 15 → 0 → 0 | 5% → 1% | 4% → 1% | 0.35 | 24 |
| alibaba/qwen3.8-max | 10 → 0 → 0 | 30% → 7% | 36% → 8% | 3.16 | 69 |
| moonshotai/kimi-k2.6 | 8 → 0 → not run | | | | |

- Pooled: head-only 72/180; head + tail (patch 0/180 + fix 0/75) 0/255.
- First summary at rounds 10/15/12 (seeds 1/2/3) vs 6/7/6 for the old default; the patch had 11/9/13.
- Kimi stopped by hand after Qwen's bill (its partial file on the box is an error stub); grants revoked,
  box stopped (not deleted, machine `eve-tokyo`).

Run mechanics: `bench/instabox.mjs up/run/watch/fetch/down` over the InstaBox HTTP API (free plan:
`agent-browser` template only; no file-write route, so uploads go through exec stdin and downloads
through gzip + base64 chunks; exec is synchronous, 600 s max, so jobs detach with setsid and are polled
every 30 s; one transient 502 mid-poll). Keys: `keys env eve-instabox` for the box, a `keys grant
jev-ass --paths /v4/ai --max-usd` token piped into the driver; box → `https://keysrs-relay…/jev-ass/v4/ai`
→ Mac gateway → Vercel. Smoke (1 seed, 1 summary) before the full set. Total spend ≈ $5 incl. smokes
and a few Kimi calls.

Keysrs observations: raw key never left the Mac; revoke took effect within a second (403
`grant_revoked` in `keys log`); but the grant's USD column stayed 0.0000 over 84 requests, so
`--max-usd` cannot trigger for Vercel AI Gateway calls: the gateway doesn't price them, while the cost
is right there in the response's provider metadata, which the bench reads. Grants also die on screen
lock, so the Mac stayed unlocked for the run.

### Not confirmed
- Why Qwen's exact retention at the fix (30% → 7%) is well above every other row (5–13%); one run,
  gateway serving vs DigitalOcean, not investigated.
- Kimi at the fix (not run).
