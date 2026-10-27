import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";
import { JustBashSandbox } from "eve/sandbox/just-bash";

// Docker on the InstaBox machine (real processes: git, node, test runners); just-bash for the
// offline test on a Mac without a Docker daemon.
const kind = process.env.LONGRUN_SANDBOX ?? "docker";
const image = process.env.LONGRUN_IMAGE ?? "node:24-bookworm";

export const environment =
  kind === "docker" ? DockerSandbox.image(image) : JustBashSandbox.environment();

export default defineSandbox(async ({ session }) => {
  const sandbox = await environment.open();
  const logDir = process.env.LONGRUN_LOG_DIR;
  if (logDir) {
    // The driver verifies the final repository state with `docker exec`, so it needs the
    // container behind this session. The container id is its hostname.
    let container = "just-bash";
    if (kind === "docker") {
      const r = await sandbox.run({ command: "hostname" });
      container = r.stdout.trim();
    }
    mkdirSync(logDir, { recursive: true });
    appendFileSync(
      join(logDir, "sandbox.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), container, image, kind, sessionId: session.id })}\n`,
    );
  }
  return sandbox;
});
