import { createGateway } from "ai";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

import { recorded } from "#model-log.ts";

// Long-horizon runner agent. Everything that varies per run comes from the environment the
// driver (bench/longrun/drive.mjs) sets:
//   LONGRUN_MODEL            gateway model id, or "mock" for the offline plumbing test
//   LONGRUN_PROVIDER         gateway provider slug the run is pinned to (hard pin, no fallback)
//   LONGRUN_CONTEXT_TOKENS   model context window eve compacts against
//   LONGRUN_THRESHOLD        compaction thresholdPercent (eve default 0.9)
//   AI_GATEWAY_API_KEY       Keysrs grant token; AI_GATEWAY_BASE_URL the Keysrs relay
// The model is authored as an SDK instance because eve's own gateway transport has no base-URL
// override, and the relay needs one.
const modelId = process.env.LONGRUN_MODEL ?? "deepseek/deepseek-v4.1-flash-1017";
const provider = process.env.LONGRUN_PROVIDER ?? "deepinfra";
const contextWindow = Number(process.env.LONGRUN_CONTEXT_TOKENS ?? 400_000);
const thresholdPercent = Number(process.env.LONGRUN_THRESHOLD ?? 0.9);

// Offline plumbing test: a scripted coding loop that fills the context with large bash outputs so
// compaction runs without any provider. The same mock also answers the compaction prompt.
let mockSteps = 0;
let mockStage = "";
const MOCK_STEPS = Number(process.env.LONGRUN_MOCK_STEPS ?? 14);
const mock = mockModel({
  modelId: "longrun-mock",
  provider: "eve-mock",
  respond: ({ lastUserMessage }) => {
    if (lastUserMessage?.includes("<previous-checkpoint>")) {
      return `CHECKPOINT (mock) after ${mockSteps} tool steps. Base commit abc1234. Completed: steps 1-${mockSteps}. Remaining: finish the mock task.`;
    }
    if (lastUserMessage?.includes("Without using") || lastUserMessage?.includes("Continue the")) {
      return `Probe answer (mock): constraints were C1..C3; base commit abc1234; ${mockSteps} steps done.`;
    }
    // A new stage prompt restarts the scripted loop (the resumption guard replays the current stage
    // prompt after compaction, so only a different prompt counts as a new stage).
    if (lastUserMessage?.includes("MOCK STAGE") && lastUserMessage !== mockStage) {
      mockStage = lastUserMessage;
      mockSteps = 0;
    }
    mockSteps += 1;
    if (mockSteps > MOCK_STEPS) return mockStage.includes("final") ? "All mock steps done.\n\nTASK COMPLETE" : "Stage done.\n\nSTAGE COMPLETE";
    // Tool results get capped at compaction time, so most of the growth has to sit in the
    // assistant messages (tool-call inputs) for the summary path to run in this test.
    if (mockSteps % 3 === 0) {
      return {
        toolCalls: [{ name: "bash", input: { command: `seq 1 2500 | sed 's/^/mock-output-line-/'` } }],
      };
    }
    return {
      toolCalls: [
        { name: "write_file", input: { path: `notes/step-${mockSteps}.md`, content: `# step ${mockSteps}\n${`note line ${mockSteps} lorem ipsum dolor sit amet\n`.repeat(350)}` } },
      ],
    };
  },
});

function gatewayModel() {
  const gateway = createGateway({
    ...(process.env.AI_GATEWAY_API_KEY ? { apiKey: process.env.AI_GATEWAY_API_KEY } : {}),
    ...(process.env.AI_GATEWAY_BASE_URL ? { baseURL: process.env.AI_GATEWAY_BASE_URL } : {}),
  });
  return gateway(modelId);
}

export default defineAgent({
  model: recorded(modelId === "mock" ? mock : gatewayModel()),
  modelContextWindowTokens: contextWindow,
  ...(modelId === "mock"
    ? {}
    : { modelOptions: { providerOptions: { gateway: { only: [provider] } } } }),
  compaction: { thresholdPercent },
  // The driver enforces budgets (and the Keysrs grant caps spend); eve's own limits would park the
  // turn on a human-input prompt nobody is there to answer.
  limits: { sessionUsage: () => false },
});
