import type { ModelMessage } from "ai";

import type { CompactionConfig } from "#harness/types.js";
import { estimateTokens } from "#harness/token-estimate.js";

import type { Anchor, AnchorKind, AnchorWhere, Session } from "./sessions.js";

export interface Engine {
  compactMessages(
    messages: ModelMessage[],
    config: CompactionConfig,
    summarize: (p: { messages: ModelMessage[]; system: string }) => Promise<string>,
  ): Promise<ModelMessage[]>;
  shouldCompact(messages: readonly ModelMessage[], config: CompactionConfig): boolean;
}

export interface SummaryCall {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly ms: number;
}

export type Summarizer = (p: { messages: ModelMessage[]; system: string }) => Promise<{ text: string } & SummaryCall>;

export interface Round {
  readonly round: number;
  readonly step: number;
  readonly path: "cap" | "summary";
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly summary?: SummaryCall;
  /** Anchors introduced so far, and how many are still present verbatim. */
  readonly byKind: Record<AnchorKind, { present: number; total: number }>;
  readonly byWhere: Record<AnchorWhere, { present: number; total: number }>;
  readonly lost: string[];
  /** Decisions kept as a paraphrase: chosen lib, rejected lib and area in one sentence. */
  readonly decisionLoose: { present: number; total: number };
  /** Summary rounds only: the checkpoint text the next model sees. */
  readonly checkpoint?: string;
}

const KINDS: AnchorKind[] = ["path", "error", "command", "decision"];
const WHERES: AnchorWhere[] = ["head", "middle", "tail", "call", "text"];

function tally(anchors: readonly Anchor[], context: string) {
  const byKind = Object.fromEntries(KINDS.map((k) => [k, { present: 0, total: 0 }])) as Round["byKind"];
  const byWhere = Object.fromEntries(WHERES.map((w) => [w, { present: 0, total: 0 }])) as Round["byWhere"];
  const lost: string[] = [];
  for (const anchor of anchors) {
    const hit = context.includes(anchor.text);
    byKind[anchor.kind].total += 1;
    byWhere[anchor.where].total += 1;
    if (hit) {
      byKind[anchor.kind].present += 1;
      byWhere[anchor.where].present += 1;
    } else {
      lost.push(anchor.id);
    }
  }
  const sentences = context.toLowerCase().split(/\\n|[.!?;\n]/);
  const decisions = anchors.filter((a) => a.kind === "decision");
  const decisionLoose = {
    present: decisions.filter((a) => sentences.some((s) => a.loose!.every((w) => s.includes(w.toLowerCase())))).length,
    total: decisions.length,
  };
  return { byKind, byWhere, decisionLoose, lost };
}

/**
 * Plays a session forward one step at a time. Before each model call (after every step),
 * compacts when the engine says it is due, exactly as the harness would.
 */
export async function replay(
  session: Session,
  engine: Engine,
  config: CompactionConfig,
  summarizer: Summarizer,
  opts: { maxRounds: number; maxSummaryRounds?: number; stopAtSummary?: boolean },
): Promise<{ rounds: Round[]; stoppedAt?: string }> {
  let history: ModelMessage[] = [];
  const introduced: Anchor[] = [];
  const rounds: Round[] = [];

  for (let i = 0; i < session.steps.length; i += 1) {
    const step = session.steps[i]!;
    history = [...history, ...step.messages];
    introduced.push(...step.anchors);
    if (!engine.shouldCompact(history, config)) continue;

    let call: SummaryCall | undefined;
    if (opts.stopAtSummary) {
      // Offline layer: detect whether the cap path suffices without calling a model.
      let needsSummary = false;
      await engine.compactMessages(history, config, async () => {
        needsSummary = true;
        throw new Error("offline");
      }).catch((e: unknown) => {
        if (!(e instanceof Error && e.message === "offline")) throw e;
      });
      if (needsSummary) return { rounds, stoppedAt: `step ${i}: cap path insufficient, summary needed` };
    }

    const before = estimateTokens(history);
    history = await engine.compactMessages(history, config, async (p) => {
      const result = await summarizer(p);
      call = { costUsd: result.costUsd, inputTokens: result.inputTokens, ms: result.ms, outputTokens: result.outputTokens };
      return result.text;
    });
    const context = JSON.stringify(history);
    const head = history[1];
    rounds.push({
      checkpoint: call !== undefined && head?.role === "assistant" && typeof head.content === "string" ? head.content : undefined,
      path: call === undefined ? "cap" : "summary",
      round: rounds.length + 1,
      step: i,
      summary: call,
      tokensAfter: estimateTokens(history),
      tokensBefore: before,
      ...tally(introduced, context),
    });
    if (rounds.length >= opts.maxRounds) break;
    if (opts.maxSummaryRounds !== undefined && rounds.filter((r) => r.path === "summary").length >= opts.maxSummaryRounds) break;
  }
  return { rounds };
}
