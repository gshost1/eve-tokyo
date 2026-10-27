import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { defineHook } from "eve/hooks";

// Server-side copy of the session stream (minus text deltas), so compaction.requested's
// usageInputTokens and step.completed's usage survive even if the driver's stream reconnects.
const dir = process.env.LONGRUN_LOG_DIR ?? join(process.cwd(), ".longrun");
mkdirSync(dir, { recursive: true });

const SKIP = new Set(["message.appended", "reasoning.appended", "action.input.appended", "action.partial"]);

function compact(event: { type: string; data?: unknown }) {
  if (event.type !== "action.result") return event.data;
  const data = event.data as Record<string, unknown>;
  const text = JSON.stringify(data) ?? "";
  return text.length <= 3000 ? data : { truncated: true, chars: text.length, head: text.slice(0, 1500) };
}

export default defineHook({
  events: {
    "*"(event, ctx) {
      if (SKIP.has(event.type)) return;
      appendFileSync(
        join(dir, "events.jsonl"),
        `${JSON.stringify({ at: new Date().toISOString(), sessionId: ctx.session.id, type: event.type, data: compact(event) })}\n`,
      );
    },
  },
});
