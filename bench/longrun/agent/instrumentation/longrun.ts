import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { defineInstrumentation } from "eve/instrumentation";

// Compaction-quality log. Writes to LONGRUN_LOG_DIR:
//   model-calls.jsonl   one line per model call start/end/failure, with a per-message digest of the
//                       input (role, part types, sizes, hashes) but not the content
//   steps.jsonl         provider metadata per step attempt (gateway cost and routing)
//   tools.jsonl         tool calls with timing and output size
//   contexts/           full dumps (gzipped JSON) of the context right before a compaction summary
//                       call, the compaction prompt itself, the checkpoint it produced, and the
//                       first model input after it
// Everything else about the run comes from the client stream the driver records.
const dir = process.env.LONGRUN_LOG_DIR ?? join(process.cwd(), ".longrun");
const contextsDir = join(dir, "contexts");
mkdirSync(contextsDir, { recursive: true });

const line = (file: string, record: Record<string, unknown>) =>
  appendFileSync(join(dir, file), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
const dump = (name: string, value: unknown) => {
  const file = join(contextsDir, `${name}.json.gz`);
  writeFileSync(file, gzipSync(JSON.stringify(value)));
  return file;
};
const sha = (value: unknown) => createHash("sha1").update(JSON.stringify(value) ?? "").digest("hex").slice(0, 12);

interface Scope {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepIndex: number;
  readonly attemptIndex: number;
}
interface Pending {
  readonly key: string;
  readonly scope: Scope;
  readonly input: unknown;
  readonly startedAt: number;
}

let seq = 0;
const nextSeq = () => String(++seq).padStart(4, "0");
// Per session: the last ordinary model input (the context a compaction will fold), and whether the
// next ordinary input should be dumped because a compaction summary just ran.
const lastInput = new Map<string, Pending>();
const dumpNext = new Map<string, string>();
const compactionCalls = new Map<string, { seq: string; startedAt: number }>();
const starts = new Map<string, number>();
const toolStarts = new Map<string, number>();

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

function digestMessage(message: unknown) {
  const m = message as { role?: string; kind?: string; content?: unknown };
  const content = m.content;
  const parts = Array.isArray(content)
    ? content.map((part) => {
        const p = part as { type?: string; toolName?: string; output?: unknown; input?: unknown };
        const entry: Record<string, unknown> = { type: p.type, chars: (JSON.stringify(part) ?? "").length };
        if (p.toolName) entry.tool = p.toolName;
        return entry;
      })
    : [{ type: "text", chars: typeof content === "string" ? content.length : 0 }];
  return {
    role: m.role,
    ...(m.kind ? { kind: m.kind } : {}),
    chars: (JSON.stringify(message) ?? "").length,
    sha: sha(message),
    head: textOf(content).replace(/\s+/g, " ").slice(0, 160),
    parts,
  };
}

function instructionsText(instructions: unknown): string {
  if (typeof instructions === "string") return instructions;
  if (instructions && typeof instructions === "object" && "content" in instructions) {
    const c = (instructions as { content?: unknown }).content;
    return typeof c === "string" ? c : "";
  }
  return "";
}

const isCompactionCall = (instructions: unknown) =>
  instructionsText(instructions).includes("CONTEXT CHECKPOINT COMPACTION");

export default defineInstrumentation({
  // Local development would record content anyway; be explicit so a build or a different
  // environment on the box cannot silently turn the dumps off.
  tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
  events: {
    "model.call.started"(event) {
      const scope = event.scope as Scope;
      const input = event.input as { instructions?: unknown; messages?: readonly unknown[]; tools?: readonly unknown[] } | undefined;
      const messages = input?.messages ?? [];
      const compaction = isCompactionCall(input?.instructions);
      const startedAt = Date.now();
      starts.set(event.idempotencyKey, startedAt);
      const record: Record<string, unknown> = {
        ev: "model.start",
        key: event.idempotencyKey,
        scope,
        model: event.model,
        compaction,
        messages: messages.length,
        chars: (JSON.stringify(messages) ?? "").length,
        instructionsChars: instructionsText(input?.instructions).length,
        tools: (input?.tools ?? []).length,
        digest: messages.map(digestMessage),
      };
      const session = scope.sessionId;
      if (compaction) {
        const id = nextSeq();
        compactionCalls.set(event.idempotencyKey, { seq: id, startedAt });
        const pre = lastInput.get(session);
        record.dumpSeq = id;
        record.preContextDump = pre
          ? dump(`${id}-pre-step${pre.scope.stepIndex}`, { scope: pre.scope, input: pre.input })
          : null;
        record.promptDump = dump(`${id}-compaction-prompt-step${scope.stepIndex}`, { scope, input });
        dumpNext.set(session, id);
      } else {
        const pendingSeq = dumpNext.get(session);
        if (pendingSeq !== undefined) {
          record.dumpSeq = pendingSeq;
          record.postContextDump = dump(`${pendingSeq}-post-step${scope.stepIndex}`, { scope, input });
          dumpNext.delete(session);
        }
        lastInput.set(session, { key: event.idempotencyKey, scope, input, startedAt });
      }
      line("model-calls.jsonl", record);
    },
    "model.call.completed"(event) {
      const startedAt = starts.get(event.idempotencyKey);
      starts.delete(event.idempotencyKey);
      const content = (event.content ?? []) as readonly { type: string; text?: string; toolName?: string; input?: unknown }[];
      const text = content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
      const reasoning = content.filter((p) => p.type === "reasoning").map((p) => p.text ?? "").join("");
      const toolCalls = content
        .filter((p) => p.type === "tool-call")
        .map((p) => ({ tool: p.toolName, input: (JSON.stringify(p.input) ?? "").slice(0, 400) }));
      const compaction = compactionCalls.get(event.idempotencyKey);
      compactionCalls.delete(event.idempotencyKey);
      const record: Record<string, unknown> = {
        ev: "model.end",
        key: event.idempotencyKey,
        scope: event.scope,
        ms: startedAt === undefined ? null : Date.now() - startedAt,
        finishReason: event.finishReason,
        responseModelId: event.responseModelId,
        usage: event.usage,
        textChars: text.length,
        reasoningChars: reasoning.length,
        toolCalls,
        compaction: compaction !== undefined,
        textHead: text.replace(/\s+/g, " ").slice(0, 300),
      };
      if (compaction) {
        record.dumpSeq = compaction.seq;
        record.checkpointDump = dump(`${compaction.seq}-checkpoint`, { scope: event.scope, text, reasoning, usage: event.usage });
        record.checkpointChars = text.length;
      }
      line("model-calls.jsonl", record);
    },
    "model.call.failed"(event) {
      starts.delete(event.idempotencyKey);
      const wasCompaction = compactionCalls.has(event.idempotencyKey);
      compactionCalls.delete(event.idempotencyKey);
      const error = event.error as { message?: string; name?: string; statusCode?: number; responseBody?: unknown } | undefined;
      line("model-calls.jsonl", {
        ev: "model.fail",
        key: event.idempotencyKey,
        scope: event.scope,
        compaction: wasCompaction,
        error: {
          name: error?.name,
          message: String(error?.message ?? error).slice(0, 2000),
          statusCode: error?.statusCode,
          responseBody: typeof error?.responseBody === "string" ? error.responseBody.slice(0, 2000) : undefined,
        },
      });
    },
    "step.attempt.metadata"(event) {
      const meta = event.providerMetadata as Record<string, unknown>;
      const gateway = meta.gateway as Record<string, unknown> | undefined;
      line("steps.jsonl", {
        ev: "step.metadata",
        scope: event.scope,
        gateway: gateway === undefined ? undefined : JSON.parse(JSON.stringify(gateway).slice(0, 4000)),
        providers: Object.keys(meta),
      });
    },
    "tool.call.started"(event) {
      toolStarts.set(event.callId, Date.now());
      line("tools.jsonl", {
        ev: "tool.start",
        callId: event.callId,
        scope: event.scope,
        tool: event.toolName,
        input: (JSON.stringify(event.input) ?? "").slice(0, 600),
      });
    },
    "tool.call.completed"(event) {
      const startedAt = toolStarts.get(event.callId);
      toolStarts.delete(event.callId);
      const output = (event as { output?: unknown }).output;
      const serialized = JSON.stringify(output) ?? "";
      line("tools.jsonl", {
        ev: "tool.end",
        callId: event.callId,
        scope: event.scope,
        tool: (event as { toolName?: string }).toolName,
        outcome: (event as { outcome?: unknown }).outcome,
        ms: startedAt === undefined ? null : Date.now() - startedAt,
        outputChars: serialized.length,
        outputHead: serialized.slice(0, 300),
      });
    },
  },
});
