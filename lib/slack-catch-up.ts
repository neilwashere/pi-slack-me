import type {
  OrdinarySlackMessage,
  SlackConversationType,
} from "./slack-events";
import {
  channelWatermarkKey,
  type SlackInboxStore,
} from "./slack-inbox-store";
import { slackGetWithRetry } from "./slack-retry";
import type { SlackTransport } from "./slack-transport";

const DEFAULT_LOOKBACK_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_PAGES_PER_SCOPE = 5;
const DEFAULT_MAX_MESSAGES = 200;
const PAGE_SIZE = 100;

interface AuthTestResponse {
  user?: string;
  user_id?: string;
}

interface UserInfoResponse {
  user?: { name?: string };
}

interface SelfIdentity {
  userId: string;
  handle: string;
}

interface HistoryMessage {
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
}

interface HistoryResponse {
  messages?: HistoryMessage[];
  response_metadata?: { next_cursor?: string };
}

interface SearchMatch extends HistoryMessage {
  channel?: {
    id?: string;
    is_channel?: boolean;
    is_group?: boolean;
    is_im?: boolean;
    is_mpim?: boolean;
  };
}

interface SearchResponse {
  messages?: {
    matches?: SearchMatch[];
    paging?: { page?: number; pages?: number; total?: number };
  };
}

interface ConversationListResponse {
  channels?: Array<{
    id?: string;
    is_im?: boolean;
    is_mpim?: boolean;
  }>;
  response_metadata?: { next_cursor?: string };
}

export interface SlackCatchUpResult {
  added: number;
  scanned: number;
  scopes: number;
  truncated: boolean;
  errors: string[];
  startedAt: string;
  completedAt: string;
}

export interface SlackCatchUpOptions {
  transport: SlackTransport;
  store: SlackInboxStore;
  watchedChannels: Iterable<string>;
  ingest(message: OrdinarySlackMessage): Promise<boolean>;
  now?: () => number;
  lookbackMs?: number;
  maxPagesPerScope?: number;
  maxMessages?: number;
  isAvailable?: () => boolean;
}

interface MutableCatchUpResult {
  added: number;
  scanned: number;
  scopes: number;
  truncated: boolean;
  errors: string[];
}

/** Reconciles Socket Mode gaps through bounded Web API history reads. */
export class SlackCatchUp {
  private readonly now: () => number;
  private readonly watchedChannels: Set<string>;
  private active?: Promise<SlackCatchUpResult>;
  private selfUserId?: string;

  constructor(private readonly options: SlackCatchUpOptions) {
    this.now = options.now ?? Date.now;
    this.watchedChannels = new Set(options.watchedChannels);
  }

  run(): Promise<SlackCatchUpResult> {
    if (this.active) return this.active;
    const active = this.perform().finally(() => {
      if (this.active === active) this.active = undefined;
    });
    this.active = active;
    return active;
  }

  private async perform(): Promise<SlackCatchUpResult> {
    this.assertAvailable();
    const startedAtMs = this.now();
    const cutoff = slackTimestamp(startedAtMs);
    const floor = slackTimestamp(
      startedAtMs - (this.options.lookbackMs ?? DEFAULT_LOOKBACK_MS),
    );
    const result: MutableCatchUpResult = {
      added: 0,
      scanned: 0,
      scopes: 0,
      truncated: false,
      errors: [],
    };
    const trackedThreads = this.options.store.trackedThreads();
    let selfIdentity: SelfIdentity | undefined;
    await this.captureScope(result, "current user", async () => {
      selfIdentity = await this.resolveSelfIdentity();
    });

    const channels = new Map<
      string,
      { channelType?: SlackConversationType; timestamp?: string }
    >();
    for (const channel of this.options.store.knownChannels()) {
      channels.set(channel.channelId, {
        channelType: channel.channelType,
        timestamp: channel.timestamp,
      });
    }
    for (const channelId of this.watchedChannels) {
      if (!channels.has(channelId)) channels.set(channelId, {});
    }
    await this.captureScope(result, "direct conversations", () =>
      this.discoverDirectConversations(result, channels),
    );
    await this.catchUpChannels(
      result,
      [...channels].filter(([channelId, channel]) =>
        isDirectConversation(channel.channelType, channelId),
      ),
      floor,
      cutoff,
      Math.max(1, Math.floor(this.maxMessages() / 2)),
    );

    if (this.messageLimitReached(result)) {
      result.truncated = true;
    } else if (selfIdentity) {
      await this.captureScope(result, "workspace mentions", () =>
        this.catchUpMentions(result, floor, cutoff, selfIdentity as SelfIdentity),
      );
    }

    for (const channel of this.options.store.knownChannels()) {
      if (!channels.has(channel.channelId)) {
        channels.set(channel.channelId, {
          channelType: channel.channelType,
          timestamp: channel.timestamp,
        });
      }
    }
    await this.catchUpChannels(
      result,
      [...channels].filter(
        ([channelId, channel]) =>
          !isDirectConversation(channel.channelType, channelId),
      ),
      floor,
      cutoff,
    );

    for (const thread of trackedThreads) {
      if (this.messageLimitReached(result)) {
        result.truncated = true;
        break;
      }
      await this.captureScope(
        result,
        `thread ${thread.channelId}:${thread.threadTimestamp}`,
        () =>
          this.catchUpThread(
            result,
            thread.channelId,
            thread.threadTimestamp,
            maxTimestamp(thread.latestTimestamp, floor),
            cutoff,
          ),
      );
    }

    return {
      ...result,
      startedAt: slackTimestamp(startedAtMs),
      completedAt: slackTimestamp(this.now()),
    };
  }

