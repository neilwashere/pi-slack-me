import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { toToolResult, type SlackDetails } from "../result";
import { createSlackWorkspace, type SlackWorkspace } from "../slack-workspace";
import {
  ADD_REACTION_CHANNEL_DESCRIPTION,
  ADD_REACTION_DESCRIPTION,
  ADD_REACTION_NAME_DESCRIPTION,
  ADD_REACTION_TIMESTAMP_DESCRIPTION,
  ADD_REACTION_TITLE,
} from "../prompts";

const Params = Type.Object({
  channel: Type.String({
    description: ADD_REACTION_CHANNEL_DESCRIPTION,
    minLength: 1,
  }),
  name: Type.String({
    description: ADD_REACTION_NAME_DESCRIPTION,
    minLength: 1,
  }),
  timestamp: Type.String({
    description: ADD_REACTION_TIMESTAMP_DESCRIPTION,
    minLength: 1,
  }),
});

export function createAddReactionTool(
  workspace: SlackWorkspace,
): ToolDefinition<typeof Params, SlackDetails> {
  return {
    name: "slack_add_reaction",
    label: ADD_REACTION_TITLE,
    description: ADD_REACTION_DESCRIPTION,
    parameters: Params,
    async execute(
      _toolCallId: string,
      params: Static<typeof Params>,
      signal,
    ): Promise<AgentToolResult<SlackDetails>> {
      const result = await workspace.execute(
        {
          operation: "add-reaction",
          channel: params.channel,
          name: params.name,
          timestamp: params.timestamp,
        },
        { signal },
      );
      return toToolResult(result.text, result.details);
    },
  };
}

export const addReactionTool = createAddReactionTool(createSlackWorkspace());
