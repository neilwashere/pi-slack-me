import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { toToolResult, type SlackDetails } from "../result";
import { createSlackWorkspace, type SlackWorkspace } from "../slack-workspace";
import {
  LIST_CHANNELS_TITLE,
  LIST_CHANNELS_DESCRIPTION,
  LIST_CHANNELS_LIMIT_DESCRIPTION,
  LIST_CHANNELS_TYPES_DESCRIPTION,
  LIST_CHANNELS_CURSOR_DESCRIPTION,
} from "../prompts";

// List conversations the calling user can see. Uses users.conversations (NOT
// conversations.list): with a user token, users.conversations returns
// conversations the calling user is a member of, including DMs and group DMs,
// which is exactly the "what can I read" view this extension promises.
// conversations.list with a user token returns public channels workspace-wide
// (useful, but not the membership view we want as the default discovery tool).
const Params = Type.Object({
  limit: Type.Optional(
    Type.Integer({
      description: LIST_CHANNELS_LIMIT_DESCRIPTION,
      minimum: 1,
      maximum: 999,
    }),
  ),
  types: Type.Optional(
    Type.String({ description: LIST_CHANNELS_TYPES_DESCRIPTION }),
  ),
  cursor: Type.Optional(
    Type.String({ description: LIST_CHANNELS_CURSOR_DESCRIPTION }),
  ),
});

export function createListChannelsTool(
  workspace: SlackWorkspace,
): ToolDefinition<typeof Params, SlackDetails> {
  return {
    name: "slack_list_channels",
    label: LIST_CHANNELS_TITLE,
    description: LIST_CHANNELS_DESCRIPTION,
    parameters: Params,
    async execute(
      _toolCallId: string,
      params: Static<typeof Params>,
      signal,
    ): Promise<AgentToolResult<SlackDetails>> {
      const result = await workspace.execute(
        {
          operation: "list-channels",
          limit: params.limit,
          types: params.types,
          cursor: params.cursor,
        },
        { signal },
      );
      return toToolResult(result.text, result.details);
    },
  };
}

export const listChannelsTool = createListChannelsTool(createSlackWorkspace());
