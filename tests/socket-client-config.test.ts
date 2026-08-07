import { afterEach, describe, expect, it, vi } from "vitest";

const captureSocketOptions = vi.hoisted(() => vi.fn());

vi.mock("@slack/socket-mode", () => ({
  LogLevel: { ERROR: "error" },
  SocketModeClient: class {
    constructor(options: unknown) {
      captureSocketOptions(options);
    }

    on(): this {
      return this;
    }

    async start(): Promise<void> {}

    async disconnect(): Promise<void> {}
  },
}));

import { createSlackSocketClient } from "../lib/slack-socket-client";

describe("default Socket Mode client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    captureSocketOptions.mockClear();
  });

  it("disables unsafe SDK reconnects and suppresses raw SDK logging", () => {
    createSlackSocketClient("xapp-test");

    expect(captureSocketOptions).toHaveBeenCalledOnce();
    const options = captureSocketOptions.mock.calls[0]?.[0] as {
      autoReconnectEnabled: boolean;
      clientOptions: { retryConfig: { retries: number }; timeout: number };
      logger: {
        debug: (...args: unknown[]) => void;
        info: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
        getLevel: () => string;
      };
    };
    expect(options.autoReconnectEnabled).toBe(false);
    expect(options.clientOptions).toEqual({
      retryConfig: { retries: 0 },
      timeout: 10_000,
    });
    expect(options.logger.getLevel()).toBe("error");

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    options.logger.debug("debug");
    options.logger.info("info");
    options.logger.warn("warning");
    options.logger.error("wss://secret.example/?ticket=secret");
    expect(consoleError).not.toHaveBeenCalled();
  });
});
