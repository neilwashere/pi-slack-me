import { SlackApiError } from "./api";
import type { SlackThreadTracker } from "./slack-events";
import type { SlackTransport } from "./slack-transport";

const MAX_CACHED_THREADS = 1_000;
const MAX_PAGE_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

interface ThreadRepliesResponse {
  ok: boolean;
  messages?: Array<{ user?: string; text?: string }>;
  response_metadata?: { next_cursor?: string };
}

class CachedSlackThreadTracker implements SlackThreadTracker {
  private readonly markedThreads = new Set<string>();
  private readonly cache = new Map<string, boolean>();
  private readonly pending = new Map<string, Promise<boolean>>();

  constructor(private readonly transport: SlackTransport) {}

  mark(channel: string, threadTimestamp: string): void {
    this.markedThreads.add(this.threadKey(channel, threadTimestamp));
    this.trim(this.markedThreads);
  }

  participates(
    channel: string,
    threadTimestamp: string,
    selfUserId: string,
  ): Promise<boolean> {
    if (this.markedThreads.has(this.threadKey(channel, threadTimestamp))) {
      return Promise.resolve(true);
    }
    const key = `${selfUserId}:${this.threadKey(channel, threadTimestamp)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const lookup = this.lookup(channel, threadTimestamp, selfUserId)
      .then((participates) => {
        this.cache.set(key, participates);
        this.trim(this.cache);
        return participates;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, lookup);
    return lookup;
  }

  private async lookup(
    channel: string,
    threadTimestamp: string,
    selfUserId: string,
  ): Promise<boolean> {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    while (true) {
      const query: Record<string, string | number | undefined> = {
        channel,
        ts: threadTimestamp,
        limit: 200,
      };
      if (cursor) query.cursor = cursor;
      const response = await this.getRepliesPage(query);
      if (
        response.messages?.some(
          (message) =>
            message.user === selfUserId ||
            message.text?.includes(`<@${selfUserId}>`) === true,
        )
      ) {
        return true;
      }
      const nextCursor = response.response_metadata?.next_cursor || undefined;
      if (!nextCursor || seenCursors.has(nextCursor)) return false;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  private async getRepliesPage(
    query: Record<string, string | number | undefined>,
  ): Promise<ThreadRepliesResponse> {
    for (let attempt = 0; attempt < MAX_PAGE_ATTEMPTS; attempt += 1) {
      try {
        return await this.transport.get<ThreadRepliesResponse>(
          "conversations.replies",
          { query },
        );
      } catch (error) {
        const retryable =
          error instanceof SlackApiError &&
          (error.isRateLimited || error.status >= 500);
        if (!retryable || attempt === MAX_PAGE_ATTEMPTS - 1) throw error;
        const retryDelay = Math.min(
          Math.max(0, error.retryAfter ?? DEFAULT_RETRY_DELAY_MS / 1_000) *
            1_000,
          MAX_RETRY_DELAY_MS,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelay));
      }
    }
    throw new Error("Slack thread history retry limit was exhausted.");
  }

  private threadKey(channel: string, threadTimestamp: string): string {
    return `${channel}:${threadTimestamp}`;
  }

  private trim(cache: Map<string, unknown> | Set<string>): void {
    while (cache.size > MAX_CACHED_THREADS) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) return;
      cache.delete(oldest);
    }
  }
}

export function createSlackThreadTracker(
  transport: SlackTransport,
): SlackThreadTracker {
  return new CachedSlackThreadTracker(transport);
}
