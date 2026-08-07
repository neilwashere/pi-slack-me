import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { SlackOperationDetails } from "./slack-workspace";

export type SlackDetails = SlackOperationDetails | undefined;

export function toToolResult(
  text: string,
  details?: SlackDetails,
): AgentToolResult<SlackDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function errorText(err: unknown): string {
  if (err instanceof Error) {
    return `Slack error: ${err.message}`;
  }
  return "Slack error: unknown failure.";
}
