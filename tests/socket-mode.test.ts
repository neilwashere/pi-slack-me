import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackEventListener } from "../lib/slack-events";

const TEST_APP_TOKEN = ["xapp", "secret", "token"].join("-");

interface SocketEvent {
  ack: () => Promise<void>;
  body: {
    event_id: string;
    event: {
      type: "message";
      channel: string;
      channel_type: "channel" | "group" | "im" | "mpim";
      user: string;
      text: string;
      ts: string;
      subtype?: string;
      bot_id?: string;
      thread_ts?: string;
    };
  };
  event: SocketEvent["body"]["event"];
}

class FakeSocketClient {
  readonly start = vi.fn().mockResolvedValue({ ok: true });
  readonly disconnect = vi.fn().mockResolvedValue(undefined);
  private readonly listeners = new Map<
    string,
    Array<(event: unknown) => void>
  >();

  on(event: string, listener: (event: unknown) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

function slackResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubDirectoryFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("auth.test")) {
        return slackResponse({ ok: true, user_id: "USELF" });
      }
      if (url.includes("users.info")) {
        return slackResponse({
          ok: true,
          user: { id: "UOTHER", profile: { display_name: "Alice" } },
        });
      }
      if (url.includes("conversations.info")) {
        return slackResponse({
          ok: true,
          channel: { id: "C123", name: "engineering" },
        });
      }
      throw new Error(`Unexpected Slack request: ${url}`);
    }),
  );
}

function mentionEvent(eventId: string, ts: string): SocketEvent {
  const event: SocketEvent = {
    ack: vi.fn().mockResolvedValue(undefined),
    body: {
      event_id: eventId,
      event: {
        type: "message",
        channel: "C123",
        channel_type: "channel",
        user: "UOTHER",
        text: "Can you review this, <@USELF>?",
        ts,
      },
    },
    event: undefined as never,
  };
  event.event = event.body.event;
  return event;
}

