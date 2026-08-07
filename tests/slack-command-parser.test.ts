import { describe, expect, it } from "vitest";
import { parseSlackCommand } from "../lib/slack-command";

describe("Slack command parser", () => {
  it.each([
    ["", { kind: "help" }],
    [
      "channels private_channel,im",
      {
        kind: "operation",
        operation: {
          operation: "list-channels",
          types: "private_channel,im",
        },
        reviewed: false,
      },
    ],
    [
      "dms",
      {
        kind: "operation",
        operation: { operation: "list-channels", types: "im" },
        reviewed: false,
      },
    ],
    [
      "read C123 20",
      {
        kind: "operation",
        operation: { operation: "read-messages", channel: "C123", limit: 20 },
        reviewed: false,
      },
    ],
    [
      "thread C123 100.1",
      {
        kind: "operation",
        operation: {
          operation: "read-thread",
          channel: "C123",
          threadTs: "100.1",
        },
        reviewed: false,
      },
    ],
    [
      "search deploy status",
      {
        kind: "operation",
        operation: { operation: "search", query: "deploy status" },
        reviewed: false,
      },
    ],
    [
      "download F123",
      {
        kind: "operation",
        operation: { operation: "download-file", fileId: "F123" },
        reviewed: false,
      },
    ],
    [
      "post C123 hello world",
      {
        kind: "operation",
        operation: {
          operation: "post-message",
          channel: "C123",
          text: "hello world",
        },
        reviewed: true,
      },
    ],
    [
      "dm U123 hello",
      {
        kind: "operation",
        operation: { operation: "post-message", toUser: "U123", text: "hello" },
        reviewed: true,
      },
    ],
    [
      "reply C123 100.1 confirmed now",
      {
        kind: "operation",
        operation: {
          operation: "post-message",
          channel: "C123",
          threadTs: "100.1",
          text: "confirmed now",
        },
        reviewed: true,
      },
    ],
    [
      "edit C123 100.1 corrected text",
      {
        kind: "operation",
        operation: {
          operation: "update-message",
          channel: "C123",
          timestamp: "100.1",
          text: "corrected text",
        },
        reviewed: true,
      },
    ],
    [
      "delete C123 100.1",
      {
        kind: "operation",
        operation: {
          operation: "delete-message",
          channel: "C123",
          timestamp: "100.1",
        },
        reviewed: true,
      },
    ],
    [
      "react C123 100.1 :eyes:",
      {
        kind: "operation",
        operation: {
          operation: "add-reaction",
          channel: "C123",
          timestamp: "100.1",
          name: "eyes",
        },
        reviewed: false,
      },
    ],
    ["inbox 25", { kind: "inbox", action: "read", limit: 25 }],
    ["inbox clear", { kind: "inbox", action: "clear" }],
    ["listen off", { kind: "listen", action: "off" }],
    ["config", { kind: "config" }],
    ["confirm off", { kind: "confirm", enabled: false }],
    ["headless on", { kind: "headless", enabled: true }],
  ] as const)("parses %s", (input, expected) => {
    expect(parseSlackCommand(input)).toEqual(expected);
  });

  it.each([
    ["read", "Usage: /slack read"],
    ["thread C123", "Usage: /slack thread"],
    ["download F123 extra", "Usage: /slack download"],
    ["confirm maybe", "Usage: /slack confirm"],
    ["wat", "Unknown Slack command"],
  ] as const)("reports invalid input for %s", (input, message) => {
    expect(parseSlackCommand(input)).toEqual({
      kind: "invalid",
      message: expect.stringContaining(message),
    });
  });
});
