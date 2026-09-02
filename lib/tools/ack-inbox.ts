import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { GlobalSlackInbox } from "../global-slack-inbox";
import { toToolResult, type SlackDetails } from "../result";
import {
  ACK_INBOX_DESCRIPTION,
  ACK_INBOX_KEYS_DESCRIPTION,
  ACK_INBOX_TITLE,
} from "../prompts";

const Params = Type.Object({
  keys: Type.Array(Type.String({ minLength: 1 }), {
    description: ACK_INBOX_KEYS_DESCRIPTION,
    minItems: 1,
  }),
});

export function createAckInboxTool(
  ensureInbox: () => Promise<GlobalSlackInbox | undefined>,
): ToolDefinition<typeof Params, SlackDetails> {
  return {
    name: "slack_ack_inbox",
    label: ACK_INBOX_TITLE,
    description: ACK_INBOX_DESCRIPTION,
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
      const acked = await inbox.ackInbox(params.keys);
      const missing = params.keys.length - acked;
      const missingNote =
        missing > 0
          ? ` ${missing} were already completed or no longer retained.`
          : "";
      return toToolResult(
        `Acked ${acked} of ${params.keys.length} Slack inbox messages.${missingNote}`,
      );
    },
  };
}
