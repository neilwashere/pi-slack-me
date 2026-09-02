import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import type { SlackCatchUpResult } from "./slack-catch-up";
import type { SlackInboxMessage, SlackListenerStatus } from "./slack-events";
import type {
  SlackInboxPullFilter,
  SlackInboxPullItem,
} from "./slack-inbox-store";
import {
  SLACK_SIDECAR_PROTOCOL_VERSION,
  type GlobalSlackInboxSnapshot,
  type SlackInboxClientIdentity,
  type SlackSidecarRequest,
  type SlackSidecarResponse,
} from "./slack-sidecar-protocol";

const MAX_REQUEST_BYTES = 1024 * 1024;
const SHARED_TEMP_DIRECTORIES = new Set(["/tmp", "/private/tmp"]);

export async function prepareSlackSidecarDirectory(
  socketPath: string,
): Promise<void> {
  if (process.platform === "win32") return;
  const socketDirectory = dirname(socketPath);
  await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
  const directoryPath = resolve(socketDirectory);
  if (SHARED_TEMP_DIRECTORIES.has(directoryPath)) {
    throw new Error("Slack sidecar socket requires a private directory.");
  }
  const directoryStat = await lstat(directoryPath);
  if (!directoryStat.isDirectory()) {
    throw new Error("Slack sidecar path parent must be a real directory.");
  }
  const userId = process.getuid?.();
  if (userId !== undefined && directoryStat.uid !== userId) {
    throw new Error(
      "Slack sidecar directory is not owned by the current user.",
    );
  }
  await chmod(directoryPath, 0o700);
}

