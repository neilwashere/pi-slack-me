import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { GlobalSlackInbox } from "../lib/global-slack-inbox";
import type { SlackInboxPullItem } from "../lib/slack-inbox-store";
import { createAckInboxTool } from "../lib/tools/ack-inbox";
import { createCatchUpTool } from "../lib/tools/catch-up";
import { createReadInboxTool } from "../lib/tools/read-inbox";

function pullItem(
  overrides: Partial<SlackInboxPullItem> = {},
): SlackInboxPullItem {
  return {
    key: "C1:1786020000.000100",
    deliveryCount: 1,
    eventId: "Ev1",
    channelId: "C1",
    channelName: "triage",
    userId: "USAM",
    userName: "Sam",
    text: "deploy is failing on main",
    timestamp: "1786020000.000100",
    isMention: true,
    attentionKind: "mention",
    ...overrides,
  };
}

function fakeInbox(overrides: Partial<GlobalSlackInbox> = {}): GlobalSlackInbox {
  return {
    connect: vi.fn(),
    subscribe: vi.fn(),
    status: vi.fn(),
    setListening: vi.fn(),
    readInbox: vi.fn(),
    pullInbox: vi.fn(async () => []),
    ackInbox: vi.fn(async () => 0),
    catchUp: vi.fn(async () => ({
      added: 0,
      scanned: 0,
      scopes: 0,
      truncated: false,
      errors: [],
      startedAt: "1.000000",
      completedAt: "2.000000",
    })),
    clearInbox: vi.fn(),
    close: vi.fn(),
    ...overrides,
  } as GlobalSlackInbox;
}

function invoke(
  tool: { execute: unknown },
  params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  const execute = tool.execute as (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: undefined,
    context: { hasUI: boolean; ui: Record<string, unknown> },
  ) => Promise<AgentToolResult<unknown>>;
  return execute(
    "call-id",
    params,
    new AbortController().signal,
    undefined,
    { hasUI: true, ui: {} },
  );
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .map((entry) => (entry.type === "text" ? entry.text : ""))
    .join("");
}

describe("slack_read_inbox", () => {
  it("maps tool parameters onto the pull filter", async () => {
    const pullInbox = vi.fn(async () => []);
    const tool = createReadInboxTool(async () => fakeInbox({ pullInbox }));

    await invoke(tool, {
        limit: 5,
        from_users: ["Sam"],
        channel_ids: ["C1"],
        attention_kinds: ["mention"],
        lease_seconds: 120,
      });

    expect(pullInbox).toHaveBeenCalledWith({
      limit: 5,
      fromUsers: ["Sam"],
      channelIds: ["C1"],
      attentionKinds: ["mention"],
      leaseMs: 120_000,
    });
  });

  it("leaves the lease unset when the caller omits it", async () => {
    const pullInbox = vi.fn(async () => []);
    const tool = createReadInboxTool(async () => fakeInbox({ pullInbox }));

    await invoke(tool, {});

    expect(pullInbox).toHaveBeenCalledWith(
      expect.objectContaining({ leaseMs: undefined }),
    );
  });

  it("returns the ack key and the thread to reply in", async () => {
    const tool = createReadInboxTool(async () =>
      fakeInbox({
        pullInbox: vi.fn(async () => [
          pullItem({ threadTimestamp: "1786019999.000900" }),
        ]),
      }),
    );

    const text = resultText(
      await invoke(tool, {}),
    );

    expect(text).toContain('"key": "C1:1786020000.000100"');
    expect(text).toContain('"reply_thread_ts": "1786019999.000900"');
    expect(text).toContain("untrusted external content");
  });

  it("points a top-level message's reply at its own timestamp", async () => {
    const tool = createReadInboxTool(async () =>
      fakeInbox({ pullInbox: vi.fn(async () => [pullItem()]) }),
    );

    const text = resultText(
      await invoke(tool, {}),
    );

    expect(text).toContain('"reply_thread_ts": "1786020000.000100"');
  });

  it("explains the missing app token instead of failing", async () => {
    const tool = createReadInboxTool(async () => undefined);

    const text = resultText(
      await invoke(tool, {}),
    );

    expect(text).toContain("SLACK_APP_TOKEN");
  });
});

describe("slack_catch_up", () => {
  it("returns the completeness report", async () => {
    const tool = createCatchUpTool(async () =>
      fakeInbox({
        catchUp: vi.fn(async () => ({
          added: 3,
          scanned: 4,
          scopes: 2,
          truncated: true,
          errors: ["workspace mentions: missing_scope"],
          startedAt: "1.000000",
          completedAt: "2.000000",
        })),
      }),
    );

    const text = resultText(await invoke(tool, {}));

    expect(text).toContain('"added": 3');
    expect(text).toContain('"truncated": true');
    expect(text).toContain("missing_scope");
  });

  it("explains the missing app token", async () => {
    const tool = createCatchUpTool(async () => undefined);

    expect(resultText(await invoke(tool, {}))).toContain("SLACK_APP_TOKEN");
  });
});

describe("slack_ack_inbox", () => {
  it("reports keys that were no longer retained", async () => {
    const tool = createAckInboxTool(async () =>
      fakeInbox({ ackInbox: vi.fn(async () => 1) }),
    );

    const text = resultText(
      await invoke(tool, { keys: ["C1:1", "C1:2"] }),
    );

    expect(text).toContain("Acked 1 of 2");
    expect(text).toContain("1 were already completed");
  });

  it("stays quiet when every key was retained", async () => {
    const tool = createAckInboxTool(async () =>
      fakeInbox({ ackInbox: vi.fn(async () => 2) }),
    );

    const text = resultText(
      await invoke(tool, { keys: ["C1:1", "C1:2"] }),
    );

    expect(text).toBe("Acked 2 of 2 Slack inbox messages.");
  });
});
