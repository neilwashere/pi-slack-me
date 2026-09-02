// Durable Socket Mode retention keeps undelivered work across sidecar restarts.
//
// TWO CONSUMER ACTIONS:
//
//   readUnread() - marks a message read on the human `/slack inbox` surface but
//                  leaves it pending for an agent.
//   pull()/ack() - leases work to an agent; ack completes it globally. An agent
//                  that dies mid-work has its lease expire and the message is
//                  handed out again.
//
// DEDUPE KEY is `channelId:timestamp`, never Slack's event_id. A message that
// arrives over the socket and is later re-fetched from the Web API carries the
// same channel and ts but no event_id, so keying on event_id would admit the
// same message twice.
//
// SINGLE WRITER: exactly one sidecar owns a given store file, enforced upstream
// by the sidecar socket lock. There is no file locking here, so pointing two
// writers at one path will lose writes.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SlackInboxMessage } from "./slack-events";

/**
 * Refuse new work past this bound rather than silently evicting unacked work.
 * Catch-up can retry refused messages after an agent drains the queue.
 */
const MAX_RETAINED_MESSAGES = 1_000;

/**
 * Keys remembered for dedupe after their message is acked or cleared. Past
 * this bound the oldest completed key is forgotten, so sufficiently old Slack
 * history can be admitted again.
 */
const MAX_SEEN_KEYS = 1_000;

/** How long a pulled message stays invisible before it is handed out again. */
const DEFAULT_LEASE_MS = 5 * 60_000;

const STORE_VERSION = 3;

export interface SlackInboxRecord extends SlackInboxMessage {
  key: string;
  unread: boolean;
  deliveryCount: number;
  /** Epoch ms until which pull() skips this record; absent when not leased. */
  leaseExpiresAt?: number;
}

export interface SlackInboxPullItem extends SlackInboxMessage {
  key: string;
  /** Times this message has been handed to an agent, including this one. */
  deliveryCount: number;
}

export interface SlackInboxPullFilter {
  limit?: number;
  /** Slack user IDs or display names; a message matches any one of them. */
  fromUsers?: string[];
  channelIds?: string[];
  attentionKinds?: Array<"mention" | "thread-reply" | "direct-message">;
  leaseMs?: number;
}

export interface SlackInboxCounts {
  unread: number;
  /** Retained and unacked, whether or not currently leased. */
  pending: number;
}

export interface SlackTrackedThread {
  channelId: string;
  threadTimestamp: string;
  latestTimestamp: string;
}

export interface SlackRecoveryContinuation {
  floor: string;
  cutoff: string;
  latest: string;
}

interface PersistedStore {
  version: number;
  records: SlackInboxRecord[];
  seenKeys: string[];
  watermarks: Record<string, string>;
  trackedThreads: SlackTrackedThread[];
  channels: Record<string, "channel" | "group" | "im" | "mpim">;
  continuations: Record<string, SlackRecoveryContinuation>;
}

export function inboxKey(channelId: string, timestamp: string): string {
  return `${channelId}:${timestamp}`;
}

export function channelWatermarkKey(channelId: string): string {
  return `channel:${channelId}`;
}

export function defaultSlackInboxStorePath(): string {
  const override = process.env.PI_SLACK_INBOX_STORE?.trim();
  if (override) return override;
  const piDir =
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const userToken = process.env.SLACK_USER_TOKEN ?? "";
  const tokenParts = userToken.split("-");
  const stableUserIdentity =
    tokenParts[0] === "xoxp" && tokenParts[1] && tokenParts[2]
      ? `${tokenParts[1]}:${tokenParts[2]}`
      : userToken;
  const credentialHash = createHash("sha256")
    .update(stableUserIdentity)
    .digest("hex")
    .slice(0, 16);
  return join(piDir, `pi-slack-me-inbox-${credentialHash}.json`);
}

function normalizeMatchValue(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "");
}

export interface SlackInboxStoreOptions {
  path?: string;
  now?: () => number;
}

export interface SlackInboxAddOptions {
  /** Live events track participating threads; backfill does so per scope. */
  trackParticipation?: boolean;
}

export class SlackInboxStore {
  private readonly path: string;
  private readonly now: () => number;
  private readonly records = new Map<string, SlackInboxRecord>();
  private readonly seenKeys = new Set<string>();
  private readonly seenKeyOrder: string[] = [];
  private readonly watermarks = new Map<string, string>();
  private readonly threads = new Map<string, SlackTrackedThread>();
  private readonly channels = new Map<
    string,
    "channel" | "group" | "im" | "mpim"
  >();
  private readonly continuations = new Map<
    string,
    SlackRecoveryContinuation
  >();

