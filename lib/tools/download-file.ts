import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { toToolResult, type SlackDetails } from "../result";
import {
  createSlackWorkspace,
  type SlackWorkspace,
} from "../slack-workspace";
import {
  DOWNLOAD_FILE_TITLE,
  DOWNLOAD_FILE_DESCRIPTION,
  DOWNLOAD_FILE_ID_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({
  file_id: Type.String({ description: DOWNLOAD_FILE_ID_DESCRIPTION }),
});

export function createDownloadFileTool(
  workspace: SlackWorkspace,
): ToolDefinition<typeof Params, SlackDetails> {
  return {
    name: "slack_download_file",
    label: DOWNLOAD_FILE_TITLE,
    description: DOWNLOAD_FILE_DESCRIPTION,
    parameters: Params,
    async execute(
      _toolCallId: string,
      params: Static<typeof Params>,
      signal,
    ): Promise<AgentToolResult<SlackDetails>> {
      const result = await workspace.execute(
        { operation: "download-file", fileId: params.file_id },
        { signal },
      );
      return toToolResult(result.text, result.details);
    },
  };
}

export const downloadFileTool = createDownloadFileTool(createSlackWorkspace());
