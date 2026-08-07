import type { SlackOperation } from "./slack-workspace";

export type SlackCommandIntent =
  | { kind: "help" }
  | { kind: "operation"; operation: SlackOperation; reviewed: boolean }
  | { kind: "inbox"; action: "read"; limit: number }
  | { kind: "inbox"; action: "clear" }
  | { kind: "listen"; action: "status" | "on" | "off" }
  | { kind: "config" }
  | { kind: "confirm"; enabled: boolean }
  | { kind: "headless"; enabled: boolean }
  | { kind: "invalid"; message: string };

function operation(
  value: SlackOperation,
  reviewed = false,
): SlackCommandIntent {
  return { kind: "operation", operation: value, reviewed };
}

function invalid(message: string): SlackCommandIntent {
  return { kind: "invalid", message };
}

function splitHead(value: string): [string, string] | undefined {
  const space = value.indexOf(" ");
  if (space < 1) return undefined;
  const tail = value.slice(space + 1).trim();
  return tail ? [value.slice(0, space), tail] : undefined;
}

function splitTwoHeads(value: string): [string, string, string] | undefined {
  const parts = value.split(/\s+/);
  if (parts.length < 3) return undefined;
  const tail = parts.slice(2).join(" ").trim();
  return tail ? [parts[0], parts[1], tail] : undefined;
}

function parseDiscovery(
  verb: string,
  rest: string,
): SlackCommandIntent | undefined {
  if (verb === "channels" || verb === "list") {
    return operation({
      operation: "list-channels",
      types: rest || undefined,
    });
  }
  if (verb === "dms") {
    return rest
      ? invalid("Usage: /slack dms")
      : operation({ operation: "list-channels", types: "im" });
  }
  if (verb === "read" || verb === "history") return parseRead(rest);
  if (verb === "thread") return parseThread(rest);
  return parseSearchOrDownload(verb, rest);
}

function parseSearchOrDownload(
  verb: string,
  rest: string,
): SlackCommandIntent | undefined {
  if (verb === "search" || verb === "find") {
    return rest
      ? operation({ operation: "search", query: rest })
      : invalid(
          "Usage: /slack search <query>\nExample: /slack search broken deploy in:#ops",
        );
  }
  if (verb !== "download") return undefined;
  return rest && !/\s/.test(rest)
    ? operation({ operation: "download-file", fileId: rest })
    : invalid(
        "Usage: /slack download <file_id>\nExample: /slack download F0123ABC456",
      );
}

function parseRead(rest: string): SlackCommandIntent {
  const parts = rest.split(/\s+/).filter(Boolean);
  const channel = parts[0];
  const limit = parts[1] === undefined ? undefined : Number(parts[1]);
  if (
    !channel ||
    parts.length > 2 ||
    (limit !== undefined &&
      (!Number.isInteger(limit) || limit < 1 || limit > 200))
  ) {
    return invalid(
      "Usage: /slack read <channel> [limit]\nExample: /slack read C0123ABC456 20",
    );
  }
  return operation({ operation: "read-messages", channel, limit });
}

function parseThread(rest: string): SlackCommandIntent {
  const parts = rest.split(/\s+/).filter(Boolean);
  if (parts.length !== 2) {
    return invalid(
      "Usage: /slack thread <channel> <thread_ts>\nExample: /slack thread C0123ABC456 1512085950.000216",
    );
  }
  return operation({
    operation: "read-thread",
    channel: parts[0],
    threadTs: parts[1],
  });
}

function parseMutation(
  verb: string,
  rest: string,
): SlackCommandIntent | undefined {
  if (verb === "dm") {
    if (!rest) return operation({ operation: "list-channels", types: "im" });
    const message = splitHead(rest);
    return message
      ? operation(
          {
            operation: "post-message",
            toUser: message[0],
            text: message[1],
          },
          true,
        )
      : invalid(
          "Usage: /slack dm <user id> <message>\nExample: /slack dm U0123ABC456 hey",
        );
  }
  if (verb === "post" || verb === "send") return parsePost(rest);
  if (verb === "reply") return parseReply(rest);
  if (verb === "edit" || verb === "update") return parseEdit(rest);
  if (verb === "delete" || verb === "remove") return parseDelete(rest);
  if (verb === "react" || verb === "reaction") return parseReaction(rest);
  return undefined;
}

