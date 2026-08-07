import { describe, expect, it, vi } from "vitest";
import {
  createSlackWorkspace,
  type SlackFileStore,
  type SlackTransport,
} from "../lib/slack-workspace";
import type { SlackWriteReviewer } from "../lib/slack-write-review";

describe("Slack workspace", () => {
  it("lists conversations through the injected transport and preserves pagination", async () => {
    const transport: SlackTransport = {
      get: vi.fn().mockResolvedValue({
        ok: true,
        channels: [
          {
            id: "C123",
            name: "engineering",
            is_channel: true,
            num_members: 12,
          },
        ],
        response_metadata: { next_cursor: "next-page" },
      }),
      post: vi.fn(),
      download: vi.fn(),
    };
    const workspace = createSlackWorkspace(transport);
    const signal = new AbortController().signal;

    const result = await workspace.execute(
      {
        operation: "list-channels",
        limit: 25,
        types: "private_channel,im",
        cursor: "current-page",
      },
      { signal },
    );

    expect(transport.get).toHaveBeenCalledWith("users.conversations", {
      query: {
        limit: 25,
        types: "private_channel,im",
        cursor: "current-page",
        exclude_archived: true,
      },
      signal,
    });
    expect(result.details.nextCursor).toBe("next-page");
    expect(result.text).toContain("**engineering** (C123)");
    expect(result.text).toContain("Next cursor: `next-page`");
  });

  it("reads messages with resolved author names and a usable next cursor", async () => {
    const get = vi.fn(async (method: string) => {
      if (method === "conversations.history") {
        return {
          ok: true,
          messages: [
            {
              user: "U123",
              text: "deploy complete",
              ts: "1710000000.000001",
            },
          ],
          has_more: true,
          response_metadata: { next_cursor: "next-message-page" },
        };
      }
      if (method === "users.info") {
        return {
          ok: true,
          user: { id: "U123", profile: { display_name: "Alice" } },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const transport: SlackTransport = {
      get: get as unknown as SlackTransport["get"],
      post: vi.fn(),
      download: vi.fn(),
    };
    const workspace = createSlackWorkspace(transport);
    const signal = new AbortController().signal;

    const result = await workspace.execute(
      {
        operation: "read-messages",
        channel: "C123",
        limit: 10,
        oldest: "1700000000.000001",
        cursor: "current-message-page",
      },
      { signal },
    );

    expect(get).toHaveBeenNthCalledWith(1, "conversations.history", {
      query: {
        channel: "C123",
        limit: 10,
        oldest: "1700000000.000001",
        latest: undefined,
        inclusive: true,
        cursor: "current-message-page",
      },
      signal,
    });
    expect(get).toHaveBeenNthCalledWith(2, "users.info", {
      query: { user: "U123" },
    });
    expect(result.text).toContain("**Alice**: deploy complete");
    expect(result.text).toContain("Next cursor: `next-message-page`");
    expect(result.details.nextCursor).toBe("next-message-page");
  });

  it("reads a thread with resolved authors and pagination", async () => {
    const get = vi.fn(async (method: string) => {
      if (method === "conversations.replies") {
        return {
          ok: true,
          messages: [
            { user: "U456", text: "confirmed", ts: "1710000001.000001" },
          ],
          has_more: true,
          response_metadata: { next_cursor: "next-thread-page" },
        };
      }
      if (method === "users.info") {
        return {
          ok: true,
          user: { id: "U456", profile: { real_name: "Bob" } },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const transport: SlackTransport = {
      get: get as unknown as SlackTransport["get"],
      post: vi.fn(),
      download: vi.fn(),
    };
    const workspace = createSlackWorkspace(transport);
    const signal = new AbortController().signal;

    const result = await workspace.execute(
      {
        operation: "read-thread",
        channel: "C123",
        threadTs: "1700000000.000001",
        limit: 30,
        cursor: "current-thread-page",
      },
      { signal },
    );

    expect(get).toHaveBeenNthCalledWith(1, "conversations.replies", {
      query: {
        channel: "C123",
        ts: "1700000000.000001",
        limit: 30,
        cursor: "current-thread-page",
      },
      signal,
    });
    expect(result.text).toContain("**Bob**: confirmed");
    expect(result.text).toContain("Next cursor: `next-thread-page`");
    expect(result.details.nextCursor).toBe("next-thread-page");
  });

  it("searches messages with resolved authors and paging metadata", async () => {
    const get = vi.fn(async (method: string) => {
      if (method === "search.messages") {
        return {
          ok: true,
          messages: {
            matches: [
              {
                iid: "1",
                channel: { id: "C123", name: "engineering" },
                user: "U789",
                ts: "1710000002.000001",
                text: "rollback complete",
                permalink: "https://example.slack.com/archives/C123/p1",
              },
            ],
            total: 7,
            paging: { page: 2, pages: 4, count: 1, total: 7 },
          },
        };
      }
      if (method === "users.info") {
        return {
          ok: true,
          user: { id: "U789", name: "carol" },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const transport: SlackTransport = {
      get: get as unknown as SlackTransport["get"],
      post: vi.fn(),
      download: vi.fn(),
    };
    const workspace = createSlackWorkspace(transport);
    const signal = new AbortController().signal;

    const result = await workspace.execute(
      {
        operation: "search",
        query: "rollback",
        count: 10,
        sort: "timestamp",
        sortDir: "asc",
        page: 2,
      },
      { signal },
    );

    expect(get).toHaveBeenNthCalledWith(1, "search.messages", {
      query: {
        query: "rollback",
        count: 10,
        sort: "timestamp",
        sort_dir: "asc",
        page: 2,
      },
      signal,
    });
    expect(result.text).toContain("**carol** in #engineering");
    expect(result.text).toContain("https://example.slack.com/archives/C123/p1");
    expect(result.details).toMatchObject({ page: 2, pages: 4, total: 7 });
  });

  it("downloads files through the file-store seam with a safe filename", async () => {
    const data = new Uint8Array([1, 2, 3]).buffer;
    const transport: SlackTransport = {
      get: vi.fn().mockResolvedValue({
        ok: true,
        file: {
          id: "F123",
          name: "../../secrets.txt",
          title: "Report",
          filetype: "txt",
          mimetype: "text/plain",
          size: 3,
          url_private_download: "https://files.slack.com/F123",
        },
      }),
      post: vi.fn(),
      download: vi.fn().mockResolvedValue(data),
    };
    const fileStore: SlackFileStore = {
      write: vi.fn().mockResolvedValue("/tmp/pi-slack-me/secrets-a1b2.txt"),
    };
    const workspace = createSlackWorkspace(transport, fileStore);
    const signal = new AbortController().signal;

    const result = await workspace.execute(
      { operation: "download-file", fileId: "F123" },
      { signal },
    );

    expect(transport.get).toHaveBeenCalledWith("files.info", {
      query: { file: "F123" },
      signal,
    });
    expect(transport.download).toHaveBeenCalledWith(
      "https://files.slack.com/F123",
      { signal },
    );
    expect(fileStore.write).toHaveBeenCalledWith("secrets.txt", data);
    expect(result.details.localPath).toBe(
      "/tmp/pi-slack-me/secrets-a1b2.txt",
    );
    expect(result.text).toContain("Downloaded to");
  });

  it("reviews and posts the approved message through the shared mutation path", async () => {
    const transport: SlackTransport = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({
        ok: true,
        channel: "C123",
        ts: "1710000003.000001",
      }),
      download: vi.fn(),
    };
    const reviewer: SlackWriteReviewer = {
      hasUI: true,
      review: vi.fn().mockResolvedValue({
        proceed: true,
        text: "approved message",
      }),
    };
    const workspace = createSlackWorkspace(transport);
    const signal = new AbortController().signal;

    const result = await workspace.execute(
      {
        operation: "post-message",
        channel: "C123",
        text: "draft message",
        threadTs: "1700000000.000001",
      },
      { signal, reviewer },
    );

    expect(reviewer.review).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Send message to C123?",
        editableText: "draft message",
      }),
    );
    expect(transport.post).toHaveBeenCalledWith("chat.postMessage", {
      body: {
        channel: "C123",
        text: "approved message",
        thread_ts: "1700000000.000001",
      },
      signal,
    });
    expect(result.text).toContain("threaded reply sent to C123");
    expect(result.details).toMatchObject({
      operation: "post-message",
      channel: "C123",
      timestamp: "1710000003.000001",
    });
  });

  it("reviews and updates a message through the shared mutation path", async () => {
    const transport: SlackTransport = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ ok: true }),
      download: vi.fn(),
    };
    const reviewer: SlackWriteReviewer = {
      hasUI: true,
      review: vi.fn().mockResolvedValue({
        proceed: true,
        text: "approved edit",
      }),
    };
    const workspace = createSlackWorkspace(transport);
    const signal = new AbortController().signal;

    const result = await workspace.execute(
      {
        operation: "update-message",
        channel: "C123",
        timestamp: "100.1",
        text: "draft edit",
      },
      { signal, reviewer },
    );

    expect(reviewer.review).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Edit message 100.1 in C123?",
        editableText: "draft edit",
      }),
    );
    expect(transport.post).toHaveBeenCalledWith("chat.update", {
      body: { channel: "C123", ts: "100.1", text: "approved edit" },
      signal,
    });
    expect(result.text).toBe("Slack: message 100.1 updated in C123.");
  });

  it("requires destructive review before deleting a message", async () => {
    const transport: SlackTransport = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ ok: true }),
      download: vi.fn(),
    };
    const reviewer: SlackWriteReviewer = {
      hasUI: true,
      review: vi.fn().mockResolvedValue({ proceed: true }),
    };
    const workspace = createSlackWorkspace(transport);
    const signal = new AbortController().signal;

    const result = await workspace.execute(
      {
        operation: "delete-message",
        channel: "C123",
        timestamp: "100.1",
      },
      { signal, reviewer },
    );

    expect(reviewer.review).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Delete message 100.1 in C123?",
        requireInteractive: true,
      }),
    );
    expect(transport.post).toHaveBeenCalledWith("chat.delete", {
      body: { channel: "C123", ts: "100.1" },
      signal,
    });
    expect(result.text).toContain("deleted from C123 (permanent)");
  });

  it("adds a reaction without invoking the message-write reviewer", async () => {
    const transport: SlackTransport = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ ok: true }),
      download: vi.fn(),
    };
    const workspace = createSlackWorkspace(transport);
    const signal = new AbortController().signal;

    const result = await workspace.execute(
      {
        operation: "add-reaction",
        channel: "C123",
        name: "thumbsup",
        timestamp: "100.1",
      },
      { signal },
    );

    expect(transport.post).toHaveBeenCalledWith("reactions.add", {
      body: { channel: "C123", name: "thumbsup", timestamp: "100.1" },
      signal,
    });
    expect(result.text).toBe(
      "Slack: added :thumbsup: reaction to message 100.1 in C123.",
    );
  });

  it("keeps a shared directory lookup alive when one caller cancels", async () => {
    let resolveLookup: ((value: unknown) => void) | undefined;
    const get = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const transport: SlackTransport = {
      get: get as SlackTransport["get"],
      post: vi.fn(),
      download: vi.fn(),
    };
    const workspace = createSlackWorkspace(transport);
    const controller = new AbortController();
    const cancelled = workspace.directory?.userName(
      "U999",
      controller.signal,
    );
    const shared = workspace.directory?.userName("U999");

    controller.abort();
    resolveLookup?.({
      ok: true,
      user: { id: "U999", profile: { display_name: "Dana" } },
    });

    await expect(cancelled).rejects.toThrow(/abort/i);
    await expect(shared).resolves.toBe("Dana");
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith("users.info", {
      query: { user: "U999" },
    });
  });
});
