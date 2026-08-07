import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HerdrNotifier } from "../lib/herdr-notifier.js";
import type { SlackInboxClientIdentity } from "../lib/global-slack-inbox";
import type { SlackInboxMessage } from "../lib/slack-events";

interface HerdrRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

class FakeHerdrServer {
  readonly requests: HerdrRequest[] = [];
  private server = createServer((socket) => this.accept(socket));

  constructor(
    private readonly socketPath: string,
    private readonly focusedPaneId = "w1:p2",
  ) {}

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await unlink(this.socketPath).catch(() => undefined);
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let request: HerdrRequest;
      try {
        request = JSON.parse(buffer.slice(0, newline)) as HerdrRequest;
      } catch {
        socket.destroy();
        return;
      }
      this.requests.push(request);
      const result =
        request.method === "session.snapshot"
          ? {
              type: "session_snapshot",
              snapshot: { focused_pane_id: this.focusedPaneId },
            }
          : { type: "notification_show", shown: true, reason: "shown" };
      socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
    });
  }
}

const message: SlackInboxMessage = {
  eventId: "EvToast",
  channelId: "C123",
  channelName: "engineering",
  userId: "U123",
  userName: "Alice",
  text: "<@USELF> Please look at the latest deployment.\nIt needs attention.",
  timestamp: "1786112000.001000",
  isMention: true,
};

function client(
  sessionId: string,
  paneId: string,
  socketPath: string,
): SlackInboxClientIdentity {
  return {
    processId: process.pid,
    sessionId,
    herdrPaneId: paneId,
    herdrSocketPath: socketPath,
  };
}

describe("HerdrNotifier", () => {
  const resources: Array<{ directory: string; server: FakeHerdrServer }> = [];

  afterEach(async () => {
    for (const resource of resources.splice(0)) {
      await resource.server.close();
      await rm(resource.directory, { recursive: true, force: true });
    }
  });

  it("sends one capped display-only toast through the focused Herdr session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-slack-herdr-test-"));
    const socketPath = join(directory, "herdr.sock");
    const server = new FakeHerdrServer(socketPath);
    resources.push({ directory, server });
    await server.start();
    const notifier = new HerdrNotifier();

    await notifier.notify(message, [
      client("session-one", "w1:p1", socketPath),
      client("session-two", "w1:p2", socketPath),
    ]);

    expect(server.requests.map((request) => request.method)).toEqual([
      "session.snapshot",
      "notification.show",
    ]);
    expect(server.requests[1]?.params).toEqual({
      title: "Slack mention · Alice in #engineering",
      body: "<@USELF> Please look at the latest deployment. It needs attention.",
      sound: "none",
    });
  });

  it("routes across Herdr sessions to the one with the focused Pi", async () => {
    const firstDirectory = await mkdtemp(
      join(tmpdir(), "pi-slack-herdr-test-"),
    );
    const secondDirectory = await mkdtemp(
      join(tmpdir(), "pi-slack-herdr-test-"),
    );
    const firstPath = join(firstDirectory, "herdr.sock");
    const secondPath = join(secondDirectory, "herdr.sock");
    const firstServer = new FakeHerdrServer(firstPath, "w1:p9");
    const secondServer = new FakeHerdrServer(secondPath, "w2:p2");
    resources.push(
      { directory: firstDirectory, server: firstServer },
      { directory: secondDirectory, server: secondServer },
    );
    await Promise.all([firstServer.start(), secondServer.start()]);
    const notifier = new HerdrNotifier();

    await notifier.notify(message, [
      client("session-one", "w1:p1", firstPath),
      client("session-two", "w2:p2", secondPath),
    ]);

    expect(firstServer.requests.map((request) => request.method)).toEqual([
      "session.snapshot",
    ]);
    expect(secondServer.requests.map((request) => request.method)).toEqual([
      "session.snapshot",
      "notification.show",
    ]);
  });

  it("does nothing when no Pi client belongs to Herdr", async () => {
    const notifier = new HerdrNotifier();

    await expect(
      notifier.notify(message, [{ processId: process.pid }]),
    ).resolves.toBeUndefined();
  });
});
