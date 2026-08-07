// Compact, line-oriented output keeps Slack payloads readable without placing
// raw response envelopes into agent context.

import type {
  SlackChannel,
  SlackFileInfo,
  SlackMessage,
  SlackSearchResult,
} from "./types";

// channels ---------------------------------------------------------------

export function formatChannelList(
  channels: SlackChannel[],
  nextCursor?: string,
): string {
  if (channels.length === 0) return "No channels found.";

  const lines = channels.map((ch) => {
    const marker = channelMarker(ch);
    const name = ch.is_im ? `DM with ${ch.user ?? "?"}` : ch.name;
    const members =
      typeof ch.num_members === "number" ? ` · ${ch.num_members} members` : "";
    const topic = ch.topic?.value ? ` — ${ch.topic.value}` : "";
    return `${marker} **${name}** (${ch.id})${members}${topic}`;
  });

  const pagination = nextCursor ? `\n\nNext cursor: \`${nextCursor}\`` : "";
  return `**Channels** (${channels.length}):\n\n${lines.join("\n")}${pagination}`;
}

function channelMarker(channel: SlackChannel): string {
  if (channel.is_im) return "✉️";
  if (channel.is_mpim) return "👥";
  if (channel.is_private) return "🔒";
  return "#";
}

// messages ----------------------------------------------------------------

function formatTimestamp(ts: string): string {
  const seconds = Number(ts);
  if (Number.isNaN(seconds)) return ts;
  return new Date(seconds * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

interface MessageFormatOptions {
  messages: SlackMessage[];
  names: string[];
  title: string;
  hasMore?: boolean;
  nextCursor?: string;
}

// names[i] identifies messages[i]; callers resolve names before rendering.
export function formatMessagesWithNames({
  messages,
  names,
  title,
  hasMore,
  nextCursor,
}: MessageFormatOptions): string {
  if (messages.length === 0) return `${title}: no messages found.`;

  const header = `**${title}** (${messages.length}${hasMore ? ", more available" : ""}):`;
  const lines = messages.map((msg, i) => {
    const time = formatTimestamp(msg.ts);
    const author = names[i] ?? msg.username ?? "unknown";
    const thread = msg.reply_count ? ` [${msg.reply_count} replies]` : "";
    const reactions = msg.reactions?.length
      ? ` ${msg.reactions.map((r) => `:${r.name}: ${r.count}`).join(" ")}`
      : "";
    const files = msg.files?.length
      ? `\n  📎 ${msg.files.map((f) => `${f.name} (${f.id})`).join(", ")}`
      : "";
    return `[${time}] **${author}**${thread}: ${msg.text ?? ""}${reactions}${files}`;
  });

  const pagination = nextCursor ? `\n\nNext cursor: \`${nextCursor}\`` : "";
  return `${header}\n\n${lines.join("\n\n")}${pagination}`;
}

// search ------------------------------------------------------------------

export function formatSearchResultsWithNames(
  result: SlackSearchResult,
  query: string,
  names: string[],
): string {
  if (result.matches.length === 0) return `No results found for "${query}".`;

  const header = `**Search results** for "${query}" (${result.matches.length} of ${result.total} total):`;
  const lines = result.matches.map((m, i) => {
    const time = formatTimestamp(m.ts);
    const author = names[i] ?? m.username ?? "unknown";
    const chan = m.channel.name ?? m.channel.id;
    return `[${time}] **${author}** in #${chan}: ${m.text ?? ""}\n  🔗 ${m.permalink}`;
  });

  return `${header}\n\n${lines.join("\n\n")}`;
}

// files -------------------------------------------------------------------

function formatFileSize(bytes?: number): string {
  if (typeof bytes !== "number") return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDownloadedFile(
  info: SlackFileInfo,
  localPath: string,
): string {
  const size = formatFileSize(info.size);
  const isImage = info.mimetype?.startsWith("image/") ?? false;
  const hint = isImage
    ? `\n\n💡 This is an image. Use the \`read\` tool to view it:\n  \`read ${localPath}\``
    : `\n\n📁 Downloaded to: ${localPath}`;
  const link = info.permalink ? `\n  🔗 ${info.permalink}` : "";
  return `📎 **${info.title ?? info.name ?? info.id}** (${info.name ?? "?"})\n  Type: ${info.mimetype ?? info.filetype ?? "?"} · Size: ${size}${link}${hint}`;
}
