import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { toToolResult, type SlackDetails } from "../result";
import { createSlackWorkspace, type SlackWorkspace } from "../slack-workspace";
import { createSlackWriteReviewer } from "../slack-write-review";
import {
  UPDATE_MESSAGE_TITLE,
  UPDATE_MESSAGE_DESCRIPTION,
  UPDATE_MESSAGE_CHANNEL_DESCRIPTION,
  UPDATE_MESSAGE_TS_DESCRIPTION,
  UPDATE_MESSAGE_TEXT_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({
  channel: Type.String({ description: UPDATE_MESSAGE_CHANNEL_DESCRIPTION }),
  ts: Type.String({ description: UPDATE_MESSAGE_TS_DESCRIPTION }),
  text: Type.String({
    description: UPDATE_MESSAGE_TEXT_DESCRIPTION,
    minLength: 1,
  }),
});

export function createUpdateMessageTool(
  workspace: SlackWorkspace,
): ToolDefinition<typeof Params, SlackDetails> {
  return {
    name: "slack_update_message",
    label: UPDATE_MESSAGE_TITLE,
    description: UPDATE_MESSAGE_DESCRIPTION,
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
          operation: "update-message",
          channel: params.channel,
          timestamp: params.ts,
          text: params.text,
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

export const updateMessageTool = createUpdateMessageTool(
  createSlackWorkspace(),
);
