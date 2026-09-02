import { Type } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { GlobalSlackInbox } from "../global-slack-inbox";
import { CATCH_UP_DESCRIPTION, CATCH_UP_TITLE } from "../prompts";
import { toToolResult, type SlackDetails } from "../result";

const Params = Type.Object({});

export function createCatchUpTool(
  ensureInbox: () => Promise<GlobalSlackInbox | undefined>,
): ToolDefinition<typeof Params, SlackDetails> {
  return {
    name: "slack_catch_up",
    label: CATCH_UP_TITLE,
    description: CATCH_UP_DESCRIPTION,
    parameters: Params,
    async execute(): Promise<AgentToolResult<SlackDetails>> {
      const inbox = await ensureInbox();
      if (!inbox) {
        return toToolResult(
          "Slack catch-up is unavailable: SLACK_APP_TOKEN is not configured, so no Socket Mode listener is running.",
        );
      }
      const result = await inbox.catchUp();
      return toToolResult(JSON.stringify(result, null, 2));
    },
  };
}
