import { generateText } from "ai";

import type { Summarizer } from "./replay.js";

// Real summarizer through Vercel AI Gateway. AI_GATEWAY_API_KEY comes from the environment
// (injected per run with `keys env jev-ass AI_GATEWAY_API_KEY -- ...`); never logged.
export function gatewaySummarizer(model = process.env.BENCH_MODEL ?? "anthropic/claude-haiku-5.5"): Summarizer {
  if (!process.env.AI_GATEWAY_API_KEY) throw new Error("AI_GATEWAY_API_KEY not set");
  return async ({ messages, system }) => {
    const t0 = Date.now();
    const result = await generateText({ maxRetries: 3, messages, model, system, temperature: 0 });
    const gateway = (result.providerMetadata?.gateway ?? {}) as { cost?: string | number };
    return {
      costUsd: Number(gateway.cost ?? 0),
      inputTokens: result.usage.inputTokens ?? 0,
      ms: Date.now() - t0,
      outputTokens: result.usage.outputTokens ?? 0,
      text: result.text,
    };
  };
}
