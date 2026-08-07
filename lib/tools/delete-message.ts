import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { toToolResult, type SlackDetails } from "../result";
import {
  createSlackWorkspace,
  type SlackWorkspace,
} from "../slack-workspace";
import { createSlackWriteReviewer } from "../slack-write-review";
import {
  DELETE_MESSAGE_TITLE,
  DELETE_MESSAGE_DESCRIPTION,
  DELETE_MESSAGE_CHANNEL_DESCRIPTION,
  DELETE_MESSAGE_TS_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({
  channel: Type.String({ description: DELETE_MESSAGE_CHANNEL_DESCRIPTION }),
  ts: Type.String({ description: DELETE_MESSAGE_TS_DESCRIPTION }),
});

export function createDeleteMessageTool(
  workspace: SlackWorkspace,
): ToolDefinition<typeof Params, SlackDetails> {
  return {
    name: "slack_delete_message",
    label: DELETE_MESSAGE_TITLE,
    description: DELETE_MESSAGE_DESCRIPTION,
    parameters: Params,
    async execute(
      _toolCallId: string,
      params: Static<typeof Params>,
      signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<SlackDetails>> {
      const result = await workspace.execute(
        {
          operation: "delete-message",
          channel: params.channel,
          timestamp: params.ts,
        },
        {
          signal,
          reviewer: createSlackWriteReviewer(ctx),
        },
      );
      return toToolResult(result.text, result.details);
    },
  };
}

export const deleteMessageTool = createDeleteMessageTool(createSlackWorkspace());
