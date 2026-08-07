import { createConnection } from "node:net";
import type { SlackInboxClientIdentity } from "./slack-sidecar-protocol";
import type { SlackInboxMessage } from "./slack-events";

const REQUEST_TIMEOUT_MS = 750;
const MAX_RESPONSE_BYTES = 1024 * 1024;
let requestSequence = 0;

interface HerdrResponse {
  id: string;
  result?: {
    snapshot?: {
      focused_pane_id?: string;
      agents?: Array<{
        pane_id?: string;
        agent_session?: { value?: string };
      }>;
    };
  };
  error?: { message?: string };
}

interface HerdrSessionProbe {
  socketPath: string;
  clients: SlackInboxClientIdentity[];
  focusedPaneId: string | undefined;
  focusedSessionPath: string | undefined;
}

function oneLine(value: string, limit: number): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > limit
    ? `${normalized.slice(0, Math.max(0, limit - 1))}…`
    : normalized;
}

function channelLabel(message: SlackInboxMessage): string {
  return message.channelName === message.channelId
    ? message.channelId
    : `#${message.channelName}`;
}

function sendHerdrRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
): Promise<HerdrResponse> {
  return new Promise((resolve, reject) => {
    const id = `pi-slack-herdr-${process.pid}-${++requestSequence}`;
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, response?: HerdrResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else if (response) resolve(response);
      else reject(new Error("Herdr returned no response."));
    };
    const timeout = setTimeout(
      () => finish(new Error(`Herdr ${method} request timed out.`)),
      REQUEST_TIMEOUT_MS,
    );
    timeout.unref?.();
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ id, method, params })}\n`),
    );
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) {
        finish(new Error("Herdr returned an oversized response."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as HerdrResponse;
        if (response.id !== id) {
          finish(new Error("Herdr returned a mismatched response."));
        } else if (response.error) {
          finish(
            new Error(response.error.message ?? `Herdr ${method} failed.`),
          );
        } else {
          finish(undefined, response);
        }
      } catch {
        finish(new Error("Herdr returned invalid JSON."));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => finish(new Error("Herdr closed the connection.")));
  });
}

export class HerdrNotifier {
  async notify(
    message: SlackInboxMessage,
    clients: readonly SlackInboxClientIdentity[],
  ): Promise<void> {
    const grouped = new Map<string, SlackInboxClientIdentity[]>();
    for (const client of clients) {
      if (!client.herdrSocketPath) continue;
      const group = grouped.get(client.herdrSocketPath) ?? [];
      group.push(client);
      grouped.set(client.herdrSocketPath, group);
    }
    if (grouped.size === 0) return;

    const probeResults = await Promise.all(
      [...grouped].map(async ([socketPath, sessionClients]) => {
        try {
          const response = await sendHerdrRequest(
            socketPath,
            "session.snapshot",
            {},
          );
          const snapshot = response.result?.snapshot;
          const focusedPaneId = snapshot?.focused_pane_id;
          const focusedSessionPath = snapshot?.agents?.find(
            (agent) => agent.pane_id === focusedPaneId,
          )?.agent_session?.value;
          return {
            socketPath,
            clients: sessionClients,
            focusedPaneId,
            focusedSessionPath,
          } satisfies HerdrSessionProbe;
        } catch {
          return undefined;
        }
      }),
    );
    const probes = probeResults.filter(
      (probe): probe is HerdrSessionProbe => probe !== undefined,
    );
    const target =
      probes.find((probe) =>
        probe.clients.some(
          (client) =>
            client.herdrPaneId === probe.focusedPaneId ||
            (client.sessionPath !== undefined &&
              client.sessionPath === probe.focusedSessionPath),
        ),
      ) ?? probes[0];
    if (!target) return;

    const title = oneLine(
      `Slack ${message.isMention ? "mention" : "thread reply"} · ${message.userName} in ${channelLabel(message)}`,
      80,
    );
    const body = oneLine(message.text, 240);
    try {
      await sendHerdrRequest(target.socketPath, "notification.show", {
        title,
        body,
        sound: "none",
      });
    } catch {
      // The global inbox remains authoritative when Herdr is unavailable.
    }
  }
}
