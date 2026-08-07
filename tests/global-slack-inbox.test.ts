import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultGlobalSlackInboxClient,
  createGlobalSlackInboxClient,
  defaultSlackSidecarSocketPath,
  type GlobalSlackInbox,
  type GlobalSlackInboxSnapshot,
} from "../lib/global-slack-inbox.js";
import {
  prepareSlackSidecarDirectory,
  SlackSidecarServer,
  type SlackInboxBackend,
  type SlackInboxBackendEvent,
} from "../lib/slack-sidecar-server.js";
import type {
  SlackInboxMessage,
  SlackListenerStatus,
} from "../lib/slack-events";

class FakeInboxBackend implements SlackInboxBackend {
  private readonly listeners = new Set<
    (event: SlackInboxBackendEvent) => void
  >();
  private readonly messages: Array<SlackInboxMessage & { unread: boolean }> =
    [];
  private state: SlackListenerStatus["state"] = "stopped";

  async start(): Promise<void> {
    this.state = "connected";
    this.emitStatus();
  }

  async stop(): Promise<void> {
    this.state = "stopped";
    this.emitStatus();
  }

  status(): SlackListenerStatus {
    return {
      state: this.state,
      unread: this.messages.filter((message) => message.unread).length,
    };
  }

  readInbox(limit = 10): SlackInboxMessage[] {
    const selected = this.messages.slice(-limit);
    for (const message of selected) message.unread = false;
    this.emitStatus();
    return selected.map(({ unread: _unread, ...message }) => message);
  }

  clearInbox(): number {
    const count = this.messages.length;
    this.messages.length = 0;
    this.emitStatus();
    return count;
  }

  subscribe(listener: (event: SlackInboxBackendEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  receive(message: SlackInboxMessage): void {
    this.messages.push({ ...message, unread: true });
    this.emitStatus();
  }

  attention(message: SlackInboxMessage): void {
    const event: SlackInboxBackendEvent = { type: "attention", message };
    for (const listener of this.listeners) listener(event);
  }

  private emitStatus(): void {
    const event: SlackInboxBackendEvent = {
      type: "status",
      status: this.status(),
    };
    for (const listener of this.listeners) listener(event);
  }
}

const message: SlackInboxMessage = {
  eventId: "EvGlobal",
  channelId: "C123",
  channelName: "engineering",
  userId: "U123",
  userName: "Alice",
  text: "<@USELF> please review this",
  timestamp: "1786110000.001000",
  isMention: true,
};

function identity(id: string) {
  return {
    processId: process.pid,
    sessionId: id,
    sessionPath: `/tmp/${id}.jsonl`,
  };
}

function rawRequest(
  socketPath: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      try {
        resolve(
          JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>,
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", reject);
  });
}

describe("GlobalSlackInbox", () => {
  const resources: Array<{
    servers: SlackSidecarServer[];
    clients: GlobalSlackInbox[];
    directory: string;
  }> = [];

  afterEach(async () => {
    for (const resource of resources.splice(0)) {
      await Promise.all(resource.clients.map((client) => client.close()));
      await Promise.all(resource.servers.map((server) => server.close()));
      await rm(resource.directory, { recursive: true, force: true });
    }
  });

  it("isolates the sidecar by Slack credential identity without exposing tokens", () => {
    process.env.SLACK_APP_TOKEN = "xapp-first-secret";
    process.env.SLACK_USER_TOKEN = "xoxp-first-secret";
    const first = defaultSlackSidecarSocketPath();
    process.env.SLACK_USER_TOKEN = "xoxp-second-secret";
    const second = defaultSlackSidecarSocketPath();
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_USER_TOKEN;

    expect(first).not.toBe(second);
    expect(first).not.toContain("first-secret");
    expect(second).not.toContain("second-secret");
  });

  it("reports a missing sidecar bundle before entering reconnect backoff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-slack-bundle-test-"));
    resources.push({ servers: [], clients: [], directory });
    const previousEntry = process.env.PI_SLACK_SIDECAR_ENTRY;
    const previousSocket = process.env.PI_SLACK_SIDECAR_SOCKET;
    const previousAppToken = process.env.SLACK_APP_TOKEN;
    const previousUserToken = process.env.SLACK_USER_TOKEN;
    process.env.PI_SLACK_SIDECAR_ENTRY = join(directory, "missing-sidecar.mjs");
    process.env.PI_SLACK_SIDECAR_SOCKET = join(directory, "inbox.sock");
    process.env.SLACK_APP_TOKEN = "xapp-test";
    process.env.SLACK_USER_TOKEN = "xoxp-test";
    const client = createDefaultGlobalSlackInboxClient();
    resources[resources.length - 1]?.clients.push(client);

    try {
      await expect(client.connect(identity("missing-bundle"))).rejects.toThrow(
        "Slack sidecar bundle is unavailable",
      );
    } finally {
      if (previousEntry === undefined)
        delete process.env.PI_SLACK_SIDECAR_ENTRY;
      else process.env.PI_SLACK_SIDECAR_ENTRY = previousEntry;
      if (previousSocket === undefined)
        delete process.env.PI_SLACK_SIDECAR_SOCKET;
      else process.env.PI_SLACK_SIDECAR_SOCKET = previousSocket;
      if (previousAppToken === undefined) delete process.env.SLACK_APP_TOKEN;
      else process.env.SLACK_APP_TOKEN = previousAppToken;
      if (previousUserToken === undefined) delete process.env.SLACK_USER_TOKEN;
      else process.env.SLACK_USER_TOKEN = previousUserToken;
    }
  }, 10_000);

