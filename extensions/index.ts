import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { LogLevel, SocketModeClient, type Logger } from "@slack/socket-mode";
import { hasSlackToken } from "../lib/auth";
import {
  ALLOW_HEADLESS_WRITE_FLAG,
  ALLOW_HEADLESS_WRITE_FLAG_DESCRIPTION,
  CONFIRM_WRITE_FLAG,
  CONFIRM_WRITE_FLAG_DESCRIPTION,
} from "../lib/confirm";
import { createSlackCommand } from "../lib/slack-command";
import {
  SlackEventListener,
  type SocketModeClientLike,
} from "../lib/slack-events";
import {
  formatListenerStatus,
  formatMentionNotification,
  parseWatchedChannels,
  SLACK_LISTENER_STATUS_KEY,
} from "../lib/slack-inbox";
import {
  createSlackResultPresenter,
  type SlackResultPresenter,
} from "../lib/slack-presenter";
import { registerSlackTools } from "../lib/slack-tools";
import {
  createSlackWorkspace,
  type SlackWorkspace,
} from "../lib/slack-workspace";

export interface SlackMeDependencies {
  createSocketClient: (appToken: string) => SocketModeClientLike;
  workspace?: SlackWorkspace;
  presenter?: SlackResultPresenter;
}

const silentSocketLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  setLevel: () => undefined,
  getLevel: () => LogLevel.ERROR,
  setName: () => undefined,
};

const defaultDependencies: SlackMeDependencies = {
  createSocketClient: (appToken) =>
    new SocketModeClient({
      appToken,
      logger: silentSocketLogger,
      autoReconnectEnabled: false,
      clientOptions: { retryConfig: { retries: 0 }, timeout: 10_000 },
    }),
};

export function createSlackMe(
  dependencies: SlackMeDependencies = defaultDependencies,
): (pi: ExtensionAPI) => void {
  return (pi) => registerSlackMe(pi, dependencies);
}

function registerSlackMe(
  pi: ExtensionAPI,
  dependencies: SlackMeDependencies,
): void {
  let listener: SlackEventListener | undefined;
  const workspace = dependencies.workspace ?? createSlackWorkspace();
  const presenter = dependencies.presenter ?? createSlackResultPresenter();

  const ensureListener = (
    ctx: ExtensionContext,
  ): SlackEventListener | undefined => {
    if (listener) return listener;
    const appToken = process.env.SLACK_APP_TOKEN?.trim();
    if (!appToken) return undefined;
    listener = new SlackEventListener({
      socket: dependencies.createSocketClient(appToken),
      directory: workspace.directory,
      watchedChannels: parseWatchedChannels(process.env.SLACK_LISTEN_CHANNELS),
      onStatusChange: (status) =>
        ctx.ui.setStatus(
          SLACK_LISTENER_STATUS_KEY,
          formatListenerStatus(status),
        ),
      onMention: (message) =>
        ctx.ui.notify(formatMentionNotification(message), "info"),
      onError: (message) => ctx.ui.notify(message, "warning"),
    });
    return listener;
  };

  // Pi flags expose CLI defaults, while live command toggles are file-backed
  // because the extension interface has no runtime flag setter.
  pi.registerFlag(CONFIRM_WRITE_FLAG, {
    description: CONFIRM_WRITE_FLAG_DESCRIPTION,
    type: "boolean",
    default: true,
  });
  pi.registerFlag(ALLOW_HEADLESS_WRITE_FLAG, {
    description: ALLOW_HEADLESS_WRITE_FLAG_DESCRIPTION,
    type: "boolean",
    default: false,
  });

  registerSlackTools(pi, workspace);
  pi.registerCommand(
    "slack",
    createSlackCommand({
      workspace,
      presenter,
      getListener: () => listener,
      ensureListener,
    }),
  );

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || !hasSlackToken()) return;
    const current = ensureListener(ctx);
    if (!current) return;
    void current.start().catch(() => undefined);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const current = listener;
    listener = undefined;
    if (current) {
      try {
        await current.stop();
      } catch {
        ctx.ui.notify("Slack Socket Mode failed to stop cleanly.", "warning");
      }
    }
    ctx.ui.setStatus(SLACK_LISTENER_STATUS_KEY, undefined);
  });
}

export default createSlackMe();
