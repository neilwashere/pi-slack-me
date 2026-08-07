import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { toToolResult, type SlackDetails } from "../result";
import { createSlackWorkspace, type SlackWorkspace } from "../slack-workspace";
import {
  READ_THREAD_TITLE,
  READ_THREAD_DESCRIPTION,
  READ_THREAD_CHANNEL_DESCRIPTION,
  READ_THREAD_TS_DESCRIPTION,
  READ_THREAD_LIMIT_DESCRIPTION,
  READ_THREAD_CURSOR_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({
  channel: Type.String({ description: READ_THREAD_CHANNEL_DESCRIPTION }),
  thread_ts: Type.String({ description: READ_THREAD_TS_DESCRIPTION }),
  limit: Type.Optional(
    Type.Integer({
      description: READ_THREAD_LIMIT_DESCRIPTION,
      minimum: 1,
      maximum: 1000,
    }),
  ),
  cursor: Type.Optional(
    Type.String({ description: READ_THREAD_CURSOR_DESCRIPTION }),
  ),
});

export function createReadThreadTool(
  workspace: SlackWorkspace,
): ToolDefinition<typeof Params, SlackDetails> {
  return {
    name: "slack_read_thread",
    label: READ_THREAD_TITLE,
    description: READ_THREAD_DESCRIPTION,
    parameters: Params,
    async execute(
      _toolCallId: string,
      params: Static<typeof Params>,
      signal,
    ): Promise<AgentToolResult<SlackDetails>> {
      const result = await workspace.execute(
        {
          operation: "read-thread",
          channel: params.channel,
          threadTs: params.thread_ts,
          limit: params.limit,
          cursor: params.cursor,
        },
        { signal },
      );
      return toToolResult(result.text, result.details);
    },
  };
}

export const readThreadTool = createReadThreadTool(createSlackWorkspace());
