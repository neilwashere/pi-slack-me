import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GlobalSlackInbox } from "./global-slack-inbox";
import type { SlackWorkspace } from "./slack-workspace";
import { createAckInboxTool } from "./tools/ack-inbox";
import { createAddReactionTool } from "./tools/add-reaction";
import { createCatchUpTool } from "./tools/catch-up";
import { createDeleteMessageTool } from "./tools/delete-message";
import { createDownloadFileTool } from "./tools/download-file";
import { createListChannelsTool } from "./tools/list-channels";
import { createPostMessageTool } from "./tools/post-message";
import { createReadInboxTool } from "./tools/read-inbox";
import { createReadMessagesTool } from "./tools/read-messages";
import { createReadThreadTool } from "./tools/read-thread";
import { createSearchTool } from "./tools/search";
import { createUpdateMessageTool } from "./tools/update-message";

export function registerSlackTools(
  pi: ExtensionAPI,
  workspace: SlackWorkspace,
  ensureInbox: () => Promise<GlobalSlackInbox | undefined>,
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
  pi.registerTool(createReadInboxTool(ensureInbox));
  pi.registerTool(createAckInboxTool(ensureInbox));
  pi.registerTool(createCatchUpTool(ensureInbox));
}
