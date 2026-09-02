import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  type SlackSidecarMessage,
  type SlackSidecarRequestInput,
} from "./slack-sidecar-protocol";

const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 6;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;

export interface GlobalSlackInbox {
  connect(identity: SlackInboxClientIdentity): Promise<void>;
  subscribe(listener: (snapshot: GlobalSlackInboxSnapshot) => void): () => void;
  status(): Promise<SlackListenerStatus>;
  setListening(enabled: boolean): Promise<SlackListenerStatus>;
  readInbox(limit?: number): Promise<SlackInboxMessage[]>;
  pullInbox(filter?: SlackInboxPullFilter): Promise<SlackInboxPullItem[]>;
  ackInbox(keys: readonly string[]): Promise<number>;
  catchUp(): Promise<SlackCatchUpResult>;
  clearInbox(): Promise<number>;
  close(): Promise<void>;
}

export interface GlobalSlackInboxClientOptions {
  socketPath: string;
  connectTimeoutMs?: number;
  launchTimeoutMs?: number;
  retryDelayMs?: number;
  maxReconnectAttempts?: number;
  maxReconnectDelayMs?: number;
  launchSidecar?: () => void | Promise<void>;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

class UnixGlobalSlackInbox implements GlobalSlackInbox {
  private readonly listeners = new Set<
    (snapshot: GlobalSlackInboxSnapshot) => void
  >();
  private readonly pending = new Map<string, PendingRequest>();
  private socket?: Socket;
  private identity?: SlackInboxClientIdentity;
  private buffer = "";
  private requestSequence = 0;
  private lastSnapshot?: GlobalSlackInboxSnapshot;
  private connectionPromise?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private closed = false;

  constructor(private readonly options: GlobalSlackInboxClientOptions) {}

  async connect(identity: SlackInboxClientIdentity): Promise<void> {
    if (this.closed) throw new Error("Slack inbox client is closed.");
    this.identity = identity;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    try {
      await this.ensureConnected();
    } catch (error) {
      this.scheduleReconnect();
      throw error;
    }
  }

  subscribe(
    listener: (snapshot: GlobalSlackInboxSnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    if (this.lastSnapshot) listener(this.lastSnapshot);
    return () => this.listeners.delete(listener);
  }

  async status(): Promise<SlackListenerStatus> {
    const snapshot = await this.request<GlobalSlackInboxSnapshot>({
      type: "status",
    });
    this.publish(snapshot);
    return snapshot.status;
  }

  async setListening(enabled: boolean): Promise<SlackListenerStatus> {
    const snapshot = await this.request<GlobalSlackInboxSnapshot>({
      type: "set-listening",
      enabled,
    });
    this.publish(snapshot);
    return snapshot.status;
  }

  readInbox(limit?: number): Promise<SlackInboxMessage[]> {
    return this.request({ type: "read-inbox", limit });
  }

  pullInbox(filter?: SlackInboxPullFilter): Promise<SlackInboxPullItem[]> {
    return this.request({ type: "pull-inbox", filter });
  }

  ackInbox(keys: readonly string[]): Promise<number> {
    return this.request({ type: "ack-inbox", keys: [...keys] });
  }

  catchUp(): Promise<SlackCatchUpResult> {
    return this.request({ type: "catch-up" });
  }

  clearInbox(): Promise<number> {
    return this.request({ type: "clear-inbox" });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.rejectPending(new Error("Slack inbox client closed."));
    if (!socket || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => socket.destroy(), 500);
      timeout.unref?.();
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.end();
    });
  }