  constructor(options: SlackInboxStoreOptions = {}) {
    this.path = options.path ?? defaultSlackInboxStorePath();
    this.now = options.now ?? Date.now;
    this.load();
  }

  /**
   * Whether this key was ever admitted, including messages since completed. A
   * cheap pre-check for callers that would otherwise do API work to
   * classify a message add() is about to reject.
   */
  isSeen(key: string): boolean {
    return this.records.has(key) || this.seenKeys.has(key);
  }

  /**
   * Retain a newly observed message. Returns false when its key has been seen
   * before, which is the caller's signal to skip all downstream notification.
   */
  add(
    message: SlackInboxMessage,
    options: SlackInboxAddOptions = {},
  ): boolean {
    const key = inboxKey(message.channelId, message.timestamp);
    if (this.records.has(key) || this.seenKeys.has(key)) return false;
    if (this.records.size >= MAX_RETAINED_MESSAGES) {
      throw new Error(
        `Slack inbox is full (${MAX_RETAINED_MESSAGES} unacked messages).`,
      );
    }
    return this.commit(() => {
      this.rememberKey(key);
      this.records.set(key, {
        ...message,
        key,
        unread: true,
        deliveryCount: 0,
      });
      if (message.channelType) {
        this.channels.set(message.channelId, message.channelType);
      }
      if (
        options.trackParticipation !== false &&
        (message.threadTimestamp || message.isMention)
      ) {
        this.trackThreadInMemory(
          message.channelId,
          message.threadTimestamp ?? message.timestamp,
          message.timestamp,
        );
      }
      return true;
    });
  }

  /**
   * Oldest unread messages, marked read. Acked state is untouched, so a message
   * read here is still pending for an agent.
   */
  readUnread(limit = 10): SlackInboxMessage[] {
    const bounded = boundedLimit(limit);
    if (bounded === 0) return [];
    const selected = this.sortedRecords()
      .filter((record) => record.unread)
      .slice(0, bounded);
    if (selected.length === 0) return [];
    return this.commit(() => {
      for (const record of selected) record.unread = false;
      return selected.map(toMessage);
    });
  }

  /**
   * Lease the oldest matching unacked messages to an agent. A pulled message
   * stays retained; only ack() removes it. Its lease expires after leaseMs, at
   * which point another pull hands it out again with a higher deliveryCount.
   */
  pull(filter: SlackInboxPullFilter = {}): SlackInboxPullItem[] {
    const bounded = boundedLimit(filter.limit ?? 10);
    if (bounded === 0) return [];
    const now = this.now();
    const leaseMs = Math.max(0, filter.leaseMs ?? DEFAULT_LEASE_MS);
    const fromUsers = filter.fromUsers?.map(normalizeMatchValue);
    const channelIds = filter.channelIds?.map(normalizeMatchValue);

    const selected = this.sortedRecords()
      .filter((record) => {
        if (record.leaseExpiresAt !== undefined && record.leaseExpiresAt > now) {
          return false;
        }
        if (
          fromUsers?.length &&
          !fromUsers.includes(normalizeMatchValue(record.userId)) &&
          !fromUsers.includes(normalizeMatchValue(record.userName))
        ) {
          return false;
        }
        if (
          channelIds?.length &&
          !channelIds.includes(normalizeMatchValue(record.channelId)) &&
          !channelIds.includes(normalizeMatchValue(record.channelName))
        ) {
          return false;
        }
        if (
          filter.attentionKinds?.length &&
          (record.attentionKind === undefined ||
            !filter.attentionKinds.includes(record.attentionKind))
        ) {
          return false;
        }
        return true;
      })
      .slice(0, bounded);

    if (selected.length === 0) return [];
    return this.commit(() => {
      for (const record of selected) {
        record.deliveryCount += 1;
        record.leaseExpiresAt = now + leaseMs;
      }
      return selected.map((record) => ({
        ...toMessage(record),
        key: record.key,
        deliveryCount: record.deliveryCount,
      }));
    });
  }

  /** Complete messages by key. Returns how many were actually retained. */
  ack(keys: readonly string[]): number {
    const retainedKeys = [...new Set(keys)].filter((key) =>
      this.records.has(key),
    );
    if (retainedKeys.length === 0) return 0;
    return this.commit(() => {
      for (const key of retainedKeys) this.records.delete(key);
      return retainedKeys.length;
    });
  }

