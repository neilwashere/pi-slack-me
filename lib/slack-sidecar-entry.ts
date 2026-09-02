import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createSlackInboxBackend } from "./slack-inbox-backend";
import { defaultSlackInboxStorePath } from "./slack-inbox-store";
import { HerdrNotifier } from "./herdr-notifier";
import { defaultSlackSidecarSocketPath } from "./global-slack-inbox";
import { acquireSlackSidecarLock } from "./slack-sidecar-lock";
import {
  prepareSlackSidecarDirectory,
  SlackSidecarServer,
} from "./slack-sidecar-server";

async function run(): Promise<void> {
  const socketPath = defaultSlackSidecarSocketPath();
  await prepareSlackSidecarDirectory(socketPath);
  const lock = await acquireSlackSidecarLock(`${socketPath}.lock`);
  if (!lock) return;
  const storePath = defaultSlackInboxStorePath();
  let storeLock: Awaited<ReturnType<typeof acquireSlackSidecarLock>>;
  try {
    await mkdir(dirname(storePath), { recursive: true, mode: 0o700 });
    storeLock = await acquireSlackSidecarLock(`${storePath}.writer.lock`, {
      probeSocketPath: socketPath,
    });
  } catch (error) {
    await lock.release();
    throw error;
  }
  if (!storeLock) {
    await lock.release();
    throw new Error("Slack inbox store is owned by another active sidecar.");
  }

  let server: SlackSidecarServer | undefined;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server?.close();
    await storeLock.release();
    await lock.release();
  };

  try {
    const appToken = process.env.SLACK_APP_TOKEN?.trim();
    if (!appToken) {
      throw new Error("SLACK_APP_TOKEN is not configured for Slack Socket Mode.");
    }
    const notifier = new HerdrNotifier();
    server = new SlackSidecarServer({
      socketPath,
      backend: createSlackInboxBackend({ appToken }),
      onAttention: (message, clients) => notifier.notify(message, clients),
    });
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    process.once("beforeExit", () => void shutdown());
    await server.start();
  } catch (error) {
    await shutdown();
    throw error;
  }
}

void run().catch((error) => {
  const message = (error instanceof Error ? error.stack : String(error))
    ?.replace(/\b(?:xapp|xox[a-z.]*)-[a-z0-9.-]+\b/gi, "[REDACTED]")
    .replace(/\bwss:\/\/\S+/gi, "[REDACTED]");
  try {
    const diagnosticDirectory =
      process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
    mkdirSync(diagnosticDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(
        diagnosticDirectory,
        `pi-slack-sidecar-error-${process.pid}-${randomUUID()}.log`,
      ),
      `${message || "Slack sidecar failed without error details."}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch {
    // The exit code remains observable when the diagnostic path is unavailable.
  }
  process.exitCode = 1;
});