  private ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connectionPromise) return this.connectionPromise;
    const identity = this.identity;
    if (!identity)
      return Promise.reject(new Error("Slack inbox client has no identity."));
    this.connectionPromise = this.establishConnection(identity).finally(() => {
      this.connectionPromise = undefined;
    });
    return this.connectionPromise;
  }

  private async establishConnection(
    identity: SlackInboxClientIdentity,
  ): Promise<void> {
    const socket = await this.openOrLaunchSocket();
    if (this.closed) {
      socket.destroy();
      throw new Error("Slack inbox client is closed.");
    }
    this.buffer = "";
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("error", (error) => this.handleDisconnect(socket, error));
    socket.on("close", () =>
      this.handleDisconnect(
        socket,
        new Error("Slack inbox sidecar disconnected."),
      ),
    );
    try {
      const snapshot = await this.request<GlobalSlackInboxSnapshot>({
        type: "hello",
        protocolVersion: SLACK_SIDECAR_PROTOCOL_VERSION,
        identity,
      });
      this.reconnectAttempts = 0;
      this.publish(snapshot);
    } catch (error) {
      this.handleDisconnect(
        socket,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  private async openOrLaunchSocket(): Promise<Socket> {
    try {
      return await this.openSocket();
    } catch (initialError) {
      if (!this.options.launchSidecar) throw initialError;
      await this.options.launchSidecar();
      const deadline = Date.now() + (this.options.launchTimeoutMs ?? 5_000);
      let lastError = initialError;
      while (Date.now() < deadline) {
        try {
          return await this.openSocket();
        } catch (error) {
          lastError = error;
          await new Promise<void>((resolve) =>
            setTimeout(resolve, this.options.retryDelayMs ?? 50),
          );
        }
      }
      throw lastError;
    }
  }

  private openSocket(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.options.socketPath);
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error("Timed out connecting to Slack inbox sidecar."));
      }, this.options.connectTimeoutMs ?? 2_000);
      timeout.unref?.();
      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.removeListener("error", fail);
        resolve(socket);
      });
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        reject(error);
      };
      socket.once("error", fail);
    });
  }

  private request<T>(request: SlackSidecarRequestInput): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error("Slack inbox sidecar is not connected."));
    }
    const id = `pi-slack-${process.pid}-${++this.requestSequence}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      socket.write(`${JSON.stringify({ ...request, id })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_MESSAGE_BYTES) {
      this.socket?.destroy(
        new Error("Slack inbox sidecar sent an oversized message."),
      );
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.receiveLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private receiveLine(line: string): void {
    let message: SlackSidecarMessage;
    try {
      message = JSON.parse(line) as SlackSidecarMessage;
    } catch {
      this.socket?.destroy(new Error("Slack inbox sidecar sent invalid JSON."));
      return;
    }
    if (message.kind === "snapshot") {
      this.publish(message.snapshot);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error));
  }

  private publish(snapshot: GlobalSlackInboxSnapshot): void {
    this.lastSnapshot = snapshot;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // One Pi UI adapter cannot interrupt relay delivery to the others.
      }
    }
  }

  private handleDisconnect(socket: Socket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    if (!socket.destroyed) socket.destroy();
    this.rejectPending(error);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.identity || this.reconnectTimer) return;
    const maxAttempts =
      this.options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    if (this.reconnectAttempts >= maxAttempts) {
      this.publish({
        status: {
          state: "error",
          unread: this.lastSnapshot?.status.unread ?? 0,
        },
      });
      return;
    }
    const baseDelay = this.options.retryDelayMs ?? 250;
    const delay = Math.min(
      baseDelay * 2 ** this.reconnectAttempts,
      this.options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts += 1;
    this.publish({
      status: {
        state: "reconnecting",
        unread: this.lastSnapshot?.status.unread ?? 0,
      },
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensureConnected().catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function createGlobalSlackInboxClient(
  options: GlobalSlackInboxClientOptions,
): GlobalSlackInbox {
  return new UnixGlobalSlackInbox(options);
}

export function defaultSlackSidecarSocketPath(): string {
  const override = process.env.PI_SLACK_SIDECAR_SOCKET?.trim();
  if (override) return override;
  const user = process.getuid?.() ?? process.env.USER ?? "default";
  const credentialIdentity = [
    process.env.SLACK_APP_TOKEN ?? "",
    process.env.SLACK_USER_TOKEN ?? "",
  ].join("\0");
  const credentialHash = createHash("sha256")
    .update(credentialIdentity)
    .digest("hex")
    .slice(0, 16);
  const name = `v${SLACK_SIDECAR_PROTOCOL_VERSION}-${credentialHash}`;
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\pi-slack-me-${user}-${name}`;
  }
  return join("/tmp", `pi-slack-me-${user}`, `${name}.sock`);
}

async function launchDefaultSlackSidecar(socketPath: string): Promise<void> {
  if (!process.env.SLACK_APP_TOKEN?.trim()) {
    throw new Error("SLACK_APP_TOKEN is not configured for Slack Socket Mode.");
  }
  if (!process.env.SLACK_USER_TOKEN?.trim()) {
    throw new Error("SLACK_USER_TOKEN is not configured for the Slack inbox.");
  }
  const configuredEntry = process.env.PI_SLACK_SIDECAR_ENTRY?.trim();
  const entryPath =
    configuredEntry ??
    fileURLToPath(new URL("../dist/slack-sidecar.mjs", import.meta.url));
  try {
    await access(entryPath);
  } catch (error) {
    throw new Error(`Slack sidecar bundle is unavailable at ${entryPath}.`, {
      cause: error,
    });
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath], {
      detached: true,
      env: { ...process.env, PI_SLACK_SIDECAR_SOCKET: socketPath },
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("spawn", resolve);
    child.once("error", reject);
    child.unref();
  });
}

export function createDefaultGlobalSlackInboxClient(): GlobalSlackInbox {
  const socketPath = defaultSlackSidecarSocketPath();
  return createGlobalSlackInboxClient({
    socketPath,
    launchSidecar: () => launchDefaultSlackSidecar(socketPath),
  });
}

export type {
  GlobalSlackInboxSnapshot,
  SlackInboxClientIdentity,
} from "./slack-sidecar-protocol";
