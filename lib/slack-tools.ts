import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SlackWorkspace } from "./slack-workspace";
import { createAddReactionTool } from "./tools/add-reaction";
import { createDeleteMessageTool } from "./tools/delete-message";
import { createDownloadFileTool } from "./tools/download-file";
import { createListChannelsTool } from "./tools/list-channels";
import { createPostMessageTool } from "./tools/post-message";
import { createReadMessagesTool } from "./tools/read-messages";
import { createReadThreadTool } from "./tools/read-thread";
import { createSearchTool } from "./tools/search";
import { createUpdateMessageTool } from "./tools/update-message";

export function registerSlackTools(
  pi: ExtensionAPI,
  workspace: SlackWorkspace,
): void {
  pi.registerTool(createListChannelsTool(workspace));
  pi.registerTool(createReadMessagesTool(workspace));
  pi.registerTool(createReadThreadTool(workspace));
  pi.registerTool(createSearchTool(workspace));
  pi.registerTool(createDownloadFileTool(workspace));
  pi.registerTool(createPostMessageTool(workspace));
  pi.registerTool(createUpdateMessageTool(workspace));
  pi.registerTool(createDeleteMessageTool(workspace));
  pi.registerTool(createAddReactionTool(workspace));
}