  /** Drop every retained message. Seen keys survive, so cleared work is not replayed. */
  clear(): number {
    const count = this.records.size;
    if (count === 0) return 0;
    return this.commit(() => {
      this.records.clear();
      return count;
    });
  }

  counts(): SlackInboxCounts {
    let unread = 0;
    for (const record of this.records.values()) {
      if (record.unread) unread += 1;
    }
    return { unread, pending: this.records.size };
  }

  watermark(scope: string): string | undefined {
    return this.watermarks.get(scope);
  }

  rememberChannels(
    channels: ReadonlyArray<{
      channelId: string;
      channelType: "channel" | "group" | "im" | "mpim";
    }>,
  ): void {
    const changed = channels.some(
      ({ channelId, channelType }) =>
        this.channels.get(channelId) !== channelType,
    );
    if (!changed) return;
    this.commit(() => {
      for (const { channelId, channelType } of channels) {
        this.channels.set(channelId, channelType);
      }
    });
  }

  knownChannels(): Array<{
    channelId: string;
    channelType?: "channel" | "group" | "im" | "mpim";
    timestamp?: string;
  }> {
    const channelIds = new Set(this.channels.keys());
    const prefix = "channel:";
    for (const scope of this.watermarks.keys()) {
      if (scope.startsWith(prefix)) channelIds.add(scope.slice(prefix.length));
    }
    return [...channelIds].map((channelId) => ({
      channelId,
      channelType: this.channels.get(channelId),
      timestamp: this.watermarks.get(channelWatermarkKey(channelId)),
    }));
  }

  advanceWatermark(scope: string, timestamp: string): void {
    const current = this.watermarks.get(scope);
    if (current !== undefined && current >= timestamp) return;
    this.commit(() => this.advanceWatermarkInMemory(scope, timestamp));
  }

  recoveryContinuation(scope: string): SlackRecoveryContinuation | undefined {
    const continuation = this.continuations.get(scope);
    return continuation ? { ...continuation } : undefined;
  }

  saveRecoveryContinuation(
    scope: string,
    continuation: SlackRecoveryContinuation,
  ): void {
    this.commit(() =>
      this.continuations.set(scope, { ...continuation }),
    );
  }

  completeRecoveryScope(scope: string, timestamp: string): void {
    this.commit(() => {
      this.advanceWatermarkInMemory(scope, timestamp);
      this.continuations.delete(scope);
    });
  }

  trackedThreads(): SlackTrackedThread[] {
    return [...this.threads.values()].map((thread) => ({ ...thread }));
  }

  tracksThread(channelId: string, threadTimestamp: string): boolean {
    return this.threads.has(inboxKey(channelId, threadTimestamp));
  }

  trackThread(
    channelId: string,
    threadTimestamp: string,
    latestTimestamp = threadTimestamp,
    channelType?: "channel" | "group" | "im" | "mpim",
  ): void {
    const key = inboxKey(channelId, threadTimestamp);
    const current = this.threads.get(key);
    const channelKnown = channelType
      ? this.channels.get(channelId) === channelType
      : true;
    if (current && current.latestTimestamp >= latestTimestamp && channelKnown) {
      return;
    }
    this.commit(() => {
      this.trackThreadInMemory(channelId, threadTimestamp, latestTimestamp);
      if (channelType) this.channels.set(channelId, channelType);
    });
  }

  observeOwnMessage(
    channelId: string,
    channelType: "channel" | "group" | "im" | "mpim",
    threadTimestamp: string,
    timestamp: string,
  ): void {
    this.commit(() => {
      this.channels.set(channelId, channelType);
      this.trackThreadInMemory(channelId, threadTimestamp, timestamp);
    });
  }

  private advanceWatermarkInMemory(scope: string, timestamp: string): void {
    const current = this.watermarks.get(scope);
    if (current === undefined || current < timestamp) {
      this.watermarks.set(scope, timestamp);
    }
  }

  private trackThreadInMemory(
    channelId: string,
    threadTimestamp: string,
    latestTimestamp: string,
  ): void {
    const key = inboxKey(channelId, threadTimestamp);
    const current = this.threads.get(key);
    if (current && current.latestTimestamp >= latestTimestamp) return;
    this.threads.set(key, { channelId, threadTimestamp, latestTimestamp });
    while (this.threads.size > MAX_SEEN_KEYS) {
      const oldest = this.threads.keys().next().value as string | undefined;
      if (!oldest) return;
      this.threads.delete(oldest);
    }
  }

