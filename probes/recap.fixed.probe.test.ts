import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import { compactMessages, shouldCompact } from "#harness/compaction/engine.js";
import type { CompactionConfig } from "#harness/types.js";

// Probe for eve-tokyo, fixed-engine version of recap.probe.test.ts: after vercel/eve#4771 and
// #4773 (merged 2026-10-15), a capped result must stay byte-identical through later compactions
// (one annotation) and keep its last line. Passes at a3654ef7e; fails at 0fd4240.

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

describe("tool-result cap across repeated compactions (real engine, #4771 + #4773)", () => {
  it("caps once, keeps the result identical afterwards, and keeps its last line", async () => {
    const summarize = vi.fn(async () => {
      throw new Error("summary path should not run in this probe");
    });

    let history: ModelMessage[] = [
      { content: "Find failing auth tests.", role: "user" },
      ...toolTurn("call-1", [...PATHS, FAIL_LINE].join("\n")),
      { content: "Looking at the results.", role: "assistant" },
    ];

    const rounds: ReturnType<typeof stats>[] = [];
    const values: string[] = [];
    for (let round = 1; round <= 4; round += 1) {
      history = [
        ...history,
        { content: `Next step ${round}.`, role: "user" },
        ...toolTurn(`call-pad-${round}`, "x".repeat(60_000)),
        { content: `Done with step ${round}.`, role: "assistant" },
        { content: `Continue ${round}.`, role: "user" },
      ];
      expect(shouldCompact(history, config)).toBe(true);
      history = await compactMessages(history, config, summarize);
      const value = resultValue(history, "call-1");
      values.push(value);
      rounds.push(stats(value));
    }

    console.table(rounds);
    expect(summarize).not.toHaveBeenCalled();
    expect(rounds.map((r) => r.annotations)).toEqual([1, 1, 1, 1]);
    expect(new Set(values).size).toBe(1);
    expect(rounds.every((r) => r.failLineKept)).toBe(true);
    expect(rounds[0]!.modulePathsKept).toBeGreaterThan(0);
  });
});
