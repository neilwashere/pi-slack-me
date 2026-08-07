import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { toToolResult, type SlackDetails } from "../result";
import {
  createSlackWorkspace,
  type SlackWorkspace,
} from "../slack-workspace";
import { createSlackWriteReviewer } from "../slack-write-review";
import {
  POST_MESSAGE_TITLE,
  POST_MESSAGE_DESCRIPTION,
  POST_MESSAGE_CHANNEL_DESCRIPTION,
  POST_MESSAGE_TO_USER_DESCRIPTION,
  POST_MESSAGE_TEXT_DESCRIPTION,
  POST_MESSAGE_THREAD_TS_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({
  channel: Type.Optional(Type.String({ description: POST_MESSAGE_CHANNEL_DESCRIPTION })),
  to_user: Type.Optional(Type.String({ description: POST_MESSAGE_TO_USER_DESCRIPTION })),
  text: Type.String({ description: POST_MESSAGE_TEXT_DESCRIPTION, minLength: 1 }),
  thread_ts: Type.Optional(Type.String({ description: POST_MESSAGE_THREAD_TS_DESCRIPTION })),
});

export function createPostMessageTool(
  workspace: SlackWorkspace,
): ToolDefinition<typeof Params, SlackDetails> {
  return {
    name: "slack_post_message",
    label: POST_MESSAGE_TITLE,
    description: POST_MESSAGE_DESCRIPTION,
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
          operation: "post-message",
          channel: params.channel,
          toUser: params.to_user,
          text: params.text,
          threadTs: params.thread_ts,
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

export const postMessageTool = createPostMessageTool(createSlackWorkspace());
