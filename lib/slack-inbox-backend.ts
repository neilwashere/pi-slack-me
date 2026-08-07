import { SlackEventListener } from "./slack-events";
import { parseWatchedChannels } from "./slack-inbox";
import { createSlackSocketClient } from "./slack-socket-client";
import { createSlackDirectory } from "./slack-directory";
import { createSlackThreadTracker } from "./slack-thread-tracker";
import { createSlackTransport } from "./slack-transport";
import type {
  SlackInboxBackend,
  SlackInboxBackendEvent,
} from "./slack-sidecar-server";

export interface SlackInboxBackendOptions {
  appToken: string;
  watchedChannels?: string[];
}

export function createSlackInboxBackend(
  options: SlackInboxBackendOptions,
): SlackInboxBackend {
  const listeners = new Set<(event: SlackInboxBackendEvent) => void>();
  const transport = createSlackTransport();
  const directory = createSlackDirectory(transport);
  const emit = (event: SlackInboxBackendEvent) => {
    for (const listener of listeners) listener(event);
  };
  const eventListener = new SlackEventListener({
    socket: createSlackSocketClient(options.appToken),
    directory,
    threadTracker: createSlackThreadTracker(transport),
    watchedChannels:
      options.watchedChannels ??
      parseWatchedChannels(process.env.SLACK_LISTEN_CHANNELS),
    onStatusChange: (status) => emit({ type: "status", status }),
    onAttention: (message) => emit({ type: "attention", message }),
  });

  return {
    start: () => eventListener.start(),
    stop: () => eventListener.stop(),
    status: () => eventListener.status(),
    readInbox: (limit) => eventListener.readInbox(limit),
    clearInbox: () => eventListener.clearInbox(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
