import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";

// Provider-level recorder. eve's instrumentation reports the turn steps but not the compaction
// summary call (that one goes straight to the AI SDK with functionId "eve.compaction"), so this
// middleware sits on the model itself and sees every request: the exact prompt, the response
// text, usage and the gateway's provider metadata. For every compaction summary it dumps
//   contexts/<seq>-pre.json.gz           the last ordinary model input before the summary
//   contexts/<seq>-compaction-prompt.json.gz   the summary request (system + transcript)
//   contexts/<seq>-checkpoint.json.gz    the checkpoint text the model returned
//   contexts/<seq>-post.json.gz          the first ordinary model input built on the checkpoint
// and one line per call to llm-calls.jsonl.
const dir = process.env.LONGRUN_LOG_DIR ?? join(process.cwd(), ".longrun");
const contextsDir = join(dir, "contexts");
mkdirSync(contextsDir, { recursive: true });

const line = (record: Record<string, unknown>) =>
  appendFileSync(join(dir, "llm-calls.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
const dump = (name: string, value: unknown) => {
  const file = `${name}.json.gz`;
  writeFileSync(join(contextsDir, file), gzipSync(JSON.stringify(value)));
  return file;
};

type Prompt = readonly { role: string; content: unknown }[];
const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
};
const isCompaction = (prompt: Prompt) =>
  prompt.some((m) => m.role === "system" && textOf(m.content).includes("CONTEXT CHECKPOINT COMPACTION"));

let seq = 0;
let calls = 0;
let lastOrdinary: { prompt: Prompt; at: string; call: number } | null = null;
let pendingPost: string | null = null;

interface Started { call: number; kind: "turn" | "compaction"; seqId: string | null; t0: number; prompt: Prompt }

function onStart(params: { prompt: Prompt; providerOptions?: unknown }): Started {
  calls += 1;
  const prompt = params.prompt;
  const kind = isCompaction(prompt) ? "compaction" : "turn";
  const chars = (JSON.stringify(prompt) ?? "").length;
  const record: Record<string, unknown> = {
    ev: "start", call: calls, kind, messages: prompt.length, chars, estTokens: Math.round(chars / 4),
    systemChars: prompt.filter((m) => m.role === "system").reduce((n, m) => n + textOf(m.content).length, 0),
    roles: prompt.map((m) => m.role[0]).join(""),
    gatewayOptions: (params.providerOptions as { gateway?: unknown } | undefined)?.gateway,
    lastUserHead: textOf(prompt.filter((m) => m.role === "user").at(-1)?.content).replace(/\s+/g, " ").slice(0, 120),
  };
  let seqId: string | null = null;
  if (kind === "compaction") {
    seq += 1;
    seqId = String(seq).padStart(3, "0");
    record.seq = seqId;
    record.pre = lastOrdinary ? dump(`${seqId}-pre`, { call: lastOrdinary.call, at: lastOrdinary.at, prompt: lastOrdinary.prompt }) : null;
    record.prompt = dump(`${seqId}-compaction-prompt`, { call: calls, prompt });
    pendingPost = seqId;
  } else {
    if (pendingPost !== null) {
      record.seq = pendingPost;
      record.post = dump(`${pendingPost}-post`, { call: calls, prompt });
      pendingPost = null;
    }
    lastOrdinary = { prompt, at: new Date().toISOString(), call: calls };
  }
  line(record);
  return { call: calls, kind, seqId, t0: Date.now(), prompt };
}

function onEnd(s: Started, out: { text: string; reasoning: string; toolCalls: unknown[]; usage: unknown; finishReason: unknown; providerMetadata: unknown; responseModelId?: unknown; error?: unknown }) {
  const record: Record<string, unknown> = {
    ev: out.error === undefined ? "end" : "fail", call: s.call, kind: s.kind, ms: Date.now() - s.t0,
    finishReason: out.finishReason, usage: out.usage, responseModelId: out.responseModelId,
    gateway: (out.providerMetadata as { gateway?: unknown } | undefined)?.gateway,
    textChars: out.text.length, reasoningChars: out.reasoning.length,
    toolCalls: out.toolCalls.map((c) => { const t = c as { toolName?: string; input?: unknown }; return { tool: t.toolName, input: String(typeof t.input === "string" ? t.input : JSON.stringify(t.input) ?? "").slice(0, 300) }; }),
    textHead: out.text.replace(/\s+/g, " ").slice(0, 300),
    error: out.error === undefined ? undefined : String((out.error as { message?: string })?.message ?? out.error).slice(0, 1000),
  };
  if (s.kind === "compaction" && s.seqId) {
    record.seq = s.seqId;
    record.checkpoint = dump(`${s.seqId}-checkpoint`, { call: s.call, text: out.text, reasoning: out.reasoning, usage: out.usage, finishReason: out.finishReason });
  }
  line(record);
}

const recorder: LanguageModelMiddleware = {
  specificationVersion: "v3",
  async wrapGenerate({ doGenerate, params }) {
    const s = onStart(params as { prompt: Prompt; providerOptions?: unknown });
    try {
      const result = await doGenerate();
      const content = result.content as readonly { type: string; text?: string }[];
      onEnd(s, {
        text: content.filter((p) => p.type === "text").map((p) => p.text ?? "").join(""),
        reasoning: content.filter((p) => p.type === "reasoning").map((p) => p.text ?? "").join(""),
        toolCalls: content.filter((p) => p.type === "tool-call"),
        usage: result.usage, finishReason: result.finishReason, providerMetadata: result.providerMetadata,
        responseModelId: result.response?.modelId,
      });
      return result;
    } catch (error) {
      onEnd(s, { text: "", reasoning: "", toolCalls: [], usage: undefined, finishReason: undefined, providerMetadata: undefined, error });
      throw error;
    }
  },
  async wrapStream({ doStream, params }) {
    const s = onStart(params as { prompt: Prompt; providerOptions?: unknown });
    let result;
    try {
      result = await doStream();
    } catch (error) {
      onEnd(s, { text: "", reasoning: "", toolCalls: [], usage: undefined, finishReason: undefined, providerMetadata: undefined, error });
      throw error;
    }
    let text = "";
    let reasoning = "";
    const toolCalls: unknown[] = [];
    let usage: unknown;
    let finishReason: unknown;
    let providerMetadata: unknown;
    let responseModelId: unknown;
    let error: unknown;
    const tap = new TransformStream<{ type: string; [k: string]: unknown }, { type: string; [k: string]: unknown }>({
      transform(part, controller) {
        switch (part.type) {
          case "text-delta": text += String(part.delta ?? ""); break;
          case "reasoning-delta": reasoning += String(part.delta ?? ""); break;
          case "tool-call": toolCalls.push(part); break;
          case "response-metadata": responseModelId = part.modelId; break;
          case "finish": usage = part.usage; finishReason = part.finishReason; providerMetadata = part.providerMetadata; break;
          case "error": error = part.error; break;
          default:
        }
        controller.enqueue(part);
      },
      flush() {
        onEnd(s, { text, reasoning, toolCalls, usage, finishReason, providerMetadata, responseModelId, error });
      },
    });
    return { ...result, stream: result.stream.pipeThrough(tap) };
  },
};

export const recorded = (model: LanguageModel): LanguageModel =>
  typeof model === "string" ? model : wrapLanguageModel({ model, middleware: recorder });