  private sortedRecords(): SlackInboxRecord[] {
    return [...this.records.values()].sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp),
    );
  }

  private rememberKey(key: string): void {
    this.seenKeys.add(key);
    this.seenKeyOrder.push(key);
    while (this.seenKeyOrder.length > MAX_SEEN_KEYS) {
      const expired = this.seenKeyOrder.shift();
      if (expired) this.seenKeys.delete(expired);
    }
  }

  /** Restore the in-memory state if an atomic disk update fails. */
  private commit<T>(mutation: () => T): T {
    const recordsBefore = new Map(
      [...this.records].map(([key, record]) => [key, { ...record }]),
    );
    const seenBefore = [...this.seenKeyOrder];
    const watermarksBefore = new Map(this.watermarks);
    const threadsBefore = new Map(
      [...this.threads].map(([key, thread]) => [key, { ...thread }]),
    );
    const channelsBefore = new Map(this.channels);
    const continuationsBefore = new Map(
      [...this.continuations].map(([scope, continuation]) => [
        scope,
        { ...continuation },
      ]),
    );
    try {
      const result = mutation();
      this.persist();
      return result;
    } catch (error) {
      this.records.clear();
      for (const [key, record] of recordsBefore) this.records.set(key, record);
      this.seenKeys.clear();
      this.seenKeyOrder.length = 0;
      for (const key of seenBefore) this.rememberKey(key);
      this.watermarks.clear();
      for (const entry of watermarksBefore) this.watermarks.set(...entry);
      this.threads.clear();
      for (const entry of threadsBefore) this.threads.set(...entry);
      this.channels.clear();
      for (const entry of channelsBefore) this.channels.set(...entry);
      this.continuations.clear();
      for (const entry of continuationsBefore) this.continuations.set(...entry);
      throw error;
    }
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    let parsed: PersistedStore;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8")) as PersistedStore;
    } catch (error) {
      throw new Error(
        `Slack inbox store is unreadable or corrupt at ${this.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (parsed?.version !== STORE_VERSION) {
      throw new Error(
        `Slack inbox store at ${this.path} has unsupported version ${String(parsed?.version)}.`,
      );
    }
    for (const key of parsed.seenKeys ?? []) {
      if (typeof key === "string") this.rememberKey(key);
    }
    for (const record of parsed.records ?? []) {
      if (typeof record?.key === "string") this.records.set(record.key, record);
    }
    for (const [scope, timestamp] of Object.entries(parsed.watermarks ?? {})) {
      if (typeof timestamp === "string") this.watermarks.set(scope, timestamp);
    }
    for (const [channelId, channelType] of Object.entries(
      parsed.channels ?? {},
    )) {
      if (
        channelType === "channel" ||
        channelType === "group" ||
        channelType === "im" ||
        channelType === "mpim"
      ) {
        this.channels.set(channelId, channelType);
      }
    }
    for (const [scope, continuation] of Object.entries(
      parsed.continuations ?? {},
    )) {
      if (
        typeof continuation?.floor === "string" &&
        typeof continuation.cutoff === "string" &&
        typeof continuation.latest === "string"
      ) {
        this.continuations.set(scope, continuation);
      }
    }
    for (const thread of parsed.trackedThreads ?? []) {
      if (
        typeof thread?.channelId === "string" &&
        typeof thread.threadTimestamp === "string" &&
        typeof thread.latestTimestamp === "string"
      ) {
        this.threads.set(
          inboxKey(thread.channelId, thread.threadTimestamp),
          thread,
        );
      }
    }
  }

  private persist(): void {
    const payload: PersistedStore = {
      version: STORE_VERSION,
      records: [...this.records.values()],
      seenKeys: [...this.seenKeyOrder],
      watermarks: Object.fromEntries(this.watermarks),
      trackedThreads: [...this.threads.values()],
      channels: Object.fromEntries(this.channels),
      continuations: Object.fromEntries(this.continuations),
    };
    const temporaryPath = `${this.path}.tmp`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(temporaryPath, JSON.stringify(payload), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, this.path);
  }
}

function boundedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 10;
  return Math.min(100, Math.max(0, Math.trunc(limit)));
}

function toMessage(record: SlackInboxRecord): SlackInboxMessage {
  const {
    key: _key,
    unread: _unread,
    deliveryCount: _deliveryCount,
    leaseExpiresAt: _leaseExpiresAt,
    ...message
  } = record;
  return message;
}
