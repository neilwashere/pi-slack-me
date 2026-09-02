import { describe, expect, it } from "vitest";
import { formatListenerStatus } from "../lib/slack-inbox";

describe("formatListenerStatus", () => {
  it("keeps the compact unread status while connected", () => {
    expect(formatListenerStatus({ state: "connected", unread: 3 })).toBe(
      "Slack: 3 unread",
    );
  });

  it("surfaces listener errors ahead of connection state", () => {
    expect(
      formatListenerStatus({
        state: "connected",
        unread: 2,
        lastError: "Slack Socket Mode: inbox full",
      }),
    ).toBe("Slack: error · 2 unread");
  });

  it.each([
    ["reconnecting", "Slack: reconnecting · 3 unread"],
    ["disconnected", "Slack: disconnected · 3 unread"],
    ["error", "Slack: error · 3 unread"],
    ["stopped", "Slack: off · 3 unread"],
  ] as const)(
    "shows %s state alongside retained messages",
    (state, expected) => {
      expect(formatListenerStatus({ state, unread: 3 })).toBe(expected);
    },
  );
});
