import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackApiError } from "../lib/api";
import {
  SlackCatchUp,
  type SlackCatchUpOptions,
} from "../lib/slack-catch-up";
import type { OrdinarySlackMessage } from "../lib/slack-events";
import {
  channelWatermarkKey,
  SlackInboxStore,
} from "../lib/slack-inbox-store";
import type { SlackTransport } from "../lib/slack-transport";

const NOW_MS = Date.UTC(2026, 8, 2, 12, 0, 0);
const OLD_TS = "1788340000.000000";
const NEW_TS = "1788345000.000000";

let directory: string;
let store: SlackInboxStore;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-slack-catch-up-"));
  store = new SlackInboxStore({ path: join(directory, "inbox.json") });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function transport(
  get: SlackTransport["get"],
  discoverDirectMessages = false,
): SlackTransport {
  return {
    get: async (method, options) => {
      if (method === "users.conversations" && !discoverDirectMessages) {
        return { channels: [], response_metadata: {} } as never;
      }
      return get(method, options);
    },
    post: vi.fn(),
    download: vi.fn(),
  };
}

function emptySearch() {
  return { messages: { matches: [], paging: { page: 1, pages: 1 } } };
}

function catchUp(
  get: SlackTransport["get"],
  ingest: SlackCatchUpOptions["ingest"] = vi.fn(async () => true),
  watchedChannels: string[] = [],
  maxPagesPerScope?: number,
): { catchUp: SlackCatchUp; ingest: SlackCatchUpOptions["ingest"] } {
  return {
    catchUp: new SlackCatchUp({
      transport: transport(get),
      store,
      watchedChannels,
      ingest,
      now: () => NOW_MS,
      maxPagesPerScope,
    }),
    ingest,
  };
}

