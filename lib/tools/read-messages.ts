import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { toToolResult, type SlackDetails } from "../result";
import { createSlackWorkspace, type SlackWorkspace } from "../slack-workspace";
import {
  READ_MESSAGES_TITLE,
  READ_MESSAGES_DESCRIPTION,
  READ_MESSAGES_CHANNEL_DESCRIPTION,
  READ_MESSAGES_LIMIT_DESCRIPTION,
  READ_MESSAGES_OLDEST_DESCRIPTION,
  READ_MESSAGES_LATEST_DESCRIPTION,
  READ_MESSAGES_CURSOR_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({
  channel: Type.String({ description: READ_MESSAGES_CHANNEL_DESCRIPTION }),
  limit: Type.Optional(
    Type.Integer({
      description: READ_MESSAGES_LIMIT_DESCRIPTION,
      minimum: 1,
      maximum: 200,
    }),
  ),
  oldest: Type.Optional(
    Type.String({ description: READ_MESSAGES_OLDEST_DESCRIPTION }),
  ),
  latest: Type.Optional(
    Type.String({ description: READ_MESSAGES_LATEST_DESCRIPTION }),
  ),
  cursor: Type.Optional(
    Type.String({ description: READ_MESSAGES_CURSOR_DESCRIPTION }),
  ),
});

export function createReadMessagesTool(
  workspace: SlackWorkspace,
): ToolDefinition<typeof Params, SlackDetails> {
  return {
    name: "slack_read_messages",
    label: READ_MESSAGES_TITLE,
    description: READ_MESSAGES_DESCRIPTION,
    parameters: Params,
    async execute(
      _toolCallId: string,
      params: Static<typeof Params>,
      signal,
    ): Promise<AgentToolResult<SlackDetails>> {
      const result = await workspace.execute(
        {
          operation: "read-messages",
          channel: params.channel,
          limit: params.limit,
          oldest: params.oldest,
          latest: params.latest,
          cursor: params.cursor,
        },
        { signal },
      );
      return toToolResult(result.text, result.details);
    },
  };
}

export const readMessagesTool = createReadMessagesTool(createSlackWorkspace());
