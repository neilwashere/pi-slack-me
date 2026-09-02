import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { GlobalSlackInbox } from "../global-slack-inbox";
import { formatInboxBatch } from "../slack-inbox";
import { toToolResult, type SlackDetails } from "../result";
import {
  READ_INBOX_ATTENTION_KINDS_DESCRIPTION,
  READ_INBOX_CHANNEL_IDS_DESCRIPTION,
  READ_INBOX_DESCRIPTION,
  READ_INBOX_FROM_USERS_DESCRIPTION,
  READ_INBOX_LEASE_SECONDS_DESCRIPTION,
  READ_INBOX_LIMIT_DESCRIPTION,
  READ_INBOX_TITLE,
} from "../prompts";

const Params = Type.Object({
  limit: Type.Optional(
    Type.Integer({
      description: READ_INBOX_LIMIT_DESCRIPTION,
      minimum: 1,
      maximum: 100,
    }),
  ),
  from_users: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description: READ_INBOX_FROM_USERS_DESCRIPTION,
    }),
  ),
  channel_ids: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description: READ_INBOX_CHANNEL_IDS_DESCRIPTION,
    }),
  ),
  attention_kinds: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("mention"),
        Type.Literal("thread-reply"),
        Type.Literal("direct-message"),
      ]),
      { description: READ_INBOX_ATTENTION_KINDS_DESCRIPTION },
    ),
  ),
  lease_seconds: Type.Optional(
    Type.Integer({
      description: READ_INBOX_LEASE_SECONDS_DESCRIPTION,
      minimum: 1,
      maximum: 86_400,
    }),
  ),
});

export function createReadInboxTool(
  ensureInbox: () => Promise<GlobalSlackInbox | undefined>,
): ToolDefinition<typeof Params, SlackDetails> {
  return {
    name: "slack_read_inbox",
    label: READ_INBOX_TITLE,
    description: READ_INBOX_DESCRIPTION,
    parameters: Params,
    async execute(
      _toolCallId: string,
      params: Static<typeof Params>,
    ): Promise<AgentToolResult<SlackDetails>> {
      const inbox = await ensureInbox();
      if (!inbox) {
        return toToolResult(
          "Slack inbox is unavailable: SLACK_APP_TOKEN is not configured, so no Socket Mode listener is running.",
        );
      }
      const messages = await inbox.pullInbox({
        limit: params.limit,
        fromUsers: params.from_users,
        channelIds: params.channel_ids,
        attentionKinds: params.attention_kinds,
        leaseMs:
          params.lease_seconds === undefined
            ? undefined
            : params.lease_seconds * 1_000,
      });
      return toToolResult(formatInboxBatch(messages));
    },
  };
}
