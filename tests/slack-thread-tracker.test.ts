import { describe, expect, it, vi } from "vitest";
import { SlackApiError } from "../lib/api.js";
import { createSlackThreadTracker } from "../lib/slack-thread-tracker.js";
import type { SlackTransport } from "../lib/slack-workspace";

function transportWith(get: SlackTransport["get"]): SlackTransport {
  return {
    get,
    post: vi.fn(),
    download: vi.fn(),
  };
}

describe("Slack thread participation", () => {
  it("finds prior participation across pages and caches the result", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        messages: [{ user: "UOTHER", text: "first page" }],
        response_metadata: { next_cursor: "page-two" },
      })
      .mockResolvedValueOnce({
        ok: true,
        messages: [{ user: "USELF", text: "my earlier reply" }],
        response_metadata: { next_cursor: "" },
      });
    const tracker = createSlackThreadTracker(transportWith(get));

    await expect(tracker.participates("C123", "100.1", "USELF")).resolves.toBe(
      true,
    );
    await expect(tracker.participates("C123", "100.1", "USELF")).resolves.toBe(
      true,
    );

    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(1, "conversations.replies", {
      query: { channel: "C123", ts: "100.1", limit: 200 },
    });
    expect(get).toHaveBeenNthCalledWith(2, "conversations.replies", {
      query: {
        channel: "C123",
        ts: "100.1",
        limit: 200,
        cursor: "page-two",
      },
    });
  });

  it("retries a rate-limited history page before classifying the reply", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(
        new SlackApiError("rate limited", 429, "ratelimited", 0),
      )
      .mockResolvedValueOnce({
        ok: true,
        messages: [{ user: "USELF", text: "my earlier reply" }],
        response_metadata: { next_cursor: "" },
      });
    const tracker = createSlackThreadTracker(transportWith(get));

    await expect(tracker.participates("C123", "100.2", "USELF")).resolves.toBe(
      true,
    );
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("continues until Slack exhausts the thread history", async () => {
    const get = vi.fn();
    for (let page = 1; page <= 10; page += 1) {
      get.mockResolvedValueOnce({
        ok: true,
        messages: [{ user: "UOTHER", text: `page ${page}` }],
        response_metadata: { next_cursor: `page-${page + 1}` },
      });
    }
    get.mockResolvedValueOnce({
      ok: true,
      messages: [{ user: "USELF", text: "my old reply" }],
      response_metadata: { next_cursor: "" },
    });
    const tracker = createSlackThreadTracker(transportWith(get));

    await expect(tracker.participates("C123", "100.2", "USELF")).resolves.toBe(
      true,
    );
    expect(get).toHaveBeenCalledTimes(11);
  });

  it("treats an earlier mention as participation", async () => {
    const get = vi.fn().mockResolvedValue({
      ok: true,
      messages: [{ user: "UOTHER", text: "Can <@USELF> help?" }],
      response_metadata: { next_cursor: "" },
    });
    const tracker = createSlackThreadTracker(transportWith(get));

    await expect(tracker.participates("C123", "100.2", "USELF")).resolves.toBe(
      true,
    );
  });

  it("uses observed participation without requesting thread history", async () => {
    const get = vi.fn();
    const tracker = createSlackThreadTracker(transportWith(get));

    tracker.mark("C123", "100.3");

    await expect(tracker.participates("C123", "100.3", "USELF")).resolves.toBe(
      true,
    );
    expect(get).not.toHaveBeenCalled();
  });
});