  it("launches the sidecar on demand when the socket is absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-slack-launch-test-"));
    const socketPath = join(directory, "inbox.sock");
    await chmod(directory, 0o755);
    const backend = new FakeInboxBackend();
    let server: SlackSidecarServer | undefined;
    const launchSidecar = vi.fn(async () => {
      server = new SlackSidecarServer({
        socketPath,
        backend,
        idleTimeoutMs: 60_000,
      });
      await server.start();
    });
    const client = createGlobalSlackInboxClient({
      socketPath,
      launchSidecar,
    });

    await client.connect(identity("launching-session"));

    expect(launchSidecar).toHaveBeenCalledOnce();
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    await expect(client.status()).resolves.toEqual({
      state: "connected",
      unread: 0,
    });
    if (!server) throw new Error("Sidecar was not launched.");
    resources.push({ servers: [server], clients: [client], directory });
  });

  it("caps failed relaunches and publishes a terminal error state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-slack-failure-test-"));
    const socketPath = join(directory, "missing.sock");
    const launchSidecar = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("sidecar launch failed"));
    const client = createGlobalSlackInboxClient({
      socketPath,
      launchSidecar,
      retryDelayMs: 1,
      maxReconnectAttempts: 2,
    });
    resources.push({ servers: [], clients: [client], directory });
    const snapshots: SlackListenerStatus[] = [];
    client.subscribe((snapshot) => snapshots.push(snapshot.status));

    await expect(client.connect(identity("failed-session"))).rejects.toThrow(
      "sidecar launch failed",
    );

    await vi.waitFor(() => expect(launchSidecar).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(snapshots.at(-1)?.state).toBe("error"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(launchSidecar).toHaveBeenCalledTimes(3);
  });

  it("relaunches and reconnects when the sidecar exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-slack-reconnect-test-"));
    const socketPath = join(directory, "inbox.sock");
    const servers: SlackSidecarServer[] = [];
    const launchSidecar = vi.fn(async () => {
      const server = new SlackSidecarServer({
        socketPath,
        backend: new FakeInboxBackend(),
        idleTimeoutMs: 60_000,
      });
      servers.push(server);
      await server.start();
    });
    const client = createGlobalSlackInboxClient({
      socketPath,
      launchSidecar,
      retryDelayMs: 5,
    });
    resources.push({ servers, clients: [client], directory });
    const snapshots: SlackListenerStatus[] = [];
    client.subscribe((snapshot: GlobalSlackInboxSnapshot) =>
      snapshots.push(snapshot.status),
    );
    await client.connect(identity("reconnecting-session"));

    await servers[0]?.close();

    await vi.waitFor(() => expect(launchSidecar).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(snapshots.at(-1)).toEqual({ state: "connected", unread: 0 }),
    );
  });

  it("rejects a socket placed directly in a shared temporary directory", async () => {
    if (process.platform === "win32") return;
    const beforeMode = (await stat("/tmp")).mode;

    await expect(
      prepareSlackSidecarDirectory("/tmp/pi-slack-insecure.sock"),
    ).rejects.toThrow("private directory");

    expect((await stat("/tmp")).mode).toBe(beforeMode);
  });

  it("rejects a symlinked socket directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-slack-path-test-"));
    const target = join(directory, "target");
    const socketDirectory = join(directory, "socket-link");
    await mkdir(target);
    await symlink(target, socketDirectory);
    resources.push({ servers: [], clients: [], directory });

    await expect(
      prepareSlackSidecarDirectory(join(socketDirectory, "inbox.sock")),
    ).rejects.toThrow("real directory");
  });

  it("rejects clients using an incompatible protocol version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-slack-version-test-"));
    const socketPath = join(directory, "inbox.sock");
    const server = new SlackSidecarServer({
      socketPath,
      backend: new FakeInboxBackend(),
      idleTimeoutMs: 60_000,
    });
    resources.push({ servers: [server], clients: [], directory });
    await server.start();

    const response = await rawRequest(socketPath, {
      id: "version-test",
      type: "hello",
      protocolVersion: 999,
      identity: identity("old-client"),
    });

    expect(response).toMatchObject({
      kind: "response",
      id: "version-test",
      ok: false,
    });
    expect(response.error).toContain("protocol mismatch");
  });

  it("stops after the final client disconnects and the grace period expires", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-slack-idle-test-"));
    const socketPath = join(directory, "inbox.sock");
    const backend = new FakeInboxBackend();
    const server = new SlackSidecarServer({
      socketPath,
      backend,
      idleTimeoutMs: 10,
    });
    const client = createGlobalSlackInboxClient({ socketPath });
    resources.push({ servers: [server], clients: [client], directory });
    await server.start();
    await client.connect(identity("last-client"));

    await client.close();

    await vi.waitFor(() => expect(existsSync(socketPath)).toBe(false));
    expect(backend.status().state).toBe("stopped");
  });

  it("fans out one global unread state and marks viewed messages read globally", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-slack-global-test-"));
    const socketPath = join(directory, "inbox.sock");
    const backend = new FakeInboxBackend();
    const onAttention = vi.fn();
    const server = new SlackSidecarServer({
      socketPath,
      backend,
      idleTimeoutMs: 60_000,
      onAttention,
    });
    await server.start();

    const first = createGlobalSlackInboxClient({ socketPath });
    const second = createGlobalSlackInboxClient({ socketPath });
    resources.push({ servers: [server], clients: [first, second], directory });
    const firstSnapshots: SlackListenerStatus[] = [];
    const secondSnapshots: SlackListenerStatus[] = [];
    first.subscribe((snapshot: GlobalSlackInboxSnapshot) =>
      firstSnapshots.push(snapshot.status),
    );
    second.subscribe((snapshot: GlobalSlackInboxSnapshot) =>
      secondSnapshots.push(snapshot.status),
    );

    await Promise.all([
      first.connect(identity("session-one")),
      second.connect(identity("session-two")),
    ]);
    backend.receive(message);
    backend.attention(message);

    await vi.waitFor(() => {
      expect(firstSnapshots.at(-1)).toEqual({
        state: "connected",
        unread: 1,
      });
      expect(secondSnapshots.at(-1)).toEqual({
        state: "connected",
        unread: 1,
      });
    });

    expect(onAttention).toHaveBeenCalledWith(message, [
      identity("session-one"),
      identity("session-two"),
    ]);
    await expect(first.readInbox(0)).resolves.toEqual([]);
    expect(firstSnapshots.at(-1)?.unread).toBe(1);
    expect(secondSnapshots.at(-1)?.unread).toBe(1);
    await expect(first.readInbox(10)).resolves.toEqual([message]);
    await vi.waitFor(() => {
      expect(firstSnapshots.at(-1)?.unread).toBe(0);
      expect(secondSnapshots.at(-1)?.unread).toBe(0);
    });

    await expect(second.readInbox(10)).resolves.toEqual([message]);

    await second.setListening(false);
    await vi.waitFor(() => {
      expect(firstSnapshots.at(-1)?.state).toBe("stopped");
      expect(secondSnapshots.at(-1)?.state).toBe("stopped");
    });
    await first.setListening(true);
    await vi.waitFor(() => {
      expect(firstSnapshots.at(-1)?.state).toBe("connected");
      expect(secondSnapshots.at(-1)?.state).toBe("connected");
    });

    await first.close();
    await expect(second.status()).resolves.toEqual({
      state: "connected",
      unread: 0,
    });
  });
});
