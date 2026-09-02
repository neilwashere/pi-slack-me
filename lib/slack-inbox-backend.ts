import { SlackCatchUp } from "./slack-catch-up";
import { SlackEventListener, type SlackListenerState } from "./slack-events";
import { parseWatchedChannels } from "./slack-inbox";
import { SlackInboxStore } from "./slack-inbox-store";
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
  const watchedChannels =
    options.watchedChannels ??
    parseWatchedChannels(process.env.SLACK_LISTEN_CHANNELS);
  const store = new SlackInboxStore();
  let previousState: SlackListenerState = "stopped";
  let catchUp: SlackCatchUp;
  const eventListener = new SlackEventListener({
    socket: createSlackSocketClient(options.appToken),
    store,
    directory,
    threadTracker: createSlackThreadTracker(transport),
    watchedChannels,
    onStatusChange: (status) => {
      emit({ type: "status", status });
      const justConnected =
        status.state === "connected" && previousState !== "connected";
      previousState = status.state;
      if (justConnected) {
        void runCatchUp().catch((error) =>
          eventListener.reportExternalError(error),
        );
      }
    },
    onAttention: (message) => emit({ type: "attention", message }),
  });
  catchUp = new SlackCatchUp({
    transport,
    store,
    watchedChannels,
    ingest: (message) => eventListener.ingestBackfill(message),
    isAvailable: () => eventListener.canIngestBackfill(),
  });
  const runCatchUp = async () => {
    if (!eventListener.canIngestBackfill()) {
      throw new Error(
        "Slack catch-up requires a started listener with an authenticated user.",
      );
    }
    const result = await catchUp.run();
    const incomplete = result.truncated || result.errors.length > 0;
    eventListener.setCatchUpIncomplete(incomplete);
    if (!incomplete) eventListener.clearExternalError();
    return result;
  };

  return {
    start: () => eventListener.start(),
    stop: () => eventListener.stop(),
    status: () => eventListener.status(),
    readInbox: (limit) => eventListener.readInbox(limit),
    pullInbox: (filter) => eventListener.pullInbox(filter),
    ackInbox: (keys) => eventListener.ackInbox(keys),
    catchUp: runCatchUp,
    clearInbox: () => eventListener.clearInbox(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
