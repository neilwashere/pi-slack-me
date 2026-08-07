import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

beforeEach(async () => {
  delete process.env.SLACK_USER_TOKEN;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.SLACK_USER_TOKEN;
  vi.unstubAllGlobals();
});

describe("getSlackToken", () => {
  it("returns the trimmed env value when SLACK_USER_TOKEN is set", async () => {
    process.env.SLACK_USER_TOKEN = "  xoxp-with-whitespace  ";
    const { getSlackToken } = await import("../lib/auth");
    expect(getSlackToken()).toBe("xoxp-with-whitespace");
  });

  it("throws SlackAuthError when SLACK_USER_TOKEN is missing", async () => {
    const { getSlackToken, SlackAuthError } = await import("../lib/auth");
    expect(() => getSlackToken()).toThrow(SlackAuthError);
  });

  it("error message points the user at the app-creation URL and mentions xoxp", async () => {
    const { getSlackToken, SlackAuthError } = await import("../lib/auth");
    try {
      getSlackToken();
      expect.unreachable("expected SlackAuthError");
    } catch (err) {
      expect(err).toBeInstanceOf(SlackAuthError);
      expect((err as Error).message).toMatch(/api\.slack\.com\/apps/);
      expect((err as Error).message).toMatch(/SLACK_USER_TOKEN/);
      expect((err as Error).message).toMatch(/xoxp/);
    }
  });

  it("empty string is treated as missing", async () => {
    process.env.SLACK_USER_TOKEN = "";
    const { getSlackToken, SlackAuthError } = await import("../lib/auth");
    expect(() => getSlackToken()).toThrow(SlackAuthError);
  });

  it("reads token rotations from the environment immediately", async () => {
    process.env.SLACK_USER_TOKEN = "first";
    const { getSlackToken } = await import("../lib/auth");
    expect(getSlackToken()).toBe("first");
    process.env.SLACK_USER_TOKEN = "second";
    expect(getSlackToken()).toBe("second");
  });

  it("hasSlackToken tracks env presence without throwing", async () => {
    const { hasSlackToken } = await import("../lib/auth");
    expect(hasSlackToken()).toBe(false);
    process.env.SLACK_USER_TOKEN = "xoxp-x";
    expect(hasSlackToken()).toBe(true);
  });
});