function parsePost(rest: string): SlackCommandIntent {
  const message = splitHead(rest);
  return message
    ? operation(
        {
          operation: "post-message",
          channel: message[0],
          text: message[1],
        },
        true,
      )
    : invalid(
        "Usage: /slack post <channel> <message>\nExample: /slack post C0123ABC456 deploying now",
      );
}

function parseReply(rest: string): SlackCommandIntent {
  const message = splitTwoHeads(rest);
  return message
    ? operation(
        {
          operation: "post-message",
          channel: message[0],
          threadTs: message[1],
          text: message[2],
        },
        true,
      )
    : invalid(
        "Usage: /slack reply <channel> <thread_ts> <message>\nExample: /slack reply C0123ABC456 1512085950.000216 confirmed",
      );
}

function parseEdit(rest: string): SlackCommandIntent {
  const message = splitTwoHeads(rest);
  return message
    ? operation(
        {
          operation: "update-message",
          channel: message[0],
          timestamp: message[1],
          text: message[2],
        },
        true,
      )
    : invalid(
        "Usage: /slack edit <channel> <ts> <new message>\nExample: /slack edit C0123ABC456 1512085950.000216 updated text",
      );
}

function parseDelete(rest: string): SlackCommandIntent {
  const parts = rest.split(/\s+/).filter(Boolean);
  return parts.length === 2
    ? operation(
        {
          operation: "delete-message",
          channel: parts[0],
          timestamp: parts[1],
        },
        true,
      )
    : invalid(
        "Usage: /slack delete <channel> <ts>\nExample: /slack delete C0123ABC456 1512085950.000216",
      );
}

function parseReaction(rest: string): SlackCommandIntent {
  const parts = rest.split(/\s+/).filter(Boolean);
  return parts.length === 3
    ? operation({
        operation: "add-reaction",
        channel: parts[0],
        timestamp: parts[1],
        name: parts[2].replace(/^:|:$/g, ""),
      })
    : invalid(
        "Usage: /slack react <channel> <ts> <emoji>\nExample: /slack react C0123ABC456 1512085950.000216 thumbsup",
      );
}

function parseControl(
  verb: string,
  rest: string,
): SlackCommandIntent | undefined {
  if (verb === "inbox") return parseInbox(rest);
  if (verb === "listen") {
    const action = rest.toLowerCase() || "status";
    return action === "status" || action === "on" || action === "off"
      ? { kind: "listen", action }
      : invalid("Usage: /slack listen status|on|off");
  }
  if (verb === "config") {
    return rest ? invalid("Usage: /slack config") : { kind: "config" };
  }
  if (verb === "confirm") return parseToggle("confirm", rest);
  if (verb === "headless") return parseToggle("headless", rest);
  return undefined;
}

function parseInbox(rest: string): SlackCommandIntent {
  if (rest.toLowerCase() === "clear") return { kind: "inbox", action: "clear" };
  const limit = rest ? Number(rest) : 10;
  return Number.isInteger(limit) && limit >= 1 && limit <= 100
    ? { kind: "inbox", action: "read", limit }
    : invalid("Usage: /slack inbox [1-100|clear]");
}

function parseToggle(
  kind: "confirm" | "headless",
  rest: string,
): SlackCommandIntent {
  const value = rest.toLowerCase();
  if (value !== "on" && value !== "off") {
    return invalid(`Usage: /slack ${kind} on|off`);
  }
  return { kind, enabled: value === "on" };
}

export function parseSlackCommand(args: string): SlackCommandIntent {
  const trimmed = args.trim();
  if (!trimmed) return { kind: "help" };
  const firstSpace = trimmed.indexOf(" ");
  const verb = (
    firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)
  ).toLowerCase();
  const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  return (
    parseDiscovery(verb, rest) ??
    parseMutation(verb, rest) ??
    parseControl(verb, rest) ??
    invalid(
      `Unknown Slack command "${verb}". Run /slack with no arguments for usage.`,
    )
  );
}
