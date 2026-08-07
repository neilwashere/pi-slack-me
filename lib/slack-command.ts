import {
  getSettingsListTheme,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  SettingsList,
  Text,
  type SettingItem,
} from "@earendil-works/pi-tui";
import { hasSlackToken } from "./auth";
import {
  ALLOW_HEADLESS_WRITE_FLAG,
  ALLOW_HEADLESS_WRITE_FLAG_DESCRIPTION,
  CONFIRM_WRITE_FLAG,
  CONFIRM_WRITE_FLAG_DESCRIPTION,
  getAllowHeadlessWriteEnabled,
  getConfirmWriteEnabled,
  setAllowHeadlessWriteEnabled,
  setConfirmWriteEnabled,
} from "./confirm";
import { errorText } from "./result";
import {
  parseSlackCommand,
  type SlackCommandIntent,
} from "./slack-command-parser";
export { parseSlackCommand };
import type { SlackEventListener } from "./slack-events";
import {
  formatInboxPrompt,
  formatListenerStatus,
} from "./slack-inbox";
import type { SlackResultPresenter } from "./slack-presenter";
import type {
  SlackOperation,
  SlackOperationOptions,
  SlackWorkspace,
} from "./slack-workspace";
import { createSlackWriteReviewer } from "./slack-write-review";

const USAGE =
  "/slack channels [types] | dms | read <channel> [N] | thread <channel> <ts> | search <query> | download <file_id> | post <channel> <text> | dm <user> <text> | reply <channel> <ts> <text> | edit <channel> <ts> <text> | delete <channel> <ts> | react <channel> <ts> <emoji> | inbox [N|clear] | listen status|on|off | config | confirm on|off | headless on|off";

type SlackListenerControl = Pick<
  SlackEventListener,
  "start" | "stop" | "status" | "readInbox" | "clearInbox"
>;

export interface SlackCommandDependencies {
  workspace: SlackWorkspace;
  presenter: SlackResultPresenter;
  getListener(): SlackListenerControl | undefined;
  ensureListener(ctx: ExtensionCommandContext): SlackListenerControl | undefined;
}