  private async captureScope(
    result: MutableCatchUpResult,
    label: string,
    work: () => Promise<void>,
  ): Promise<void> {
    result.scopes += 1;
    try {
      await work();
    } catch (error) {
      result.errors.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async resolveSelfIdentity(): Promise<SelfIdentity> {
    this.assertAvailable();
    const auth = await slackGetWithRetry<AuthTestResponse>(
      this.options.transport,
      "auth.test",
      {},
    );
    if (!auth.user_id) throw new Error("Slack auth.test did not return user_id.");
    this.selfUserId = auth.user_id;
    let handle = auth.user;
    if (!handle) {
      const info = await slackGetWithRetry<UserInfoResponse>(
        this.options.transport,
        "users.info",
        { user: auth.user_id },
      );
      handle = info.user?.name;
    }
    if (!handle) throw new Error("Slack did not return the current user handle.");
    return { userId: auth.user_id, handle };
  }

  private async catchUpMentions(
    result: MutableCatchUpResult,
    lookbackFloor: string,
    cutoff: string,
    identity: SelfIdentity,
  ): Promise<void> {
    this.assertAvailable();
    const floor = maxTimestamp(
      this.options.store.watermark("mentions"),
      lookbackFloor,
    );
    const afterDate = searchAfterDate(floor);
    let page = 1;
    let lastProcessed = floor;
    let complete = true;
    const maxPages =
      this.options.maxPagesPerScope === undefined ? 20 : this.maxPages();
    while (page <= maxPages) {
      this.assertAvailable();
      const response = await slackGetWithRetry<SearchResponse>(
        this.options.transport,
        "search.messages",
        {
          query: `@${identity.handle} after:${afterDate}`,
          sort: "timestamp",
          sort_dir: "asc",
          count: PAGE_SIZE,
          page,
        },
      );
      const matches = [...(response.messages?.matches ?? [])].sort(compareTs);
      for (const match of matches) {
        if (!match.ts || match.ts <= floor || match.ts > cutoff) continue;
        const channelId = match.channel?.id;
        const message = ordinaryMessage(
          channelId,
          conversationTypeFromSearch(match),
          match,
        );
        if (!message || !message.text.includes(`<@${identity.userId}>`)) {
          continue;
        }
        if (!this.reserveMessage(result)) {
          complete = false;
          break;
        }
        if (await this.options.ingest(message)) result.added += 1;
        this.assertAvailable();
        this.rememberRecoveredThread(message);
        lastProcessed = maxTimestamp(lastProcessed, message.ts);
      }
      if (!complete) break;
      const paging = response.messages?.paging;
      const pages = paging?.pages ?? page;
      if (page >= pages) break;
      if (page === maxPages) {
        complete = false;
        result.truncated = true;
        break;
      }
      page += 1;
    }
    this.assertAvailable();
    this.options.store.advanceWatermark(
      "mentions",
      complete ? cutoff : lastProcessed,
    );
  }

  private async catchUpChannels(
    result: MutableCatchUpResult,
    channels: Array<
      [
        string,
        { channelType?: SlackConversationType; timestamp?: string },
      ]
    >,
    floor: string,
    cutoff: string,
    scanCeiling = this.maxMessages(),
  ): Promise<void> {
    for (const [channelId, known] of channels) {
      if (this.messageLimitReached(result, scanCeiling)) {
        result.truncated = true;
        break;
      }
      await this.captureScope(result, `conversation ${channelId}`, () =>
        this.catchUpChannel(
          result,
          channelId,
          known.channelType ?? inferConversationType(channelId),
          maxTimestamp(known.timestamp, floor),
          cutoff,
          scanCeiling,
        ),
      );
    }
  }

  private async discoverDirectConversations(
    result: MutableCatchUpResult,
    channels: Map<
      string,
      { channelType?: SlackConversationType; timestamp?: string }
    >,
  ): Promise<void> {
    let cursor: string | undefined;
    let pages = 0;
    const discovered: Array<{
      channelId: string;
      channelType: "im" | "mpim";
    }> = [];
    do {
      this.assertAvailable();
      const response = await slackGetWithRetry<ConversationListResponse>(
        this.options.transport,
        "users.conversations",
        { types: "im,mpim", limit: PAGE_SIZE, cursor },
      );
      pages += 1;
      for (const channel of response.channels ?? []) {
        if (!channel.id) continue;
        const channelType = channel.is_mpim ? "mpim" : "im";
        channels.set(channel.id, {
          channelType,
          timestamp: this.options.store.watermark(
            channelWatermarkKey(channel.id),
          ),
        });
        discovered.push({ channelId: channel.id, channelType });
      }
      cursor = response.response_metadata?.next_cursor || undefined;
      if (cursor && pages >= this.maxPages()) {
        result.truncated = true;
        break;
      }
    } while (cursor);
    this.assertAvailable();
    this.options.store.rememberChannels(discovered);
  }

  private async catchUpChannel(
    result: MutableCatchUpResult,
    channelId: string,
    channelType: SlackConversationType,
    initialFloor: string,
    initialCutoff: string,
    scanCeiling = this.maxMessages(),
  ): Promise<void> {
    const scope = channelWatermarkKey(channelId);
    const continuation = this.options.store.recoveryContinuation(scope);
    const floor = continuation?.floor ?? initialFloor;
    const cutoff = continuation?.cutoff ?? initialCutoff;
    let latest = continuation?.latest ?? cutoff;
    let cursor: string | undefined;
    let pages = 0;
    let complete = true;
    do {
      this.assertAvailable();
      const response = await slackGetWithRetry<HistoryResponse>(
        this.options.transport,
        "conversations.history",
        {
          channel: channelId,
          oldest: floor,
          latest,
          inclusive: "false",
          limit: PAGE_SIZE,
          cursor,
        },
      );
      pages += 1;
      for (const raw of response.messages ?? []) {
        if (!raw.ts || raw.ts <= floor || raw.ts > cutoff) continue;
        const message = ordinaryMessage(channelId, channelType, raw);
        if (!message) {
          if (raw.ts < latest) latest = raw.ts;
          continue;
        }
        if (!this.reserveMessage(result, scanCeiling)) {
          complete = false;
          break;
        }
        if (await this.options.ingest(message)) result.added += 1;
        this.assertAvailable();
        this.rememberRecoveredThread(message);
        if (raw.ts < latest) latest = raw.ts;
      }
      if (!complete) break;
      cursor = response.response_metadata?.next_cursor || undefined;
      if (cursor && pages >= this.maxPages()) {
        complete = false;
        result.truncated = true;
        break;
      }
    } while (cursor);
    this.assertAvailable();
    if (complete) {
      this.options.store.completeRecoveryScope(scope, cutoff);
    } else {
      this.options.store.saveRecoveryContinuation(scope, {
        floor,
        cutoff,
        latest,
      });
    }
  }

  private async catchUpThread(
    result: MutableCatchUpResult,
    channelId: string,
    threadTimestamp: string,
    floor: string,
    cutoff: string,
  ): Promise<void> {
    let cursor: string | undefined;
    let pages = 0;
    let lastProcessed = floor;
    let complete = true;
    do {
      this.assertAvailable();
      const response = await slackGetWithRetry<HistoryResponse>(
        this.options.transport,
        "conversations.replies",
        {
          channel: channelId,
          ts: threadTimestamp,
          oldest: floor,
          latest: cutoff,
          inclusive: "false",
          limit: PAGE_SIZE,
          cursor,
        },
      );
      pages += 1;
      const messages = [...(response.messages ?? [])].sort(compareTs);
      for (const raw of messages) {
        if (
          !raw.ts ||
          raw.ts === threadTimestamp ||
          raw.ts <= floor ||
          raw.ts > cutoff
        ) {
          continue;
        }
        const message = ordinaryMessage(
          channelId,
          inferConversationType(channelId),
          { ...raw, thread_ts: threadTimestamp },
        );
        if (!message) {
          lastProcessed = maxTimestamp(lastProcessed, raw.ts);
          continue;
        }
        if (!this.reserveMessage(result)) {
          complete = false;
          break;
        }
        if (await this.options.ingest(message)) result.added += 1;
        this.assertAvailable();
        lastProcessed = maxTimestamp(lastProcessed, raw.ts);
      }
      if (!complete) break;
      cursor = response.response_metadata?.next_cursor || undefined;
      if (cursor && pages >= this.maxPages()) {
        complete = false;
        result.truncated = true;
        break;
      }
    } while (cursor);
    this.assertAvailable();
    if (complete) {
      this.options.store.trackThread(channelId, threadTimestamp, cutoff);
    } else if (lastProcessed > floor) {
      this.options.store.trackThread(
        channelId,
        threadTimestamp,
        lastProcessed,
      );
    }
  }

  private assertAvailable(): void {
    if (this.options.isAvailable?.() === false) {
      throw new Error("Slack catch-up stopped because the listener is unavailable.");
    }
  }

  private rememberRecoveredThread(message: OrdinarySlackMessage): void {
    const wasAuthoredBySelf = message.user === this.selfUserId;
    const mentionsSelf =
      this.selfUserId !== undefined &&
      message.text.includes(`<@${this.selfUserId}>`);
    if (!message.thread_ts && !wasAuthoredBySelf && !mentionsSelf) return;
    this.options.store.trackThread(
      message.channel,
      message.thread_ts ?? message.ts,
      message.ts,
      message.channel_type,
    );
  }

  private reserveMessage(
    result: MutableCatchUpResult,
    scanCeiling = this.maxMessages(),
  ): boolean {
    if (this.messageLimitReached(result, scanCeiling)) {
      result.truncated = true;
      return false;
    }
    result.scanned += 1;
    return true;
  }

  private messageLimitReached(
    result: MutableCatchUpResult,
    scanCeiling = this.maxMessages(),
  ): boolean {
    return result.scanned >= scanCeiling;
  }

  private maxMessages(): number {
    return Math.max(1, this.options.maxMessages ?? DEFAULT_MAX_MESSAGES);
  }

  private maxPages(): number {
    return Math.max(
      1,
      this.options.maxPagesPerScope ?? DEFAULT_MAX_PAGES_PER_SCOPE,
    );
  }
}

function ordinaryMessage(
  channelId: string | undefined,
  channelType: SlackConversationType,
  raw: HistoryMessage,
): OrdinarySlackMessage | undefined {
  if (!channelId || !raw.user || !raw.text || !raw.ts || raw.bot_id) {
    return undefined;
  }
  if (raw.subtype && raw.subtype !== "thread_broadcast") return undefined;
  return {
    type: "message",
    channel: channelId,
    channel_type: channelType,
    user: raw.user,
    text: raw.text,
    ts: raw.ts,
    thread_ts: raw.thread_ts,
  };
}

function conversationTypeFromSearch(match: SearchMatch): SlackConversationType {
  if (match.channel?.is_im) return "im";
  if (match.channel?.is_mpim) return "mpim";
  if (match.channel?.is_group) return "group";
  return "channel";
}

function isDirectConversation(
  channelType: SlackConversationType | undefined,
  channelId: string,
): boolean {
  const inferred = channelType ?? inferConversationType(channelId);
  return inferred === "im" || inferred === "mpim";
}

function inferConversationType(channelId: string): SlackConversationType {
  if (channelId.startsWith("D")) return "im";
  if (channelId.startsWith("G")) return "group";
  return "channel";
}

function compareTs(left: HistoryMessage, right: HistoryMessage): number {
  return (left.ts ?? "").localeCompare(right.ts ?? "");
}

function maxTimestamp(
  left: string | undefined,
  right: string,
): string {
  return left !== undefined && left > right ? left : right;
}

function slackTimestamp(epochMs: number): string {
  return (epochMs / 1_000).toFixed(6);
}

function searchAfterDate(timestamp: string): string {
  const twoDaysBefore = Number.parseFloat(timestamp) * 1_000 - 48 * 60 * 60_000;
  return new Date(twoDaysBefore).toISOString().slice(0, 10);
}