async function removeSocketFile(socketPath: string): Promise<void> {
  try {
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function unsupportedRequest(request: never): never {
  throw new Error(
    `Unsupported Slack sidecar request: ${JSON.stringify(request)}`,
  );
}

function normalizedInboxLimit(limit: unknown): number | undefined {
  if (limit === undefined) return undefined;
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new Error("Slack inbox limit must be a finite number.");
  }
  return Math.min(100, Math.max(0, Math.trunc(limit)));
}

function normalizedStringList(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Slack inbox ${label} must be an array of strings.`);
  }
  return value as string[];
}

function normalizedPullFilter(
  filter: SlackInboxPullFilter | undefined,
): SlackInboxPullFilter | undefined {
  if (filter === undefined) return undefined;
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
    throw new Error("Slack inbox pull filter must be an object.");
  }
  if (
    filter.leaseMs !== undefined &&
    (typeof filter.leaseMs !== "number" ||
      !Number.isFinite(filter.leaseMs) ||
      filter.leaseMs < 1_000 ||
      filter.leaseMs > 86_400_000)
  ) {
    throw new Error(
      "Slack inbox leaseMs must be between 1000 and 86400000 milliseconds.",
    );
  }
  const attentionKinds = normalizedStringList(
    filter.attentionKinds,
    "attentionKinds",
  );
  for (const kind of attentionKinds ?? []) {
    if (
      kind !== "mention" &&
      kind !== "thread-reply" &&
      kind !== "direct-message"
    ) {
      throw new Error(
        'Slack inbox attentionKinds accepts only "mention", "thread-reply", and "direct-message".',
      );
    }
  }
  return {
    limit: normalizedInboxLimit(filter.limit),
    fromUsers: normalizedStringList(filter.fromUsers, "fromUsers"),
    channelIds: normalizedStringList(filter.channelIds, "channelIds"),
    attentionKinds: attentionKinds as SlackInboxPullFilter["attentionKinds"],
    leaseMs: filter.leaseMs,
  };
}

function normalizedAckKeys(keys: unknown): string[] {
  const normalized = normalizedStringList(keys, "ack keys");
  if (!normalized) throw new Error("Slack inbox ack requires keys.");
  return normalized;
}

export type SlackInboxBackendEvent =
  | { type: "status"; status: SlackListenerStatus }
  | { type: "attention"; message: SlackInboxMessage };

export interface SlackInboxBackend {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): SlackListenerStatus;
  readInbox(limit?: number): SlackInboxMessage[];
  pullInbox(filter?: SlackInboxPullFilter): SlackInboxPullItem[];
  ackInbox(keys: readonly string[]): number;
  catchUp(): Promise<SlackCatchUpResult>;
  clearInbox(): number;
  subscribe(listener: (event: SlackInboxBackendEvent) => void): () => void;
}

export interface SlackSidecarServerOptions {
  socketPath: string;
  backend: SlackInboxBackend;
  idleTimeoutMs?: number;
  onAttention?: (
    message: SlackInboxMessage,
    clients: readonly SlackInboxClientIdentity[],
  ) => void | Promise<void>;
}

interface ConnectedClient {
  socket: Socket;
  identity?: SlackInboxClientIdentity;
  buffer: string;
}

export class SlackSidecarServer {
  private readonly clients = new Map<Socket, ConnectedClient>();
  private server?: Server;
  private unsubscribeBackend?: () => void;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private closing?: Promise<void>;

  constructor(private readonly options: SlackSidecarServerOptions) {}

  async start(): Promise<void> {
    if (this.server) return;
    await prepareSlackSidecarDirectory(this.options.socketPath);
    await removeSocketFile(this.options.socketPath);
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    await chmod(this.options.socketPath, 0o600);
    this.unsubscribeBackend = this.options.backend.subscribe((event) => {
      if (event.type === "status") {
        this.broadcastSnapshot({ status: event.status });
        return;
      }
      void this.deliverAttention(event.message);
    });
    try {
      await this.options.backend.start();
    } catch {
      // SlackEventListener owns bounded reconnects after a failed start.
    }
    this.scheduleIdleShutdown();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.performClose();
    return this.closing;
  }

  private async performClose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.unsubscribeBackend?.();
    this.unsubscribeBackend = undefined;
    try {
      await this.options.backend.stop();
    } catch {
      // Closing the IPC server must continue after a transport shutdown failure.
    }
    for (const client of this.clients.values()) client.socket.destroy();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await removeSocketFile(this.options.socketPath);
  }

  private accept(socket: Socket): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    socket.setEncoding("utf8");
    const client: ConnectedClient = { socket, buffer: "" };
    this.clients.set(socket, client);
    socket.on("data", (chunk: string) => this.receive(client, chunk));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      this.clients.delete(socket);
      this.scheduleIdleShutdown();
    });
  }

  private receive(client: ConnectedClient, chunk: string): void {
    client.buffer += chunk;
    if (Buffer.byteLength(client.buffer) > MAX_REQUEST_BYTES) {
      client.socket.destroy();
      return;
    }
    let newline = client.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = client.buffer.slice(0, newline);
      client.buffer = client.buffer.slice(newline + 1);
      if (line) void this.receiveLine(client, line);
      newline = client.buffer.indexOf("\n");
    }
  }

  private async receiveLine(
    client: ConnectedClient,
    line: string,
  ): Promise<void> {
    let request: SlackSidecarRequest;
    try {
      request = JSON.parse(line) as SlackSidecarRequest;
    } catch {
      client.socket.destroy();
      return;
    }
    try {
      const result = await this.handle(client, request);
      this.send(client.socket, {
        kind: "response",
        id: request.id,
        ok: true,
        result,
      });
    } catch (error) {
      this.send(client.socket, {
        kind: "response",
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handle(
    client: ConnectedClient,
    request: SlackSidecarRequest,
  ): Promise<unknown> {
    if (request.type === "hello") {
      if (request.protocolVersion !== SLACK_SIDECAR_PROTOCOL_VERSION) {
        throw new Error(
          `Slack inbox protocol mismatch: sidecar=${SLACK_SIDECAR_PROTOCOL_VERSION}, client=${request.protocolVersion}.`,
        );
      }
      client.identity = request.identity;
      return this.snapshot();
    }
    if (!client.identity)
      throw new Error("Slack inbox client has not registered.");
    switch (request.type) {
      case "status":
        return this.snapshot();
      case "set-listening":
        if (request.enabled) await this.options.backend.start();
        else await this.options.backend.stop();
        return this.snapshot();
      case "read-inbox": {
        const limit = normalizedInboxLimit(request.limit);
        return limit === 0 ? [] : this.options.backend.readInbox(limit);
      }
      case "pull-inbox":
        return this.options.backend.pullInbox(
          normalizedPullFilter(request.filter),
        );
      case "ack-inbox":
        return this.options.backend.ackInbox(normalizedAckKeys(request.keys));
      case "catch-up":
        return this.options.backend.catchUp();
      case "clear-inbox":
        return this.options.backend.clearInbox();
      default:
        return unsupportedRequest(request);
    }
  }

  private async deliverAttention(message: SlackInboxMessage): Promise<void> {
    try {
      await this.options.onAttention?.(message, this.clientIdentities());
    } catch {
      // A presentation adapter cannot interrupt inbox delivery.
    }
  }

  private snapshot(): GlobalSlackInboxSnapshot {
    return { status: this.options.backend.status() };
  }

  private clientIdentities(): SlackInboxClientIdentity[] {
    return [...this.clients.values()].flatMap((client) =>
      client.identity ? [client.identity] : [],
    );
  }

  private broadcastSnapshot(snapshot: GlobalSlackInboxSnapshot): void {
    const message = `${JSON.stringify({ kind: "snapshot", snapshot })}\n`;
    for (const client of this.clients.values()) {
      if (client.identity && !client.socket.destroyed)
        client.socket.write(message);
    }
  }

  private send(socket: Socket, response: SlackSidecarResponse): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
  }

  private scheduleIdleShutdown(): void {
    if (this.clients.size > 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(
      () => void this.close(),
      this.options.idleTimeoutMs ?? 30_000,
    );
    this.idleTimer.unref?.();
  }
}