describe("SlackCatchUp", () => {
  it("recovers an exact self mention through search.messages", async () => {
    const get = vi.fn(async (method: string) => {
      if (method === "auth.test") return { user: "neil", user_id: "USELF" };
      if (
        method === "conversations.history" ||
        method === "conversations.replies"
      ) {
        return { messages: [], response_metadata: {} };
      }
      if (method === "search.messages") {
        return {
          messages: {
            matches: [
              {
                channel: { id: "C1", is_channel: true },
                user: "USAM",
                text: "please check this <@USELF>",
                ts: NEW_TS,
              },
              {
                channel: { id: "C1", is_channel: true },
                user: "USAM",
                text: "someone mentioned another person",
                ts: "1788345001.000000",
              },
            ],
            paging: { page: 1, pages: 1 },
          },
        };
      }
      throw new Error(`Unexpected method ${method}`);
    }) as SlackTransport["get"];
    const { catchUp: runner, ingest } = catchUp(get);

    const result = await runner.run();

    expect(result).toMatchObject({
      added: 1,
      scanned: 1,
      truncated: false,
      errors: [],
    });
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C1",
        channel_type: "channel",
        user: "USAM",
        ts: NEW_TS,
      }),
    );
    expect(store.watermark("mentions")).toBe(result.startedAt);
  });

  it("searches far enough back to recover same-day mentions", async () => {
    let now = NOW_MS;
    const queries: string[] = [];
    const get = vi.fn(
      async (
        method: string,
        options?: { query?: Record<string, string | number | undefined> },
      ) => {
        if (method === "auth.test") {
          return { user: "neil", user_id: "USELF" };
        }
        if (method === "search.messages") {
          queries.push(String(options?.query?.query));
          return emptySearch();
        }
        throw new Error(`Unexpected method ${method}`);
      },
    ) as SlackTransport["get"];
    const runner = new SlackCatchUp({
      transport: transport(get),
      store,
      watchedChannels: [],
      ingest: vi.fn(async () => true),
      now: () => now,
    });

    await runner.run();
    now += 60_000;
    await runner.run();

    expect(queries).toEqual([
      "@neil after:2026-08-30",
      "@neil after:2026-08-31",
    ]);
  });

  it("discovers and recovers a DM first opened while offline", async () => {
    const get = vi.fn(async (method: string) => {
      if (method === "auth.test") return { user: "neil", user_id: "USELF" };
      if (method === "search.messages") return emptySearch();
      if (method === "users.conversations") {
        return {
          channels: [{ id: "DNEW", is_im: true }],
          response_metadata: {},
        };
      }
      if (method === "conversations.history") {
        return {
          messages: [
            { user: "USAM", text: "<@USELF> new issue", ts: NEW_TS },
          ],
          response_metadata: {},
        };
      }
      throw new Error(`Unexpected method ${method}`);
    }) as SlackTransport["get"];
    const ingest = vi.fn(async () => true);
    const runner = new SlackCatchUp({
      transport: transport(get, true),
      store,
      watchedChannels: [],
      ingest,
      now: () => NOW_MS,
    });

    const result = await runner.run();

    expect(result.errors).toEqual([]);
    expect(result.added).toBe(1);
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "DNEW",
        channel_type: "im",
        text: "<@USELF> new issue",
      }),
    );
    expect(store.knownChannels()).toEqual([
      expect.objectContaining({ channelId: "DNEW", channelType: "im" }),
    ]);
    expect(store.trackedThreads()).toEqual([
      expect.objectContaining({ channelId: "DNEW", threadTimestamp: NEW_TS }),
    ]);
  });

  it("prioritizes newly discovered DMs ahead of bulk channel history", async () => {
    store.rememberChannels([{ channelId: "CBUSY", channelType: "channel" }]);
    const requestedChannels: string[] = [];
    const get = vi.fn(
      async (
        method: string,
        options?: { query?: Record<string, string | number | undefined> },
      ) => {
        if (method === "auth.test") {
          return { user: "neil", user_id: "USELF" };
        }
        if (method === "search.messages") {
          return {
            messages: {
              matches: [
                {
                  channel: { id: "CMENTION", is_channel: true },
                  user: "USAM",
                  text: "<@USELF> second issue",
                  ts: NEW_TS,
                },
              ],
              paging: { page: 1, pages: 1 },
            },
          };
        }
        if (method === "users.conversations") {
          return {
            channels: [{ id: "DNEW", is_im: true }],
            response_metadata: {},
          };
        }
        if (method === "conversations.history") {
          const channel = String(options?.query?.channel);
          requestedChannels.push(channel);
          return {
            messages: [{ user: "USAM", text: "issue", ts: NEW_TS }],
            response_metadata: {},
          };
        }
        throw new Error(`Unexpected method ${method}`);
      },
    ) as SlackTransport["get"];
    const runner = new SlackCatchUp({
      transport: transport(get, true),
      store,
      watchedChannels: [],
      ingest: vi.fn(async () => true),
      maxMessages: 2,
      now: () => NOW_MS,
    });

    const result = await runner.run();

    expect(result).toMatchObject({ added: 2, truncated: true });
    expect(requestedChannels).toEqual(["DNEW"]);
    expect(store.trackedThreads()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ channelId: "DNEW" })]),
    );
    expect(get).toHaveBeenCalledWith(
      "search.messages",
      expect.objectContaining({ query: expect.objectContaining({}) }),
    );
  });

  it("continues known-conversation recovery when search scope is missing", async () => {
    store.advanceWatermark(channelWatermarkKey("D1"), OLD_TS);
    const get = vi.fn(async (method: string) => {
      if (method === "auth.test") return { user: "neil", user_id: "USELF" };
      if (method === "search.messages") {
        throw new SlackApiError("missing search:read", 200, "missing_scope");
      }
      if (method === "conversations.history") {
        return {
          messages: [
            { user: "USAM", text: "can you look?", ts: NEW_TS },
          ],
          response_metadata: {},
        };
      }
      throw new Error(`Unexpected method ${method}`);
    }) as SlackTransport["get"];
    const { catchUp: runner, ingest } = catchUp(get);

    const result = await runner.run();

    expect(result.added).toBe(1);
    expect(result.errors).toEqual([
      expect.stringContaining("workspace mentions: missing search:read"),
    ]);
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "D1", channel_type: "im" }),
    );
    expect(store.watermark(channelWatermarkKey("D1"))).toBe(result.startedAt);
  });

  it("recovers replies in a persistently tracked thread", async () => {
    store.trackThread("C1", "1788339000.000000", OLD_TS, "channel");
    const get = vi.fn(async (method: string) => {
      if (method === "auth.test") return { user: "neil", user_id: "USELF" };
      if (method === "search.messages") return emptySearch();
      if (method === "conversations.history") {
        return { messages: [], response_metadata: {} };
      }
      if (method === "conversations.replies") {
        return {
          messages: [
            {
              user: "USAM",
              text: "any update?",
              ts: NEW_TS,
              thread_ts: "1788339000.000000",
            },
          ],
          response_metadata: {},
        };
      }
      throw new Error(`Unexpected method ${method}`);
    }) as SlackTransport["get"];
    const { catchUp: runner, ingest } = catchUp(get);

    const result = await runner.run();

    expect(result.added).toBe(1);
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C1",
        thread_ts: "1788339000.000000",
        ts: NEW_TS,
      }),
    );
    expect(store.trackedThreads()[0]?.latestTimestamp).toBe(result.startedAt);
  });

  it("persists a newest-first continuation and reaches older pages on the next pass", async () => {
    store.advanceWatermark(channelWatermarkKey("C1"), OLD_TS);
    const requestedLatest: string[] = [];
    const get = vi.fn(
      async (
        method: string,
        options?: { query?: Record<string, string | number | undefined> },
      ) => {
        if (method === "auth.test") {
          return { user: "neil", user_id: "USELF" };
        }
        if (method === "search.messages") return emptySearch();
        if (method === "conversations.history") {
          const latest = String(options?.query?.latest);
          requestedLatest.push(latest);
          if (latest === NEW_TS) {
            return {
              messages: [
                { user: "USAM", text: "oldest", ts: "1788341000.000000" },
              ],
              response_metadata: {},
            };
          }
          return {
            messages: [
              { user: "USAM", text: "newest", ts: "1788346000.000000" },
              { user: "USAM", text: "middle", ts: NEW_TS },
            ],
            response_metadata: { next_cursor: "older" },
          };
        }
        throw new Error(`Unexpected method ${method}`);
      },
    ) as SlackTransport["get"];
    const { catchUp: runner } = catchUp(
      get,
      vi.fn(async () => true),
      [],
      1,
    );

    const first = await runner.run();
    const continuation = store.recoveryContinuation(
      channelWatermarkKey("C1"),
    );
    const second = await runner.run();

    expect(first.truncated).toBe(true);
    expect(continuation).toEqual({
      floor: OLD_TS,
      cutoff: first.startedAt,
      latest: NEW_TS,
    });
    expect(second.truncated).toBe(false);
    expect(requestedLatest).toEqual([first.startedAt, NEW_TS]);
    expect(store.recoveryContinuation(channelWatermarkKey("C1"))).toBeUndefined();
    expect(store.watermark(channelWatermarkKey("C1"))).toBe(first.startedAt);
  });

  it("does not advance a newest-first channel checkpoint after a later page fails", async () => {
    store.advanceWatermark(channelWatermarkKey("C1"), OLD_TS);
    let historyPage = 0;
    const get = vi.fn(async (method: string) => {
      if (method === "auth.test") return { user: "neil", user_id: "USELF" };
      if (method === "search.messages") return emptySearch();
      if (method === "conversations.history") {
        historyPage += 1;
        if (historyPage === 1) {
          return {
            messages: [{ user: "USAM", text: "newest", ts: NEW_TS }],
            response_metadata: { next_cursor: "older" },
          };
        }
        throw new Error("history page failed");
      }
      throw new Error(`Unexpected method ${method}`);
    }) as SlackTransport["get"];
    const { catchUp: runner } = catchUp(
      get,
      vi.fn(async (message: OrdinarySlackMessage) =>
        store.add(
          {
            eventId: `backfill:${message.channel}:${message.ts}`,
            channelId: message.channel,
            channelName: message.channel,
            channelType: message.channel_type,
            userId: message.user,
            userName: message.user,
            text: message.text,
            timestamp: message.ts,
            threadTimestamp: message.thread_ts,
            isMention: false,
          },
          { trackParticipation: false },
        ),
      ),
    );

    const result = await runner.run();

    expect(result.errors).toEqual([
      expect.stringContaining("conversation C1: history page failed"),
    ]);
    expect(store.watermark(channelWatermarkKey("C1"))).toBe(OLD_TS);
    expect(store.counts().pending).toBe(1);
  });

  it("reports truncation and advances only through the last processed item", async () => {
    const get = vi.fn(async (method: string, options?: { query?: object }) => {
      if (method === "auth.test") return { user: "neil", user_id: "USELF" };
      if (method === "search.messages") {
        return {
          messages: {
            matches: [
              {
                channel: { id: "C1", is_channel: true },
                user: "USAM",
                text: "<@USELF> look",
                ts: NEW_TS,
              },
            ],
            paging: { page: 1, pages: 2 },
          },
        };
      }
      throw new Error(
        `Unexpected method ${method} ${JSON.stringify(options?.query)}`,
      );
    }) as SlackTransport["get"];
    const { catchUp: runner } = catchUp(get, vi.fn(async () => true), [], 1);

    const result = await runner.run();

    expect(result.truncated).toBe(true);
    expect(store.watermark("mentions")).toBe(NEW_TS);
  });

  it("does not checkpoint messages when the listener stops mid-pass", async () => {
    let available = true;
    const get = vi.fn(async (method: string) => {
      if (method === "auth.test") return { user: "neil", user_id: "USELF" };
      if (method === "search.messages") {
        available = false;
        return {
          messages: {
            matches: [
              {
                channel: { id: "C1", is_channel: true },
                user: "USAM",
                text: "<@USELF> look",
                ts: NEW_TS,
              },
            ],
            paging: { page: 1, pages: 1 },
          },
        };
      }
      throw new Error(`Unexpected method ${method}`);
    }) as SlackTransport["get"];
    const runner = new SlackCatchUp({
      transport: transport(get),
      store,
      watchedChannels: [],
      ingest: vi.fn(async () => false),
      isAvailable: () => available,
      now: () => NOW_MS,
    });

    const result = await runner.run();

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("listener is unavailable"),
      ]),
    );
    expect(store.watermark("mentions")).toBeUndefined();
  });

  it("coalesces concurrent requests into one reconciliation", async () => {
    let finishSearch: ((value: ReturnType<typeof emptySearch>) => void) | undefined;
    const get = vi.fn(async (method: string) => {
      if (method === "auth.test") return { user: "neil", user_id: "USELF" };
      if (method === "search.messages") {
        return new Promise<ReturnType<typeof emptySearch>>((resolve) => {
          finishSearch = resolve;
        });
      }
      throw new Error(`Unexpected method ${method}`);
    }) as SlackTransport["get"];
    const { catchUp: runner } = catchUp(get);

    const first = runner.run();
    const second = runner.run();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(finishSearch).toBeDefined());
    finishSearch?.(emptySearch());
    await Promise.all([first, second]);

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("skips bot and subtype history records", async () => {
    store.advanceWatermark(channelWatermarkKey("C1"), OLD_TS);
    const accepted: OrdinarySlackMessage[] = [];
    const get = vi.fn(async (method: string) => {
      if (method === "auth.test") return { user: "neil", user_id: "USELF" };
      if (method === "search.messages") return emptySearch();
      if (method === "conversations.history") {
        return {
          messages: [
            { user: "UBOT", text: "bot", ts: NEW_TS, bot_id: "B1" },
            {
              user: "USAM",
              text: "edited",
              ts: "1788345001.000000",
              subtype: "message_changed",
            },
          ],
          response_metadata: {},
        };
      }
      throw new Error(`Unexpected method ${method}`);
    }) as SlackTransport["get"];
    const { catchUp: runner } = catchUp(
      get,
      vi.fn(async (message: OrdinarySlackMessage) => {
        accepted.push(message);
        return true;
      }),
    );

    const result = await runner.run();

    expect(accepted).toEqual([]);
    expect(result.scanned).toBe(0);
  });
});
