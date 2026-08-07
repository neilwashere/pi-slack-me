import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackMe } from "../extensions/index";
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
  handler(args: string, context: TestContext): Promise<void> | void;
}

class SharedInboxState {
  private readonly clients = new Set<FakeInboxClient>();
  private readonly messages: SlackInboxMessage[] = [];
  private snapshot: GlobalSlackInboxSnapshot = {
    status: { state: "connected", unread: 0 },
  };

  createClient(): FakeInboxClient {
    const client = new FakeInboxClient(this);
    this.clients.add(client);
    return client;
  }

  receive(message: SlackInboxMessage): void {
    this.messages.push(message);
    this.publish({
      status: {
        state: "connected",
        unread: this.snapshot.status.unread + 1,
      },
    });
  }

  read(limit = 10): SlackInboxMessage[] {
    const selected = this.messages.slice(-limit);
    this.publish({
      status: { state: "connected", unread: 0 },
    });
    return selected;
  }

  clear(): number {
    const count = this.messages.length;
    this.messages.length = 0;
    this.publish({
      status: { state: "connected", unread: 0 },
    });
    return count;
  }

  current(): GlobalSlackInboxSnapshot {
    return this.snapshot;
  }

  publish(snapshot: GlobalSlackInboxSnapshot): void {
    this.snapshot = snapshot;
    for (const client of this.clients) client.publish(snapshot);
  }
}

class FakeInboxClient implements GlobalSlackInbox {
  readonly connect = vi.fn(async (identity: SlackInboxClientIdentity) => {
    this.identity = identity;
    this.publish(this.state.current());
  });
  readonly close = vi.fn(async () => undefined);
  identity?: SlackInboxClientIdentity;
  private readonly listeners = new Set<
    (snapshot: GlobalSlackInboxSnapshot) => void
  >();

  constructor(private readonly state: SharedInboxState) {}

  subscribe(
    listener: (snapshot: GlobalSlackInboxSnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async status() {
    return this.state.current().status;
  }

  async setListening(enabled: boolean) {
    const status = {
      state: enabled ? ("connected" as const) : ("stopped" as const),
      unread: this.state.current().status.unread,
    };
    this.state.publish({ status });
    return status;
  }

  async readInbox(limit?: number) {
    return this.state.read(limit);
  }

  async clearInbox() {
    return this.state.clear();
  }

  publish(snapshot: GlobalSlackInboxSnapshot): void {
    for (const listener of this.listeners) listener(snapshot);
  }
}

function createHarness(client: GlobalSlackInbox) {
  const hooks = new Map<string, Hook[]>();
  const commands = new Map<string, TestCommand>();
  const pi = {
    registerFlag: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, command: TestCommand) => {
      commands.set(name, command);
    }),
    on: vi.fn((event: string, hook: Hook) => {
      const registered = hooks.get(event) ?? [];
      registered.push(hook);
      hooks.set(event, registered);
    }),
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
  const workspace = {
    execute: vi.fn(),
    directory: {
      selfUserId: vi.fn(),
      userName: vi.fn(),
      channelName: vi.fn(),
    },
  };
  createSlackMe({
    createGlobalInbox: () => client,
    workspace,
    presenter: { present: vi.fn() },
  })(pi);
  return { hooks, commands, context };
}

const message: SlackInboxMessage = {
  eventId: "EvShared",
  channelId: "C123",
  channelName: "engineering",
  userId: "U123",
  userName: "Alice",
  text: "<@USELF> shared inbox message",
  timestamp: "1786111000.001000",
  isMention: true,
};

describe("global inbox extension wiring", () => {
  beforeEach(() => {
    process.env.SLACK_USER_TOKEN = "xoxp-test";
    process.env.SLACK_APP_TOKEN = "xapp-test";
    process.env.PI_SESSION_ID = "session-one";
    process.env.PI_SESSION_FILE = "/tmp/session-one.jsonl";
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
  });

  afterEach(() => {
    for (const key of [
      "SLACK_USER_TOKEN",
      "SLACK_APP_TOKEN",
      "PI_SESSION_ID",
      "PI_SESSION_FILE",
      "HERDR_PANE_ID",
      "HERDR_SOCKET_PATH",
    ]) {
      delete process.env[key];
    }
  });

  it("shows one shared unread count in every Pi footer and reads it globally", async () => {
    const state = new SharedInboxState();
    const firstClient = state.createClient();
    const secondClient = state.createClient();
    const first = createHarness(firstClient);
    const second = createHarness(secondClient);

    await first.hooks.get("session_start")?.[0]?.({}, first.context);
    process.env.PI_SESSION_ID = "session-two";
    process.env.PI_SESSION_FILE = "/tmp/session-two.jsonl";
    process.env.HERDR_PANE_ID = "w1:p2";
    await second.hooks.get("session_start")?.[0]?.({}, second.context);

    expect(firstClient.connect).toHaveBeenCalledWith({
      processId: process.pid,
      sessionId: "session-one",
      sessionPath: "/tmp/session-one.jsonl",
      herdrPaneId: "w1:p1",
      herdrSocketPath: "/tmp/herdr.sock",
    });
    state.receive(message);

    expect(first.context.ui.setStatus).toHaveBeenLastCalledWith(
      "slack-listener",
      "Slack: 1 unread",
    );
    expect(second.context.ui.setStatus).toHaveBeenLastCalledWith(
      "slack-listener",
      "Slack: 1 unread",
    );

    await first.commands.get("slack")?.handler("inbox 10", first.context);
    expect(first.context.ui.setEditorText).toHaveBeenCalledWith(
      expect.stringContaining("shared inbox message"),
    );
    expect(first.context.ui.setStatus).toHaveBeenLastCalledWith(
      "slack-listener",
      "Slack: connected",
    );
    expect(second.context.ui.setStatus).toHaveBeenLastCalledWith(
      "slack-listener",
      "Slack: connected",
    );

    await first.hooks.get("session_shutdown")?.[0]?.({}, first.context);
    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(secondClient.close).not.toHaveBeenCalled();
  });
});
