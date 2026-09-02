import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { hasSlackToken } from "../lib/auth";
import {
  ALLOW_HEADLESS_WRITE_FLAG,
  ALLOW_HEADLESS_WRITE_FLAG_DESCRIPTION,
  CONFIRM_WRITE_FLAG,
  CONFIRM_WRITE_FLAG_DESCRIPTION,
} from "../lib/confirm";
import {
  createDefaultGlobalSlackInboxClient,
  type GlobalSlackInbox,
  type SlackInboxClientIdentity,
} from "../lib/global-slack-inbox";
import { createSlackCommand } from "../lib/slack-command";
import {
  formatListenerStatus,
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
  createGlobalInbox?: () => GlobalSlackInbox;
  workspace?: SlackWorkspace;
  presenter?: SlackResultPresenter;
}

function clientIdentity(): SlackInboxClientIdentity {
  return {
    processId: process.pid,
    sessionId: process.env.PI_SESSION_ID,
    sessionPath: process.env.PI_SESSION_FILE,
    herdrPaneId: process.env.HERDR_PANE_ID,
    herdrSocketPath: process.env.HERDR_SOCKET_PATH,
  };
}

export function createSlackMe(
  dependencies: SlackMeDependencies = {},
): (pi: ExtensionAPI) => void {
  return (pi) => registerSlackMe(pi, dependencies);
}

function registerSlackMe(
  pi: ExtensionAPI,
  dependencies: SlackMeDependencies,
): void {
  let inbox: GlobalSlackInbox | undefined;
  let unsubscribeInbox: (() => void) | undefined;
  let connectPromise: Promise<GlobalSlackInbox | undefined> | undefined;
  const workspace = dependencies.workspace ?? createSlackWorkspace();
  const presenter = dependencies.presenter ?? createSlackResultPresenter();

  // ctx is optional because the tool surface has no ExtensionContext: tools
  // only need the connection, while the footer subscription needs a UI. The
  // subscription is attached on the first call that supplies a ctx, so a
  // tool-first connection still gets a footer once the session starts.
  const ensureInbox = (
    ctx?: ExtensionContext,
  ): Promise<GlobalSlackInbox | undefined> => {
    const appToken = process.env.SLACK_APP_TOKEN?.trim();
    if (!appToken) return Promise.resolve(undefined);
    if (!inbox) {
      inbox =
        dependencies.createGlobalInbox?.() ??
        createDefaultGlobalSlackInboxClient();
    }
    if (ctx && !unsubscribeInbox) {
      unsubscribeInbox = inbox.subscribe((snapshot) =>
        ctx.ui.setStatus(
          SLACK_LISTENER_STATUS_KEY,
          formatListenerStatus(snapshot.status),
        ),
      );
    }
    if (connectPromise) return connectPromise;
    const current = inbox;
    connectPromise = current.connect(clientIdentity()).then(
      () => {
        connectPromise = undefined;
        return current;
      },
      (error: unknown) => {
        connectPromise = undefined;
        throw error;
      },
    );
    return connectPromise;
  };

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

  registerSlackTools(pi, workspace, () => ensureInbox());
  pi.registerCommand(
    "slack",
    createSlackCommand({
      workspace,
      presenter,
      ensureInbox,
    }),
  );

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI || !hasSlackToken()) return;
    try {
      await ensureInbox(ctx);
    } catch (error) {
      ctx.ui.setStatus(
        SLACK_LISTENER_STATUS_KEY,
        formatListenerStatus({ state: "error", unread: 0 }),
      );
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "warning",
      );
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    unsubscribeInbox?.();
    unsubscribeInbox = undefined;
    const current = inbox;
    inbox = undefined;
    connectPromise = undefined;
    await current?.close();
    ctx.ui.setStatus(SLACK_LISTENER_STATUS_KEY, undefined);
  });
}

export default createSlackMe();
