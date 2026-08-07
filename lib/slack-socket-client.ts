import { LogLevel, SocketModeClient, type Logger } from "@slack/socket-mode";
import type { SocketModeClientLike } from "./slack-events";

const silentSocketLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  setLevel: () => undefined,
  getLevel: () => LogLevel.ERROR,
  setName: () => undefined,
};

export function createSlackSocketClient(
  appToken: string,
): SocketModeClientLike {
  return new SocketModeClient({
    appToken,
    logger: silentSocketLogger,
    autoReconnectEnabled: false,
    clientOptions: { retryConfig: { retries: 0 }, timeout: 10_000 },
  });
}
