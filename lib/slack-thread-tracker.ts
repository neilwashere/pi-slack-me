import type { SlackThreadTracker } from "./slack-events";
import { slackGetWithRetry } from "./slack-retry";
import type { SlackTransport } from "./slack-transport";

const MAX_CACHED_THREADS = 1_000;

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

  private getRepliesPage(
    query: Record<string, string | number | undefined>,
  ): Promise<ThreadRepliesResponse> {
    return slackGetWithRetry(
      this.transport,
      "conversations.replies",
      query,
    );
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