describe("SlackEventListener", () => {
  // Each listener persists its inbox, so without a per-test store path every
  // test inherits the previous one's retained messages and dedupe keys.
  let storeDirectory: string;

  beforeEach(() => {
    vi.resetModules();
    process.env.SLACK_USER_TOKEN = "xoxp-test";
    storeDirectory = mkdtempSync(join(tmpdir(), "pi-slack-inbox-"));
    process.env.PI_SLACK_INBOX_STORE = join(storeDirectory, "inbox.json");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.SLACK_USER_TOKEN;
    delete process.env.PI_SLACK_INBOX_STORE;
    rmSync(storeDirectory, { recursive: true, force: true });
  });

  it("acknowledges a mention and makes it available in the inbox", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        if (url.includes("users.info")) {
          return slackResponse({
            ok: true,
            user: { id: "UOTHER", profile: { display_name: "Alice" } },
          });
        }
        if (url.includes("conversations.info")) {
          return slackResponse({
            ok: true,
            channel: { id: "C123", name: "engineering" },
          });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();

    const ack = vi.fn().mockResolvedValue(undefined);
    const event: SocketEvent = {
      ack,
      body: {
        event_id: "Ev123",
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "UOTHER",
          text: "Can you review this, <@USELF>?",
          ts: "1786020000.000100",
        },
      },
      event: undefined as never,
    };
    event.event = event.body.event;
    socket.emit("message", event);

    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    expect(ack).toHaveBeenCalledOnce();
    expect(listener.readInbox(1)).toEqual([
      expect.objectContaining({
        eventId: "Ev123",
        channelId: "C123",
        channelName: "engineering",
        userId: "UOTHER",
        userName: "Alice",
        text: "Can you review this, <@USELF>?",
        isMention: true,
      }),
    ]);
  });

  it("retains non-mention messages only from explicitly watched channels", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        if (url.includes("users.info")) {
          return slackResponse({
            ok: true,
            user: { id: "UOTHER", profile: { display_name: "Alice" } },
          });
        }
        if (url.includes("conversations.info")) {
          return slackResponse({
            ok: true,
            channel: { id: "CWATCHED", name: "engineering" },
          });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({
      socket,
      watchedChannels: ["CWATCHED"],
    });
    await listener.start();

    const watchedAck = vi.fn().mockResolvedValue(undefined);
    const watched: SocketEvent = {
      ack: watchedAck,
      body: {
        event_id: "EvWatched",
        event: {
          type: "message",
          channel: "CWATCHED",
          channel_type: "channel",
          user: "UOTHER",
          text: "A watched-channel update",
          ts: "1786020000.000200",
        },
      },
      event: undefined as never,
    };
    watched.event = watched.body.event;

    const otherAck = vi.fn().mockResolvedValue(undefined);
    const other: SocketEvent = {
      ack: otherAck,
      body: {
        event_id: "EvOther",
        event: {
          type: "message",
          channel: "COTHER",
          channel_type: "channel",
          user: "UOTHER",
          text: "An unrelated update",
          ts: "1786020000.000300",
        },
      },
      event: undefined as never,
    };
    other.event = other.body.event;

    socket.emit("message", watched);
    socket.emit("message", other);

    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    expect(watchedAck).toHaveBeenCalledOnce();
    expect(otherAck).toHaveBeenCalledOnce();
    expect(listener.readInbox(10)).toEqual([
      expect.objectContaining({
        eventId: "EvWatched",
        channelId: "CWATCHED",
        text: "A watched-channel update",
        isMention: false,
      }),
    ]);
  });

  it("acknowledges but ignores own, bot, and message-subtype events", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("auth.test")) {
        return slackResponse({ ok: true, user_id: "USELF" });
      }
      throw new Error(`Unexpected Slack request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();

    const makeEvent = (
      eventId: string,
      overrides: Partial<SocketEvent["body"]["event"]>,
    ): SocketEvent => {
      const event = {
        type: "message" as const,
        channel: "C123",
        channel_type: "channel" as const,
        user: "UOTHER",
        text: "<@USELF> please run this",
        ts: `1786020000.${eventId}`,
        ...overrides,
      };
      return {
        ack: vi.fn().mockResolvedValue(undefined),
        body: { event_id: eventId, event },
        event,
      };
    };

    const events = [
      makeEvent("000401", { user: "USELF" }),
      makeEvent("000402", { bot_id: "B123" }),
      makeEvent("000403", { subtype: "message_changed" }),
    ];
    for (const event of events) socket.emit("message", event);

    await vi.waitFor(() => {
      for (const event of events) expect(event.ack).toHaveBeenCalledOnce();
    });
    expect(listener.status().unread).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retains user-authored thread broadcasts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        if (url.includes("users.info")) {
          return slackResponse({ ok: true, user: { id: "UOTHER" } });
        }
        if (url.includes("conversations.info")) {
          return slackResponse({
            ok: true,
            channel: { id: "C123", name: "engineering" },
          });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();

    const event: SocketEvent = {
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        event_id: "EvThreadBroadcast",
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "UOTHER",
          text: "<@USELF> this reply was also sent to the channel",
          ts: "1786020000.000450",
          subtype: "thread_broadcast",
        },
      },
      event: undefined as never,
    };
    event.event = event.body.event;
    socket.emit("message", event);

    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    expect(listener.readInbox(1)).toEqual([
      expect.objectContaining({
        eventId: "EvThreadBroadcast",
        isMention: true,
      }),
    ]);
  });

  it("notifies for replies in a thread the user has participated in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        if (url.includes("users.info")) {
          return slackResponse({ ok: true, user: { id: "UOTHER" } });
        }
        if (url.includes("conversations.info")) {
          return slackResponse({
            ok: true,
            channel: { id: "C123", name: "engineering" },
          });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const participating = new Set<string>();
    const threadTracker = {
      mark: vi.fn((channel: string, threadTs: string) => {
        participating.add(`${channel}:${threadTs}`);
      }),
      participates: vi.fn(async (channel: string, threadTs: string) =>
        participating.has(`${channel}:${threadTs}`),
      ),
    };
    const onAttention = vi.fn();
    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({
      socket,
      threadTracker,
      onAttention,
    });
    await listener.start();

    const ownRoot: SocketEvent = {
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        event_id: "EvOwnRoot",
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "USELF",
          text: "I started this thread",
          ts: "1786020000.000460",
        },
      },
      event: undefined as never,
    };
    ownRoot.event = ownRoot.body.event;
    socket.emit("message", ownRoot);
    await vi.waitFor(() =>
      expect(threadTracker.mark).toHaveBeenCalledWith(
        "C123",
        "1786020000.000460",
      ),
    );

    const reply: SocketEvent = {
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        event_id: "EvThreadReply",
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "UOTHER",
          text: "A follow-up without another mention",
          ts: "1786020000.000470",
          thread_ts: "1786020000.000460",
        },
      },
      event: undefined as never,
    };
    reply.event = reply.body.event;
    socket.emit("message", reply);

    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    expect(threadTracker.participates).not.toHaveBeenCalled();
    expect(listener.readInbox(1)).toEqual([
      expect.objectContaining({
        eventId: "EvThreadReply",
        threadTimestamp: "1786020000.000460",
        isMention: false,
        attentionKind: "thread-reply",
      }),
    ]);
    expect(onAttention).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "EvThreadReply" }),
    );
  });

  it("acknowledges Slack retries without duplicating the inbox message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        if (url.includes("users.info")) {
          return slackResponse({
            ok: true,
            user: { id: "UOTHER", profile: { display_name: "Alice" } },
          });
        }
        if (url.includes("conversations.info")) {
          return slackResponse({
            ok: true,
            channel: { id: "C123", name: "engineering" },
          });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();

    const ack = vi.fn().mockResolvedValue(undefined);
    const event: SocketEvent = {
      ack,
      body: {
        event_id: "EvRetry",
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "UOTHER",
          text: "<@USELF> retry-safe message",
          ts: "1786020000.000500",
        },
      },
      event: undefined as never,
    };
    event.event = event.body.event;

    socket.emit("message", event);
    socket.emit("message", event);

    await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    expect(listener.readInbox(10)).toHaveLength(1);
  });

  it("caches concurrent user and channel name lookups", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("auth.test")) {
        return slackResponse({ ok: true, user_id: "USELF" });
      }
      if (url.includes("users.info")) {
        return slackResponse({
          ok: true,
          user: { id: "UOTHER", profile: { display_name: "Alice" } },
        });
      }
      if (url.includes("conversations.info")) {
        return slackResponse({
          ok: true,
          channel: { id: "C123", name: "engineering" },
        });
      }
      throw new Error(`Unexpected Slack request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();

    const makeEvent = (eventId: string): SocketEvent => {
      const event = {
        type: "message" as const,
        channel: "C123",
        channel_type: "channel" as const,
        user: "UOTHER",
        text: `<@USELF> message ${eventId}`,
        ts: `1786020000.${eventId}`,
      };
      return {
        ack: vi.fn().mockResolvedValue(undefined),
        body: { event_id: eventId, event },
        event,
      };
    };

    socket.emit("message", makeEvent("000601"));
    socket.emit("message", makeEvent("000602"));

    await vi.waitFor(() => expect(listener.status().unread).toBe(2));
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.filter((url) => url.includes("users.info"))).toHaveLength(1);
    expect(
      urls.filter((url) => url.includes("conversations.info")),
    ).toHaveLength(1);
  });

  it("drains unread messages across successive bounded reads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        if (url.includes("users.info")) {
          return slackResponse({
            ok: true,
            user: { id: "UOTHER", profile: { display_name: "Alice" } },
          });
        }
        if (url.includes("conversations.info")) {
          return slackResponse({
            ok: true,
            channel: { id: "C123", name: "engineering" },
          });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();

    const makeEvent = (index: number): SocketEvent => {
      const suffix = String(index).padStart(6, "0");
      const event = {
        type: "message" as const,
        channel: "C123",
        channel_type: "channel" as const,
        user: "UOTHER",
        text: `<@USELF> message ${index}`,
        ts: `1786020000.${suffix}`,
      };
      return {
        ack: vi.fn().mockResolvedValue(undefined),
        body: { event_id: `Ev${suffix}`, event },
        event,
      };
    };

    for (let index = 1; index <= 3; index += 1) {
      socket.emit("message", makeEvent(index));
    }

    await vi.waitFor(() => expect(listener.status().unread).toBe(3));
    expect(listener.readInbox(2).map((message) => message.eventId)).toEqual([
      "Ev000001",
      "Ev000002",
    ]);
    expect(listener.status().unread).toBe(1);
    expect(listener.readInbox(2).map((message) => message.eventId)).toEqual([
      "Ev000003",
    ]);
    expect(listener.status().unread).toBe(0);
    expect(listener.readInbox(2)).toEqual([]);
  });

  it("limits a human inbox read to 100 without evicting pending work", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        if (url.includes("users.info")) {
          return slackResponse({
            ok: true,
            user: { id: "UOTHER", profile: { display_name: "Alice" } },
          });
        }
        if (url.includes("conversations.info")) {
          return slackResponse({
            ok: true,
            channel: { id: "C123", name: "engineering" },
          });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();

    const makeEvent = (index: number): SocketEvent => {
      const suffix = String(index).padStart(6, "0");
      const event = {
        type: "message" as const,
        channel: "C123",
        channel_type: "channel" as const,
        user: "UOTHER",
        text: `<@USELF> message ${index}`,
        ts: `1786020000.${suffix}`,
      };
      return {
        ack: vi.fn().mockResolvedValue(undefined),
        body: { event_id: `Ev${suffix}`, event },
        event,
      };
    };

    socket.emit("message", makeEvent(1));
    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    for (let index = 2; index <= 101; index += 1) {
      socket.emit("message", makeEvent(index));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(listener.status().unread).toBe(101);
    const messages = listener.readInbox(100);
    expect(messages).toHaveLength(100);
    expect(messages[0]?.eventId).toBe("Ev000001");
    expect(messages.at(-1)?.eventId).toBe("Ev000100");
    expect(listener.status().unread).toBe(1);
    expect(listener.readInbox(100)[0]?.eventId).toBe("Ev000101");
  });

  it("marks displayed messages read and clears retained messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        if (url.includes("users.info")) {
          return slackResponse({ ok: true, user: { id: "UOTHER" } });
        }
        if (url.includes("conversations.info")) {
          return slackResponse({
            ok: true,
            channel: { id: "C123", name: "engineering" },
          });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();

    const event: SocketEvent = {
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        event_id: "EvClear",
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "UOTHER",
          text: "<@USELF> clearable message",
          ts: "1786020000.000700",
        },
      },
      event: undefined as never,
    };
    event.event = event.body.event;
    socket.emit("message", event);

    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    expect(listener.readInbox(0)).toEqual([]);
    expect(listener.readInbox(-1)).toEqual([]);
    expect(listener.status().unread).toBe(1);
    expect(listener.readInbox(1)).toHaveLength(1);
    expect(listener.status().unread).toBe(0);
    expect(listener.clearInbox()).toBe(1);
    expect(listener.readInbox(10)).toEqual([]);
  });

  it("reports unread changes and notifies only for mentions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        if (url.includes("users.info")) {
          return slackResponse({
            ok: true,
            user: { id: "UOTHER", profile: { display_name: "Alice" } },
          });
        }
        if (url.includes("conversations.info")) {
          return slackResponse({
            ok: true,
            channel: { id: "CWATCHED", name: "engineering" },
          });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const onStatusChange = vi.fn();
    const onMention = vi.fn();
    const onAttention = vi.fn();
    const listener = new SlackEventListener({
      socket,
      watchedChannels: ["CWATCHED"],
      onStatusChange,
      onMention,
      onAttention,
    });
    await listener.start();
    onStatusChange.mockClear();

    const makeEvent = (eventId: string, text: string): SocketEvent => {
      const event = {
        type: "message" as const,
        channel: "CWATCHED",
        channel_type: "channel" as const,
        user: "UOTHER",
        text,
        ts: `1786020000.${eventId}`,
      };
      return {
        ack: vi.fn().mockResolvedValue(undefined),
        body: { event_id: eventId, event },
        event,
      };
    };

    socket.emit("message", makeEvent("000801", "watched update"));
    socket.emit("message", makeEvent("000802", "<@USELF> direct mention"));

    await vi.waitFor(() => expect(listener.status().unread).toBe(2));
    expect(onMention).toHaveBeenCalledOnce();
    expect(onMention).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "000802", isMention: true }),
    );
    expect(onAttention).toHaveBeenCalledOnce();
    expect(onAttention).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "000802",
        attentionKind: "mention",
      }),
    );
    expect(onStatusChange).toHaveBeenLastCalledWith({
      state: "connected",
      unread: 2,
    });

    listener.readInbox(1);
    expect(onStatusChange).toHaveBeenLastCalledWith({
      state: "connected",
      unread: 1,
    });
    listener.clearInbox();
    expect(onStatusChange).toHaveBeenLastCalledWith({
      state: "connected",
      unread: 0,
    });
  });

  it("tracks reconnection and disconnects cleanly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();
    expect(listener.status().state).toBe("connected");

    socket.emit("reconnecting");
    expect(listener.status().state).toBe("reconnecting");
    socket.emit("connected");
    expect(listener.status().state).toBe("connected");

    await listener.stop();
    expect(socket.disconnect).toHaveBeenCalledOnce();
    expect(listener.status().state).toBe("stopped");

    await listener.stop();
    expect(socket.disconnect).toHaveBeenCalledOnce();
  });

  it("force-closes a socket whose first disconnect does not settle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    let finishFirstDisconnect: (() => void) | undefined;
    const socket = new FakeSocketClient();
    socket.disconnect
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirstDisconnect = () => resolve(undefined);
          }),
      )
      .mockImplementationOnce(async () => finishFirstDisconnect?.());
    const listener = new SlackEventListener({ socket });
    await listener.start();

    vi.useFakeTimers();
    const stopping = listener.stop();
    await vi.advanceTimersByTimeAsync(999);
    expect(socket.disconnect).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(socket.disconnect).toHaveBeenCalledTimes(2);
    expect(listener.status().state).toBe("stopped");
  });

  it("retries a failed initial connection while listening remains enabled", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    socket.start
      .mockRejectedValueOnce(new Error("temporary startup failure"))
      .mockResolvedValueOnce({ ok: true });
    const listener = new SlackEventListener({ socket });

    await expect(listener.start()).rejects.toThrow("temporary startup failure");
    expect(listener.status().state).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.start).toHaveBeenCalledTimes(2);
    expect(listener.status().state).toBe("connected");
    await listener.stop();
  });

  it("reconnects after a socket error without waiting for a disconnect event", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const onError = vi.fn();
    const listener = new SlackEventListener({ socket, onError });
    await listener.start();

    socket.emit("error", new Error("connection failed"));
    expect(onError).toHaveBeenCalledOnce();
    expect(listener.status().state).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.start).toHaveBeenCalledTimes(2);
    expect(listener.status().state).toBe("connected");
    await listener.stop();
  });

  it("retries dropped connections without leaking rejected reconnect attempts", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const reconnectError = new Error("network still unavailable");
    socket.start
      .mockResolvedValueOnce({ ok: true })
      .mockImplementationOnce(async () => {
        socket.emit("error", reconnectError);
        throw reconnectError;
      })
      .mockResolvedValueOnce({ ok: true });
    const onError = vi.fn();
    const listener = new SlackEventListener({ socket, onError });
    await listener.start();

    socket.emit("disconnected");
    expect(listener.status().state).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.start).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      "Slack Socket Mode: network still unavailable",
    );
    expect(listener.status().state).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(socket.start).toHaveBeenCalledTimes(3);
    expect(listener.status().state).toBe("connected");

    await listener.stop();
  });

  it("recovers after an outage exceeds the initial reconnect backoff", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    let failuresRemaining = 6;
    socket.start
      .mockResolvedValueOnce({ ok: true })
      .mockImplementation(async () => {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("extended outage");
        }
        return { ok: true };
      });
    const onError = vi.fn();
    const listener = new SlackEventListener({ socket, onError });
    await listener.start();

    socket.emit("disconnected");
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    expect(socket.start).toHaveBeenCalledTimes(7);
    expect(onError).toHaveBeenCalledOnce();
    expect(listener.status().state).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.start).toHaveBeenCalledTimes(8);
    expect(listener.status().state).toBe("connected");
    await listener.stop();
  });

  it("cancels capped reconnect backoff when listening stops", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    socket.start
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValue(new Error("ongoing outage"));
    const listener = new SlackEventListener({ socket });
    await listener.start();

    socket.emit("disconnected");
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(listener.status().state).toBe("reconnecting");

    await listener.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(socket.start).toHaveBeenCalledTimes(7);
    expect(listener.status().state).toBe("stopped");
  });

  it("times out stalled socket reconnects before continuing backoff", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    let rejectStalledStart: ((error: Error) => void) | undefined;
    const socket = new FakeSocketClient();
    socket.start
      .mockResolvedValueOnce({ ok: true })
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectStalledStart = reject;
          }),
      )
      .mockResolvedValueOnce({ ok: true });
    socket.disconnect.mockImplementation(async () => {
      rejectStalledStart?.(new Error("disconnected"));
      rejectStalledStart = undefined;
    });
    const onError = vi.fn();
    const listener = new SlackEventListener({ socket, onError });
    await listener.start();

    socket.emit("disconnected");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.start).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      "Slack Socket Mode: connection timed out.",
    );
    expect(listener.status().state).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(socket.start).toHaveBeenCalledTimes(3);
    expect(listener.status().state).toBe("connected");
    await listener.stop();
  });

  it("continues after acknowledgement errors without exposing connection secrets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        if (url.includes("users.info")) {
          return slackResponse({ ok: true, user: { id: "UOTHER" } });
        }
        if (url.includes("conversations.info")) {
          return slackResponse({ ok: true, channel: { id: "C123" } });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const onError = vi.fn();
    const listener = new SlackEventListener({ socket, onError });
    await listener.start();

    const event: SocketEvent = {
      ack: vi
        .fn()
        .mockRejectedValue(
          new Error(
            `failed ${TEST_APP_TOKEN} at wss://wss-primary.slack.com/link/?ticket=secret`,
          ),
        ),
      body: {
        event_id: "EvAckFailure",
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "UOTHER",
          text: "<@USELF> still retain this",
          ts: "1786020000.000900",
        },
      },
      event: undefined as never,
    };
    event.event = event.body.event;
    socket.emit("message", event);

    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    expect(onError).toHaveBeenCalledOnce();
    const message = String(onError.mock.calls[0]?.[0]);
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain(TEST_APP_TOKEN);
    expect(message).not.toContain("wss://");
  });

  it("coalesces concurrent start requests", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("auth.test")) {
        return slackResponse({ ok: true, user_id: "USELF" });
      }
      throw new Error(`Unexpected Slack request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });

    await Promise.all([listener.start(), listener.start()]);

    expect(socket.start).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(listener.status().state).toBe("connected");
  });

  it("waits for in-flight socket startup before shutdown completes", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("auth.test")) {
        return slackResponse({ ok: true, user_id: "USELF" });
      }
      if (url.includes("users.info")) {
        return slackResponse({ ok: true, user: { id: "UOTHER" } });
      }
      if (url.includes("conversations.info")) {
        return slackResponse({ ok: true, channel: { id: "C123" } });
      }
      throw new Error(`Unexpected Slack request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    let finishStart: (() => void) | undefined;
    const socket = new FakeSocketClient();
    socket.start.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStart = () => resolve({ ok: true });
        }),
    );
    const onMention = vi.fn();
    const listener = new SlackEventListener({ socket, onMention });

    const starting = listener.start();
    await vi.waitFor(() => expect(socket.start).toHaveBeenCalledOnce());
    let stopSettled = false;
    const stopping = listener.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();

    const ack = vi.fn().mockResolvedValue(undefined);
    const event = {
      type: "message",
      channel: "C123",
      channel_type: "channel",
      user: "UOTHER",
      text: "<@USELF> arrived during shutdown",
      ts: "1786020000.000950",
    };
    socket.emit("message", {
      ack,
      body: { event_id: "EvDuringShutdown", event },
      event,
    });
    await vi.waitFor(() => expect(ack).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(stopSettled).toBe(false);
    expect(listener.status().unread).toBe(0);
    expect(onMention).not.toHaveBeenCalled();
    finishStart?.();
    await Promise.all([starting, stopping]);

    expect(listener.status().state).toBe("stopped");
    expect(socket.disconnect).toHaveBeenCalledTimes(2);
  });

  it("bounds shutdown when socket startup and disconnect never settle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    let finishStart: (() => void) | undefined;
    let finishDisconnect: (() => void) | undefined;
    const socket = new FakeSocketClient();
    socket.start
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishStart = () => resolve({ ok: true });
          }),
      )
      .mockResolvedValue({ ok: true });
    socket.disconnect
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishDisconnect = () => resolve(undefined);
          }),
      )
      .mockResolvedValue(undefined);
    const listener = new SlackEventListener({ socket });

    const starting = listener.start();
    await vi.waitFor(() => expect(socket.start).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    const stopping = listener.stop();
    const rejection = expect(stopping).rejects.toThrow(
      "Slack Socket Mode shutdown timed out.",
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(listener.status().state).toBe("stopped");
    await expect(listener.start()).rejects.toThrow(
      "Slack Socket Mode is still shutting down.",
    );
    expect(socket.start).toHaveBeenCalledOnce();

    finishStart?.();
    finishDisconnect?.();
    await starting;

    await listener.start();
    expect(socket.start).toHaveBeenCalledTimes(2);
    expect(listener.status().state).toBe("connected");
    await listener.stop();
  });

  it("does not open a socket when shutdown happens during authentication", async () => {
    let finishAuth: (() => void) | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("auth.test")) {
        await new Promise<void>((resolve) => {
          finishAuth = resolve;
        });
        return slackResponse({ ok: true, user_id: "USELF" });
      }
      throw new Error(`Unexpected Slack request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });

    const starting = listener.start();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await listener.stop();
    finishAuth?.();
    await starting;

    expect(socket.start).not.toHaveBeenCalled();
    expect(listener.status().state).toBe("stopped");
  });

  it("reports startup failures without exposing connection secrets", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    socket.start.mockRejectedValue(
      new Error(
        `invalid ${TEST_APP_TOKEN} for wss://wss-primary.slack.com/link/?ticket=secret`,
      ),
    );
    const onError = vi.fn();
    const listener = new SlackEventListener({ socket, onError });

    let startError: unknown;
    try {
      await listener.start();
    } catch (error) {
      startError = error;
    }

    expect(listener.status().state).toBe("reconnecting");
    expect(onError).toHaveBeenCalledOnce();
    for (const message of [
      String(startError),
      String(onError.mock.calls[0]?.[0]),
    ]) {
      expect(message).toContain("[REDACTED]");
      expect(message).not.toContain(TEST_APP_TOKEN);
      expect(message).not.toContain("wss://");
    }
    await listener.stop();
  });

  it("normalizes an SDK rejection without error details", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    socket.start.mockRejectedValue(undefined);
    const onError = vi.fn();
    const listener = new SlackEventListener({ socket, onError });

    await expect(listener.start()).rejects.toThrow(
      "connection failed without error details",
    );
    expect(onError).toHaveBeenCalledWith(
      "Slack Socket Mode: connection failed without error details.",
    );
    await listener.stop();
  });

  it("keeps inbox order stable when name lookups finish out of order", async () => {
    let finishFirstUser: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        if (url.includes("/users.info")) {
          const query = url.split("?", 2)[1] ?? "";
          const userId = new URLSearchParams(query).get("user");
          if (userId === "UFIRST") {
            await new Promise<void>((resolve) => {
              finishFirstUser = resolve;
            });
          }
          return slackResponse({ ok: true, user: { id: userId } });
        }
        if (url.includes("/conversations.info")) {
          return slackResponse({ ok: true, channel: { id: "C123" } });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();

    const makeEvent = (
      eventId: string,
      user: string,
      timestamp: string,
    ): SocketEvent => {
      const event = {
        type: "message" as const,
        channel: "C123",
        channel_type: "channel" as const,
        user,
        text: `<@USELF> ${eventId}`,
        ts: timestamp,
      };
      return {
        ack: vi.fn().mockResolvedValue(undefined),
        body: { event_id: eventId, event },
        event,
      };
    };

    socket.emit("message", makeEvent("EvFirst", "UFIRST", "1786020000.001100"));
    await vi.waitFor(() => expect(finishFirstUser).toBeDefined());
    socket.emit(
      "message",
      makeEvent("EvSecond", "USECOND", "1786020000.001200"),
    );
    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    finishFirstUser?.();
    await vi.waitFor(() => expect(listener.status().unread).toBe(2));

    expect(listener.readInbox(10).map((message) => message.eventId)).toEqual([
      "EvFirst",
      "EvSecond",
    ]);
  });

  it("clears external errors independently from catch-up completeness", () => {
    const listener = new SlackEventListener({ socket: new FakeSocketClient() });
    listener.reportExternalError(new Error("catch-up failed"));
    listener.setCatchUpIncomplete(true);
    listener.clearExternalError();

    expect(listener.status().lastError).toBeUndefined();
    expect(listener.status().catchUpIncomplete).toBe(true);
  });

  it("clears a transient socket error after reconnecting", async () => {
    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({
      socket,
      directory: {
        selfUserId: vi.fn(async () => "USELF"),
        userName: vi.fn(async () => "Sam"),
        channelName: vi.fn(async () => "triage"),
      },
    });
    await listener.start();
    socket.emit("error", new Error("read ECONNRESET"));
    expect(listener.status().lastError).toContain("ECONNRESET");

    socket.emit("connected", undefined);

    expect(listener.status().lastError).toBeUndefined();
    expect(listener.status().state).toBe("connected");
  });

  it("rejects backfill while the listener is stopped", async () => {
    const listener = new SlackEventListener({ socket: new FakeSocketClient() });

    await expect(
      listener.ingestBackfill({
        type: "message",
        channel: "C123",
        channel_type: "channel",
        user: "USAM",
        text: "<@USELF> investigate",
        ts: "1786020000.000100",
      }),
    ).rejects.toThrow("lifecycle changed");
  });

  it("rejects a backfill item when the listener lifecycle changes", async () => {
    let releaseUserName: ((name: string) => void) | undefined;
    const directory = {
      selfUserId: vi.fn(async () => "USELF"),
      userName: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            releaseUserName = resolve;
          }),
      ),
      channelName: vi.fn(async () => "triage"),
    };
    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket, directory });
    await listener.start();
    const ingest = listener.ingestBackfill({
      type: "message",
      channel: "C123",
      channel_type: "channel",
      user: "USAM",
      text: "<@USELF> investigate",
      ts: "1786020000.000100",
    });
    await vi.waitFor(() => expect(directory.userName).toHaveBeenCalled());

    socket.emit("disconnected", undefined);
    await listener.start();
    releaseUserName?.("Sam");

    await expect(ingest).rejects.toThrow("lifecycle changed");
    expect(listener.status().unread).toBe(0);
  });

  it("captures a private-channel mention", async () => {
    stubDirectoryFetch();
    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();
    const event = mentionEvent("EvPrivate", "1786020000.000100");
    event.body.event.channel_type = "group";
    event.event = event.body.event;

    socket.emit("message", event);

    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    expect(listener.pullInbox({ leaseMs: 0 })[0]).toMatchObject({
      channelType: "group",
      attentionKind: "mention",
    });
  });

  it("captures an IM without requiring an explicit mention", async () => {
    stubDirectoryFetch();
    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();
    const event = mentionEvent("EvDirect", "1786020000.000100");
    event.body.event.channel = "D123";
    event.body.event.channel_type = "im";
    event.body.event.text = "Can you look at this?";
    event.event = event.body.event;

    socket.emit("message", event);

    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    expect(listener.pullInbox({ leaseMs: 0 })[0]).toMatchObject({
      channelId: "D123",
      channelType: "im",
      isMention: false,
      attentionKind: "direct-message",
    });
  });

  it("admits a redelivered message only once when its event id changes", async () => {
    stubDirectoryFetch();
    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();

    socket.emit("message", mentionEvent("EvFirst", "1786020000.000100"));
    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    socket.emit("message", mentionEvent("EvSecond", "1786020000.000100"));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listener.status().unread).toBe(1);
    expect(listener.pullInbox()).toHaveLength(1);
  });

  it("redelivers a pulled message that was never acked", async () => {
    stubDirectoryFetch();
    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();
    socket.emit("message", mentionEvent("EvFirst", "1786020000.000100"));
    await vi.waitFor(() => expect(listener.status().unread).toBe(1));

    const [pulled] = listener.pullInbox({ leaseMs: 0 });
    expect(pulled?.key).toBe("C123:1786020000.000100");
    expect(listener.pullInbox({ leaseMs: 0 })).toHaveLength(1);

    expect(listener.ackInbox([pulled?.key ?? ""])).toBe(1);
    expect(listener.pullInbox({ leaseMs: 0 })).toEqual([]);
  });

  it("recovers unacked messages in a listener built after a restart", async () => {
    stubDirectoryFetch();
    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();
    socket.emit("message", mentionEvent("EvFirst", "1786020000.000100"));
    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    listener.pullInbox({ leaseMs: 0 });
    await listener.stop();

    const restarted = new SlackEventListener({ socket: new FakeSocketClient() });
    const recovered = restarted.pullInbox({ leaseMs: 0 });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.key).toBe("C123:1786020000.000100");
    expect(recovered[0]?.deliveryCount).toBe(2);
  });
});
