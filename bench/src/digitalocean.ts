import { request } from "node:https";

import type { ModelMessage } from "ai";

import type { Summarizer } from "./replay.js";

// Real summarizer through DigitalOcean serverless inference (OpenAI-compatible chat completions).
// Same call shape as eve's summary: eve's system prompt plus one user message, nothing else.
// DO_KEY comes from the environment (`keys env hack-token DO_KEY -- ...`); never logged.
const ENDPOINT = "https://inference.do-ai.run/v1/chat/completions";

// Plain HTTPS/1.1, new connection per call. Node's fetch pins one HTTP/2 session per origin, and
// once DigitalOcean drops it every retry fails on the dead session (ERR_HTTP2_INVALID_SESSION).
function post(body: string, key: string): Promise<{ ok: boolean; status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      ENDPOINT,
      {
        agent: false,
        headers: { authorization: `Bearer ${key}`, "content-length": Buffer.byteLength(body), "content-type": "application/json" },
        method: "POST",
        timeout: 600_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, text: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

function text(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

export function digitalOceanSummarizer(model = process.env.BENCH_MODEL ?? "anthropic-claude-5.5-haiku"): Summarizer {
  const key = process.env.DO_KEY;
  if (!key) throw new Error("DO_KEY not set");
  return async ({ messages, system }) => {
    const body = JSON.stringify({
      messages: [{ content: system, role: "system" }, ...messages.map((m) => ({ content: text(m), role: m.role }))],
      model,
    });
    const t0 = Date.now();
    for (let attempt = 1; ; attempt += 1) {
      let res: { ok: boolean; status: number; text: string };
      try {
        res = await post(body, key);
      } catch (error) {
        if (attempt >= 8) throw error;
        await new Promise((r) => setTimeout(r, Math.min(60_000, 2_000 * 2 ** attempt)));
        continue;
      }
      if (res.ok) {
        const json = JSON.parse(res.text) as {
          choices: { message: { content: string | null } }[];
          usage?: { completion_tokens?: number; prompt_tokens?: number };
        };
        return {
          costUsd: 0, // priced afterwards from token counts
          inputTokens: json.usage?.prompt_tokens ?? 0,
          ms: Date.now() - t0,
          outputTokens: json.usage?.completion_tokens ?? 0,
          text: json.choices[0]?.message.content ?? "",
        };
      }
      const detail = res.text.slice(0, 300);
      if (attempt >= 5 || (res.status !== 429 && res.status < 500)) {
        throw new Error(`DigitalOcean ${model}: HTTP ${res.status} ${detail}`);
      }
      await new Promise((r) => setTimeout(r, 2_000 * 2 ** attempt));
    }
  };
}
