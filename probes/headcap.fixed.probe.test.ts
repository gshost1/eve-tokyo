import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import { compactMessages } from "#harness/compaction/engine.js";
import type { CompactionConfig } from "#harness/types.js";

// Probe for eve-tokyo, fixed-engine version of headcap.probe.test.ts: after vercel/eve#4773
// (merged 2026-10-15), one cap of a bash-shaped result must keep its end: the FAIL line,
// the error, the summary line and the exit code. Passes at a3654ef7e; fails at 0fd4240.

const config: CompactionConfig = { recentWindowSize: 2, threshold: 12_000 };

const stdout = [
  ...Array.from({ length: 120 }, (_, i) => ` ✓ src/app/module_${i}.test.ts (3 tests) ${i}ms`),
  " FAIL  src/auth/session.test.ts > refreshes token",
  'TypeError: Cannot read properties of undefined (reading "token")',
  " Test Files  1 failed | 120 passed (121)",
].join("\n");

function bashTurn(id: string, value: unknown): ModelMessage[] {
  return [
    { content: [{ input: { command: "pnpm test" }, toolCallId: id, toolName: "bash", type: "tool-call" }], role: "assistant" },
    { content: [{ output: { type: "json", value } as never, toolCallId: id, toolName: "bash", type: "tool-result" }], role: "tool" },
  ];
}

describe("head + tail cap on a bash result (real engine, #4773)", () => {
  it("keeps the start of stdout, its end and the exit code", async () => {
    const summarize = vi.fn(async () => {
      throw new Error("summary path should not run");
    });
    const history: ModelMessage[] = [
      { content: "Run the tests.", role: "user" },
      ...bashTurn("call-1", { stderr: "", stdout, truncated: false, exitCode: 1, status: "completed" }),
      { content: "Tests ran.", role: "assistant" },
      { content: "Next.", role: "user" },
      ...bashTurn("call-pad", { stderr: "", stdout: "x".repeat(60_000), truncated: false, exitCode: 0, status: "completed" }),
      { content: "Done.", role: "assistant" },
      { content: "Continue.", role: "user" },
    ];
    const out = await compactMessages(history, config, summarize);
    const tool = out.find((m) => m.role === "tool" && JSON.stringify(m).includes("call-1"))!;
    const kept = JSON.stringify(tool);
    const report = {
      exitCodeKept: kept.includes('exitCode\\":1') || kept.includes('"exitCode":1'),
      failLineKept: kept.includes("FAIL  src/auth"),
      errorLineKept: kept.includes("Cannot read properties of undefined"),
      summaryLineKept: kept.includes("1 failed | 120 passed"),
      passingLinesKept: new Set(kept.match(/module_\d+\.test/g)).size,
      elisionMarker: kept.includes("chars omitted"),
      stdoutChars: stdout.length,
    };
    console.table([report]);
    expect(summarize).not.toHaveBeenCalled();
    expect(report.failLineKept).toBe(true);
    expect(report.errorLineKept).toBe(true);
    expect(report.summaryLineKept).toBe(true);
    expect(report.exitCodeKept).toBe(true);
    expect(report.passingLinesKept).toBeGreaterThan(0);
  });
});
