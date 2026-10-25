import { createGateway, generateText } from "ai";

import type { Summarizer } from "./replay.js";

// Real summarizer through Vercel AI Gateway. AI_GATEWAY_API_KEY comes from the environment
// (injected per run with `keys env jev-ass AI_GATEWAY_API_KEY -- ...`, or a Keysrs grant/client
// token when AI_GATEWAY_BASE_URL points at the Keysrs gateway or relay); never logged.
// AI_GATEWAY_BASE_URL, when set, replaces the SDK default (https://ai-gateway.vercel.sh/v4/ai).
export function gatewaySummarizer(model = process.env.BENCH_MODEL ?? "anthropic/claude-haiku-5.5"): Summarizer {
  if (!process.env.AI_GATEWAY_API_KEY) throw new Error("AI_GATEWAY_API_KEY not set");
  const gateway = createGateway({
    apiKey: process.env.AI_GATEWAY_API_KEY,
    ...(process.env.AI_GATEWAY_BASE_URL ? { baseURL: process.env.AI_GATEWAY_BASE_URL } : {}),
  });
  return async ({ messages, system }) => {
    const t0 = Date.now();
    const result = await generateText({ maxRetries: 3, messages, model: gateway(model), system, temperature: 0 });
    const meta = (result.providerMetadata?.gateway ?? {}) as { cost?: string | number };
    return {
      costUsd: Number(meta.cost ?? 0),
      inputTokens: result.usage.inputTokens ?? 0,
      ms: Date.now() - t0,
      outputTokens: result.usage.outputTokens ?? 0,
      text: result.text,
    };
  };
}
