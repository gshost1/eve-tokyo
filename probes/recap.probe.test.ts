import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import { compactMessages, shouldCompact } from "#harness/compaction/engine.js";
import type { CompactionConfig } from "#harness/types.js";

// Probe for eve-tokyo: does the tool-result cap re-apply to a result that a
// previous compaction already capped?

const config: CompactionConfig = { recentWindowSize: 2, threshold: 12_000 };

const PATHS = Array.from({ length: 400 }, (_, i) => `src/app/module_${i}.ts:${i + 10}: "ok"`);
const FAIL_LINE =
  'FAIL src/auth/session.test.ts > TypeError: Cannot read properties of undefined (reading "token")';

function toolTurn(id: string, text: string): ModelMessage[] {
  return [
    {
      content: [{ input: { pattern: "ok" }, toolCallId: id, toolName: "grep", type: "tool-call" }],
      role: "assistant",
    },
    {
      content: [
        { output: { type: "text", value: text }, toolCallId: id, toolName: "grep", type: "tool-result" },
      ],
      role: "tool",
    },
  ];
}

function resultValue(messages: readonly ModelMessage[], id: string): string {
  for (const message of messages) {
    if (message.role !== "tool" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolCallId === id) {
        return (part.output as { value: string }).value;
      }
    }
  }
  throw new Error(`no tool result ${id}`);
}

const stats = (value: string) => ({
  annotations: value.match(/Truncated by eve/g)?.length ?? 0,
  backslashes: value.match(/\\/g)?.length ?? 0,
  failLineKept: value.includes(FAIL_LINE),
  length: value.length,
  modulePathsKept: new Set(value.match(/module_\d+\.ts/g)).size,
});

describe("tool-result cap across repeated compactions (real engine)", () => {
  it("re-caps an already-capped result on every later compaction", async () => {
    const summarize = vi.fn(async () => {
      throw new Error("summary path should not run in this probe");
    });

    let history: ModelMessage[] = [
      { content: "Find failing auth tests.", role: "user" },
      ...toolTurn("call-1", [...PATHS, FAIL_LINE].join("\n")),
      { content: "Looking at the results.", role: "assistant" },
    ];

    const rounds: ReturnType<typeof stats>[] = [];
    for (let round = 1; round <= 4; round += 1) {
      // Each round, new bulky work arrives so compaction is genuinely due.
      history = [
        ...history,
        { content: `Next step ${round}.`, role: "user" },
        ...toolTurn(`call-pad-${round}`, "x".repeat(60_000)),
        { content: `Done with step ${round}.`, role: "assistant" },
        { content: `Continue ${round}.`, role: "user" },
      ];
      expect(shouldCompact(history, config)).toBe(true);
      history = await compactMessages(history, config, summarize);
      rounds.push(stats(resultValue(history, "call-1")));
    }

    console.table(rounds);
    expect(summarize).not.toHaveBeenCalled();
    // Expected-if-idempotent: one annotation forever. Observed below.
    expect(rounds.map((r) => r.annotations)).toEqual([1, 2, 3, 4]);
    expect(rounds[3]!.modulePathsKept).toBeLessThan(rounds[0]!.modulePathsKept);
    expect(rounds[0]!.failLineKept).toBe(false);
  });
});
