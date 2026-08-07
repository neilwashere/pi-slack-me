import type { SlackListenerStatus } from "./slack-events";

export const SLACK_SIDECAR_PROTOCOL_VERSION = 1;

export interface SlackInboxClientIdentity {
  processId: number;
  sessionId?: string;
  sessionPath?: string;
  herdrPaneId?: string;
  herdrSocketPath?: string;
}

export interface GlobalSlackInboxSnapshot {
  status: SlackListenerStatus;
}

export type SlackSidecarRequest =
  | {
      id: string;
      type: "hello";
      protocolVersion: number;
      identity: SlackInboxClientIdentity;
    }
  | { id: string; type: "status" }
  | { id: string; type: "set-listening"; enabled: boolean }
  | { id: string; type: "read-inbox"; limit?: number }
  | { id: string; type: "clear-inbox" };

export type SlackSidecarRequestInput = SlackSidecarRequest extends infer Request
  ? Request extends SlackSidecarRequest
    ? Omit<Request, "id">
    : never
  : never;

export type SlackSidecarResponse =
  | {
      kind: "response";
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      kind: "response";
      id: string;
      ok: false;
      error: string;
    };

interface SlackSidecarSnapshotEvent {
  kind: "snapshot";
  snapshot: GlobalSlackInboxSnapshot;
}

export type SlackSidecarMessage =
  | SlackSidecarResponse
  | SlackSidecarSnapshotEvent;