export interface SlackCommandDefinition {
  description: string;
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

function warning(ctx: ExtensionCommandContext, message: string): void {
  ctx.ui.notify(message, "warning");
}

async function runOperation(
  ctx: ExtensionCommandContext,
  dependencies: SlackCommandDependencies,
  operation: SlackOperation,
  reviewed: boolean,
): Promise<void> {
  const options: SlackOperationOptions = { signal: undefined };
  if (reviewed) options.reviewer = createSlackWriteReviewer(ctx);
  try {
    const result = await dependencies.workspace.execute(operation, options);
    await dependencies.presenter.present(ctx, result);
  } catch (error) {
    ctx.ui.notify(errorText(error), "error");
  }
}

function showInbox(
  ctx: ExtensionCommandContext,
  dependencies: SlackCommandDependencies,
  intent: Extract<SlackCommandIntent, { kind: "inbox" }>,
): void {
  const listener = dependencies.getListener();
  if (!listener) {
    warning(
      ctx,
      "Slack inbox is not active. Set SLACK_APP_TOKEN and restart pi, or run /slack listen on.",
    );
    return;
  }
  if (intent.action === "clear") {
    const count = listener.clearInbox();
    ctx.ui.notify(`Cleared ${count} Slack inbox message(s).`, "info");
    return;
  }
  const messages = listener.readInbox(intent.limit);
  if (messages.length === 0) {
    ctx.ui.notify("Slack inbox is empty.", "info");
    return;
  }
  ctx.ui.setEditorText(formatInboxPrompt(messages));
  ctx.ui.notify(
    "Slack inbox loaded into the input editor. Review it, then press Enter to send it to the agent.",
    "info",
  );
}

async function controlListener(
  ctx: ExtensionCommandContext,
  dependencies: SlackCommandDependencies,
  action: "status" | "on" | "off",
): Promise<void> {
  const listener = dependencies.ensureListener(ctx);
  if (!listener) {
    warning(
      ctx,
      "Slack Socket Mode is not configured. Set SLACK_APP_TOKEN=xapp-... and restart pi.",
    );
    return;
  }
  if (action === "status") {
    ctx.ui.notify(formatListenerStatus(listener.status()), "info");
    return;
  }
  try {
    if (action === "on") {
      await listener.start();
      if (listener.status().state === "connected") {
        ctx.ui.notify("Slack Socket Mode connected.", "info");
      }
    } else {
      await listener.stop();
      ctx.ui.notify("Slack Socket Mode stopped.", "info");
    }
  } catch (error) {
    warning(ctx, errorText(error));
  }
}

function persistToggle(
  ctx: ExtensionCommandContext,
  kind: "confirm" | "headless",
  enabled: boolean,
): void {
  const flag = kind === "confirm" ? CONFIRM_WRITE_FLAG : ALLOW_HEADLESS_WRITE_FLAG;
  const saved =
    kind === "confirm"
      ? setConfirmWriteEnabled(enabled)
      : setAllowHeadlessWriteEnabled(enabled);
  if (!saved) {
    ctx.ui.notify(`Failed to persist ${flag} (disk write failed).`, "error");
    return;
  }
  const guardedDelete = kind === "confirm" ? " (delete stays guarded regardless.)" : "";
  ctx.ui.notify(`${flag}: ${enabled ? "on" : "off"}.${guardedDelete}`, "info");
}

async function openSlackConfig(ctx: ExtensionCommandContext): Promise<void> {
  const currentConfirm = getConfirmWriteEnabled();
  const currentHeadless = getAllowHeadlessWriteEnabled();
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      `Slack write review (post/update): ${currentConfirm ? "on" : "off"}. Delete is always guarded. Headless writes: ${currentHeadless ? "on" : "off"}. Toggle: /slack confirm on|off, /slack headless on|off`,
      "info",
    );
    return;
  }

  const items: SettingItem[] = [
    {
      id: CONFIRM_WRITE_FLAG,
      label: "Review before posting writes",
      description: CONFIRM_WRITE_FLAG_DESCRIPTION,
      currentValue: currentConfirm ? "on" : "off",
      values: ["on", "off"],
    },
    {
      id: ALLOW_HEADLESS_WRITE_FLAG,
      label: "Allow writes in headless mode",
      description: ALLOW_HEADLESS_WRITE_FLAG_DESCRIPTION,
      currentValue: currentHeadless ? "on" : "off",
      values: ["on", "off"],
    },
  ];
  const pending = new Map<string, boolean>();
  await ctx.ui.custom((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(
      new Text(
        theme.fg("accent", theme.bold("Slack extension settings")),
        1,
        1,
      ),
    );
    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id: string, value: string) => pending.set(id, value === "on"),
      () => done(undefined),
    );
    container.addChild(settingsList);
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });

  for (const [id, value] of pending) {
    if (id === CONFIRM_WRITE_FLAG && value !== currentConfirm) {
      persistToggle(ctx, "confirm", value);
    } else if (id === ALLOW_HEADLESS_WRITE_FLAG && value !== currentHeadless) {
      persistToggle(ctx, "headless", value);
    }
  }
}

async function handleIntent(
  ctx: ExtensionCommandContext,
  dependencies: SlackCommandDependencies,
  intent: SlackCommandIntent,
): Promise<void> {
  switch (intent.kind) {
    case "help":
      ctx.ui.notify(`Slack is configured. Usage: ${USAGE}`, "info");
      return;
    case "invalid":
      warning(ctx, intent.message);
      return;
    case "operation":
      await runOperation(
        ctx,
        dependencies,
        intent.operation,
        intent.reviewed,
      );
      return;
    case "inbox":
      showInbox(ctx, dependencies, intent);
      return;
    case "listen":
      await controlListener(ctx, dependencies, intent.action);
      return;
    case "config":
      await openSlackConfig(ctx);
      return;
    case "confirm":
      persistToggle(ctx, "confirm", intent.enabled);
      return;
    case "headless":
      persistToggle(ctx, "headless", intent.enabled);
      return;
    default:
      throw new Error("Unsupported Slack command intent.");
  }
}

export function createSlackCommand(
  dependencies: SlackCommandDependencies,
): SlackCommandDefinition {
  return {
    description: `Slack tools that act as you. Usage: ${USAGE}`,
    async handler(args, ctx) {
      if (!hasSlackToken()) {
        warning(
          ctx,
          "Slack: SLACK_USER_TOKEN is not set. Create a Slack app, add the User Token Scopes from the README, install it, and `export SLACK_USER_TOKEN=xoxp-...`.",
        );
        return;
      }
      await handleIntent(ctx, dependencies, parseSlackCommand(args));
    },
  };
}
