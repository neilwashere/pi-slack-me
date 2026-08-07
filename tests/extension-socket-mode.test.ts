import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackMe as createSlackExtension } from "../extensions/index";
import type {
  GlobalSlackInbox,
  GlobalSlackInboxSnapshot,
  SlackInboxClientIdentity,
} from "../lib/global-slack-inbox";
import type { SlackInboxMessage } from "../lib/slack-events";

interface TestContext {
  hasUI: boolean;
  mode: "tui";
  isIdle: ReturnType<typeof vi.fn>;
  ui: {
    notify: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    setEditorText: ReturnType<typeof vi.fn>;
  };
}

type Hook = (
  event: Record<string, unknown>,
  context: TestContext,
) => Promise<unknown> | unknown;

interface TestCommand {
  handler: (args: string, context: TestContext) => Promise<void> | void;
}

interface TestTool {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}

class FakeInboxClient implements GlobalSlackInbox {
  readonly close = vi.fn(async () => undefined);
  readonly connect = vi.fn(async (_identity: SlackInboxClientIdentity) => {
    this.publish();
  });
  private readonly listeners = new Set<
    (snapshot: GlobalSlackInboxSnapshot) => void
  >();
  private unread = 1;

  constructor(private readonly messages: SlackInboxMessage[]) {}

  subscribe(
    listener: (snapshot: GlobalSlackInboxSnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async status() {
    return { state: "connected" as const, unread: this.unread };
  }

  async setListening(enabled: boolean) {
    return {
      state: enabled ? ("connected" as const) : ("stopped" as const),
      unread: this.unread,
    };
  }

  async readInbox(limit = 10) {
    this.unread = 0;
    this.publish();
    return this.messages.slice(-limit);
  }

  async clearInbox() {
    const count = this.messages.length;
    this.messages.length = 0;
    this.unread = 0;
    this.publish();
    return count;
  }

  private publish(): void {
    const snapshot: GlobalSlackInboxSnapshot = {
      status: { state: "connected", unread: this.unread },
    };
    for (const listener of this.listeners) listener(snapshot);
  }
}

describe("Slack extension lifecycle", () => {
  beforeEach(() => {
    process.env.SLACK_USER_TOKEN = "xoxp-test";
    process.env.SLACK_APP_TOKEN = "xapp-test";
  });

  afterEach(() => {
    delete process.env.SLACK_USER_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
  });

  it("keeps inbox messages passive and executes commands without an agent turn", async () => {
    const hooks = new Map<string, Hook[]>();
    const commands = new Map<string, TestCommand>();
    const tools = new Map<string, TestTool>();
    const sendUserMessage = vi.fn();
    const pi = {
      registerFlag: vi.fn(),
      registerTool: vi.fn((tool: TestTool) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn((name: string, command: TestCommand) => {
        commands.set(name, command);
      }),
      on: vi.fn((event: string, hook: Hook) => {
        const registered = hooks.get(event) ?? [];
        registered.push(hook);
        hooks.set(event, registered);
      }),
      sendUserMessage,
    } as unknown as ExtensionAPI;
    const context: TestContext = {
      hasUI: true,
      mode: "tui",
      isIdle: vi.fn().mockReturnValue(true),
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        setEditorText: vi.fn(),
      },
    };
    const channelsResult = {
      title: "Slack channels",
      text: "**Channels** (1):\n\n# **engineering** (CWATCHED)",
      details: { operation: "list-channels" as const },
    };
    const workspace = {
      execute: vi.fn().mockResolvedValue(channelsResult),
      directory: {
        selfUserId: vi.fn(),
        userName: vi.fn(),
        channelName: vi.fn(),
      },
    };
    const presenter = {
      present: vi.fn().mockResolvedValue(undefined),
    };
    const inbox = new FakeInboxClient([
      {
        eventId: "EvExtension",
        channelId: "CWATCHED",
        channelName: "engineering",
        userId: "UOTHER",
        userName: "Alice",
        text: "<@USELF> hello from Slack",
        timestamp: "1786020000.001000",
        isMention: true,
      },
    ]);
    createSlackExtension({
      createGlobalInbox: () => inbox,
      workspace,
      presenter,
    })(pi);
    expect(hooks.has("before_agent_start")).toBe(false);

    const startHook = hooks.get("session_start")?.[0];
    expect(startHook).toBeDefined();
    await startHook?.({ reason: "startup" }, context);
    expect(context.ui.setStatus).toHaveBeenCalledWith(
      "slack-listener",
      "Slack: 1 unread",
    );

    const command = commands.get("slack");
    expect(command).toBeDefined();
    await command?.handler("inbox 1", context);

    const editorText = String(context.ui.setEditorText.mock.calls.at(-1)?.[0]);
    expect(editorText).toContain("untrusted external content");
    expect(editorText).toContain('"text": "<@USELF> hello from Slack"');
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Slack inbox loaded into the input editor. Review it, then press Enter to send it to the agent.",
      "info",
    );

    await command?.handler("channels", context);
    expect(workspace.execute).toHaveBeenCalledWith(
      { operation: "list-channels" },
      { signal: undefined },
    );
    expect(presenter.present).toHaveBeenCalledWith(context, channelsResult);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(context.ui.setEditorText).toHaveBeenCalledOnce();

    const listChannelsTool = tools.get("slack_list_channels");
    expect(listChannelsTool).toBeDefined();
    const signal = new AbortController().signal;
    await listChannelsTool?.execute(
      "call-id",
      { types: "im" },
      signal,
      undefined,
      context,
    );
    expect(workspace.execute).toHaveBeenNthCalledWith(
      2,
      { operation: "list-channels", types: "im" },
      { signal },
    );

    context.isIdle.mockReturnValue(false);
    await command?.handler("search deploy status", context);
    expect(workspace.execute).toHaveBeenNthCalledWith(
      3,
      { operation: "search", query: "deploy status" },
      { signal: undefined },
    );
    expect(presenter.present).toHaveBeenNthCalledWith(
      2,
      context,
      channelsResult,
    );
    expect(sendUserMessage).not.toHaveBeenCalled();

    await command?.handler("wat", context);
    expect(context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Unknown Slack command"),
      "warning",
    );

    const shutdownHook = hooks.get("session_shutdown")?.[0];
    expect(shutdownHook).toBeDefined();
    await shutdownHook?.({ reason: "quit" }, context);
    expect(inbox.close).toHaveBeenCalledOnce();
    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "slack-listener",
      undefined,
    );
  });
});
