import type { ModelMessage } from "ai";

// Synthetic long coding sessions with planted, uniquely identifiable details ("anchors").
// Shapes follow eve's own tools: read_file / grep return text, bash returns
// { stderr, stdout, truncated, exitCode, status } (field order from execution/sandbox/bash.ts).

export type AnchorKind = "path" | "error" | "command" | "decision";
export type AnchorWhere = "head" | "middle" | "tail" | "call" | "text";

export interface Anchor {
  readonly id: string;
  readonly kind: AnchorKind;
  readonly where: AnchorWhere;
  /** Exact string that must survive. No quotes or backslashes, so JSON escaping can't hide it. */
  readonly text: string;
  /** Index of the step that introduced it. */
  readonly step: number;
  /** Decisions only: words that must co-occur in one sentence for a paraphrase to count. */
  readonly loose?: readonly string[];
}

/** One model step: the messages appended before the next model call. */
export interface Step {
  readonly messages: ModelMessage[];
  readonly anchors: Anchor[];
}

export interface Session {
  readonly name: string;
  readonly steps: Step[];
}

// Deterministic PRNG so every run sees the same sessions.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AREAS = ["auth", "billing", "search", "sync", "upload", "webhooks", "sessions", "export"];
const LIBS = ["zod", "valibot", "drizzle", "kysely", "hono", "express", "pino", "winston"];

export function generateSession(seed: number, turns: number): Session {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  let n = 0;
  const uid = () => `${seed.toString(36)}${(n++).toString(36)}`;
  const steps: Step[] = [];

  const filler = (count: number, area: string) =>
    Array.from({ length: count }, (_, i) => `  const value_${i} = await ${area}Store.load(id, { retries: ${i % 5} });`);

  for (let turn = 0; turn < turns; turn += 1) {
    const area = pick(AREAS);
    const stepIndex = () => steps.length;
    // User asks for something.
    steps.push({ anchors: [], messages: [{ content: `Next: work on the ${area} module (task ${turn + 1}).`, role: "user" }] });

    const calls = int(2, 4);
    for (let c = 0; c < calls; c += 1) {
      const kind = pick(["read_file", "grep", "test", "build"] as const);
      const id = `call-${uid()}`;
      const anchors: Anchor[] = [];
      const a = (k: AnchorKind, where: AnchorWhere, text: string) => {
        anchors.push({ id: `${k}-${uid()}`, kind: k, step: stepIndex(), text, where });
        return text;
      };
      let input: Record<string, unknown>;
      let output: { type: "text"; value: string } | { type: "json"; value: unknown };
      const size = int(60, 220); // lines of bulk, roughly 4k-15k chars

      if (kind === "read_file") {
        const path = a("path", "head", `src/${area}/handler_${uid()}.ts`);
        input = { path };
        const body = filler(size, area);
        body.splice(Math.floor(size / 2), 0, `  // see ${a("path", "middle", `src/${area}/lib/retry_${uid()}.ts`)}`);
        body.push(`  throw new Error(${"`"}${a("error", "tail", `E_${area.toUpperCase()}_${uid()} unreachable state`)}${"`"});`);
        output = { type: "text", value: [`// ${path}`, `import { ${area}Store } from "../store";`, ...body].join("\n") };
      } else if (kind === "grep") {
        const term = `${area}Store`;
        input = { pattern: term };
        const lines = Array.from({ length: size }, (_, i) => `src/${area}/gen/file_${i}.ts:${i + 3}:   ${term}.load(id)`);
        lines[0] = `${a("path", "head", `src/${area}/core_${uid()}.ts`)}:12:   ${term}.load(id)`;
        lines[Math.floor(size / 2)] = `${a("path", "middle", `src/${area}/deep_${uid()}.ts`)}:40:   ${term}.load(id)`;
        lines.push(`${a("path", "tail", `src/${area}/last_${uid()}.ts`)}:7:   ${term}.load(id)`);
        output = { type: "text", value: lines.join("\n") };
      } else {
        const isTest = kind === "test";
        const target = `src/${area}`;
        const command = a(
          "command",
          "call",
          isTest ? `pnpm vitest run ${target} -t case_${uid()}` : `pnpm tsc -p tsconfig.${area}_${uid()}.json`,
        );
        input = { command };
        const lines = Array.from({ length: size }, (_, i) =>
          isTest ? ` ✓ ${target}/gen/spec_${i}.test.ts (3 tests) ${i}ms` : `   compiling ${target}/gen/file_${i}.ts`,
        );
        const failPath = a("path", "tail", `${target}/${isTest ? "spec" : "types"}_${uid()}.${isTest ? "test." : ""}ts`);
        const err = a("error", "tail", `${isTest ? "AssertionError" : "TS2345"} ${area}_${uid()} expected 200 got 500`);
        lines.push(isTest ? ` FAIL  ${failPath} > handles retry` : `${failPath}(41,7): error`, `  ${err}`);
        output = {
          type: "json",
          value: { stderr: "", stdout: lines.join("\n"), truncated: false, exitCode: 1, status: "completed" },
        };
      }

      steps.push({
        anchors,
        messages: [
          { content: [{ input, toolCallId: id, toolName: kind === "test" || kind === "build" ? "bash" : kind, type: "tool-call" }], role: "assistant" },
          { content: [{ output: output as never, toolCallId: id, toolName: kind === "test" || kind === "build" ? "bash" : kind, type: "tool-result" }], role: "tool" },
        ],
      });
    }

    // Assistant states a decision in prose.
    const anchors: Anchor[] = [];
    const lib = pick(LIBS);
    const other = pick(LIBS.filter((l) => l !== lib));
    const decision = `D-${uid()} use ${lib} not ${other} in ${area}`;
    anchors.push({ id: `decision-${uid()}`, kind: "decision", loose: [lib, other, area], step: steps.length, text: decision, where: "text" });
    steps.push({
      anchors,
      messages: [{ content: `Decision ${decision}, because the ${other} adapter drops retries.`, role: "assistant" }],
    });
  }
  return { name: `synthetic-${seed}`, steps };
}
