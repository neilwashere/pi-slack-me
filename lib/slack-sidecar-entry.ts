import { createSlackInboxBackend } from "./slack-inbox-backend";
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

  const appToken = process.env.SLACK_APP_TOKEN?.trim();
  if (!appToken) {
    await lock.release();
    throw new Error("SLACK_APP_TOKEN is not configured for Slack Socket Mode.");
  }

  const notifier = new HerdrNotifier();
  const server = new SlackSidecarServer({
    socketPath,
    backend: createSlackInboxBackend({ appToken }),
    onAttention: (message, clients) => notifier.notify(message, clients),
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close();
    await lock.release();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.once("beforeExit", () => void shutdown());

  try {
    await server.start();
  } catch (error) {
    await shutdown();
    throw error;
  }
}

void run().catch(() => {
  process.exitCode = 1;
});
