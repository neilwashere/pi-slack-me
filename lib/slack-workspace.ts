import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, parse } from "node:path";
import {
  slackDownload,
  slackGet,
  slackPost,
  type SlackDownloadOptions,
  type SlackGetOptions,
  type SlackPostOptions,
} from "./api";
import {
  summarizeDeleteMessage,
  summarizePostMessage,
  summarizeUpdateMessage,
} from "./confirm";
import {
  formatChannelList,
  formatDownloadedFile,
  formatMessagesWithNames,
  formatSearchResultsWithNames,
} from "./format";
import type {
  SlackChannel,
  SlackFileInfo,
  SlackMessage,
  SlackSearchResult,
  SlackUser,
} from "./types";
import type { SlackWriteReviewer } from "./slack-write-review";

const MAX_DIRECTORY_ENTRIES = 1_000;

interface ListChannelsOperation {
  operation: "list-channels";
  limit?: number;
  types?: string;
  cursor?: string;
}

interface ReadMessagesOperation {
  operation: "read-messages";
  channel: string;
  limit?: number;
  oldest?: string;
  latest?: string;
  cursor?: string;
}

interface ReadThreadOperation {
  operation: "read-thread";
  channel: string;
  threadTs: string;
  limit?: number;
  cursor?: string;
}

interface SearchOperation {
  operation: "search";
  query: string;
  count?: number;
  sort?: "timestamp" | "score";
  sortDir?: "asc" | "desc";
  page?: number;
}

interface DownloadFileOperation {
  operation: "download-file";
  fileId: string;
}

interface PostMessageOperation {
  operation: "post-message";
  channel?: string;
  toUser?: string;
  text: string;
  threadTs?: string;
}

interface UpdateMessageOperation {
  operation: "update-message";
  channel: string;
  timestamp: string;
  text: string;
}

interface DeleteMessageOperation {
  operation: "delete-message";
  channel: string;
  timestamp: string;
}

interface AddReactionOperation {
  operation: "add-reaction";
  channel: string;
  name: string;
  timestamp: string;
}

export type SlackOperation =
  | ListChannelsOperation
  | ReadMessagesOperation
  | ReadThreadOperation
  | SearchOperation
  | DownloadFileOperation
  | PostMessageOperation
  | UpdateMessageOperation
  | DeleteMessageOperation
  | AddReactionOperation;

export interface SlackOperationDetails {
  operation: SlackOperation["operation"];
  nextCursor?: string;
  page?: number;
  pages?: number;
  total?: number;
  localPath?: string;
  channel?: string;
  timestamp?: string;
  cancelled?: boolean;
}

export interface SlackOperationResult {
  title: string;
  text: string;
  details: SlackOperationDetails;
}

export interface SlackOperationOptions {
  signal?: AbortSignal;
  reviewer?: SlackWriteReviewer;
}

export interface SlackDirectory {
  selfUserId(signal?: AbortSignal): Promise<string>;
  userName(userId: string, signal?: AbortSignal): Promise<string>;
  channelName(channelId: string, signal?: AbortSignal): Promise<string>;
}

export interface SlackWorkspace {
  readonly directory?: SlackDirectory;
  execute(
    request: SlackOperation,
    options?: SlackOperationOptions,
  ): Promise<SlackOperationResult>;
}

export interface SlackTransport {
  get<T>(method: string, options?: SlackGetOptions): Promise<T>;
  post<T>(method: string, options?: SlackPostOptions): Promise<T>;
  download(url: string, options?: SlackDownloadOptions): Promise<ArrayBuffer>;
}

export interface SlackFileStore {
  write(fileName: string, data: ArrayBuffer): Promise<string>;
}

interface ListChannelsResponse {
  ok: boolean;
  channels?: SlackChannel[];
  response_metadata?: { next_cursor?: string };
}

interface ReadMessagesResponse {
  ok: boolean;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

interface UserInfoResponse {
  ok: boolean;
  user?: SlackUser;
}

interface AuthTestResponse {
  ok: boolean;
  user_id?: string;
}

interface ChannelInfoResponse {
  ok: boolean;
  channel?: SlackChannel;
}

interface SearchResponse {
  ok: boolean;
  messages?: SlackSearchResult;
}

interface FileInfoResponse {
  ok: boolean;
  file?: SlackFileInfo;
}

interface ChatPostResponse {
  ok: boolean;
  channel?: string;
  ts?: string;
}

interface OpenConversationResponse {
  ok: boolean;
  channel?: { id?: string };
}

const defaultTransport: SlackTransport = {
  get: slackGet,
  post: slackPost,
  download: slackDownload,
};

const tempDirectory = join(tmpdir(), "pi-slack-me");

const defaultFileStore: SlackFileStore = {
  async write(fileName, data) {
    await mkdir(tempDirectory, { recursive: true });
    const safeName = basename(fileName);
    const parts = parse(safeName);
    const uniqueName = `${parts.name || "file"}-${randomBytes(4).toString("hex")}${parts.ext}`;
    const localPath = join(tempDirectory, uniqueName);
    await writeFile(localPath, Buffer.from(data));
    return localPath;
  },
};

class DefaultSlackWorkspace implements SlackWorkspace {
  readonly directory: SlackDirectory;
  private readonly userNames = new Map<string, string>();
  private readonly pendingUserNames = new Map<string, Promise<string>>();
  private readonly channelNames = new Map<string, string>();
  private readonly pendingChannelNames = new Map<string, Promise<string>>();
  private selfUserIdValue?: string;
  private selfUserIdRequest?: Promise<string>;

  constructor(
    private readonly transport: SlackTransport,
    private readonly fileStore: SlackFileStore,
  ) {
    this.directory = {
      selfUserId: (signal) => this.resolveSelfUserId(signal),
      userName: (userId, signal) => this.resolveUserName(userId, signal),
      channelName: (channelId, signal) =>
        this.resolveChannelName(channelId, signal),
    };
  }

  async execute(
    request: SlackOperation,
    options: SlackOperationOptions = {},
  ): Promise<SlackOperationResult> {
    switch (request.operation) {
      case "list-channels":
        return this.listChannels(request, options);
      case "read-messages":
        return this.readMessages(request, options);
      case "read-thread":
        return this.readThread(request, options);
      case "search":
        return this.search(request, options);
      case "download-file":
        return this.downloadFile(request, options);
      case "post-message":
        return this.postMessage(request, options);
      case "update-message":
        return this.updateMessage(request, options);
      case "delete-message":
        return this.deleteMessage(request, options);
      case "add-reaction":
        return this.addReaction(request, options);
      default:
        throw new Error("Unsupported Slack operation.");
    }
  }

  private async listChannels(
    request: ListChannelsOperation,
    options: SlackOperationOptions,
  ): Promise<SlackOperationResult> {
    const response = await this.transport.get<ListChannelsResponse>(
      "users.conversations",
      {
        query: {
          limit: request.limit ?? 200,
          types: request.types ?? "public_channel",
          cursor: request.cursor,
          exclude_archived: true,
        },
        signal: options.signal,
      },
    );
    const nextCursor = response.response_metadata?.next_cursor || undefined;
    return {
      title: "Slack channels",
      text: formatChannelList(response.channels ?? [], nextCursor),
      details: {
        operation: request.operation,
        nextCursor,
      },
    };
  }

  private async readMessages(
    request: ReadMessagesOperation,
    options: SlackOperationOptions,
  ): Promise<SlackOperationResult> {
    const useInclusive =
      request.oldest !== undefined || request.latest !== undefined;
    const response = await this.transport.get<ReadMessagesResponse>(
      "conversations.history",
      {
        query: {
          channel: request.channel,
          limit: request.limit ?? 50,
          oldest: request.oldest,
          latest: request.latest,
          inclusive: useInclusive ? true : undefined,
          cursor: request.cursor,
        },
        signal: options.signal,
      },
    );
    const messages = response.messages ?? [];
    const names = await this.resolveMessageNames(messages, options.signal);
    const nextCursor = response.response_metadata?.next_cursor || undefined;
    return {
      title: `Messages in ${request.channel}`,
      text: formatMessagesWithNames({
        messages,
        names,
        title: `Messages in ${request.channel}`,
        hasMore: response.has_more,
        nextCursor,
      }),
      details: {
        operation: request.operation,
        nextCursor,
      },
    };
  }

  private async readThread(
    request: ReadThreadOperation,
    options: SlackOperationOptions,
  ): Promise<SlackOperationResult> {
    const response = await this.transport.get<ReadMessagesResponse>(
      "conversations.replies",
      {
        query: {
          channel: request.channel,
          ts: request.threadTs,
          limit: request.limit ?? 100,
          cursor: request.cursor,
        },
        signal: options.signal,
      },
    );
    const messages = response.messages ?? [];
    const names = await this.resolveMessageNames(messages, options.signal);
    const nextCursor = response.response_metadata?.next_cursor || undefined;
    const title = `Thread ${request.threadTs} in ${request.channel}`;
    return {
      title,
      text: formatMessagesWithNames({
        messages,
        names,
        title,
        hasMore: response.has_more,
        nextCursor,
      }),
      details: {
        operation: request.operation,
        nextCursor,
      },
    };
  }

  private async search(
    request: SearchOperation,
    options: SlackOperationOptions,
  ): Promise<SlackOperationResult> {
    const response = await this.transport.get<SearchResponse>("search.messages", {
      query: {
        query: request.query,
        count: request.count ?? 20,
        sort: request.sort,
        sort_dir: request.sortDir,
        page: request.page,
      },
      signal: options.signal,
    });
    const result = response.messages ?? { matches: [], total: 0 };
    const names = await Promise.all(
      result.matches.map((match) =>
        match.user
          ? this.resolveUserName(match.user, options.signal)
          : Promise.resolve(match.username ?? "unknown"),
      ),
    );
    return {
      title: `Slack search: ${request.query}`,
      text: formatSearchResultsWithNames(result, request.query, names),
      details: {
        operation: request.operation,
        page: result.paging?.page,
        pages: result.paging?.pages,
        total: result.total,
      },
    };
  }

  private async downloadFile(
    request: DownloadFileOperation,
    options: SlackOperationOptions,
  ): Promise<SlackOperationResult> {
    const response = await this.transport.get<FileInfoResponse>("files.info", {
      query: { file: request.fileId },
      signal: options.signal,
    });
    const file = response.file;
    if (!file) {
      return {
        title: "Slack file download",
        text: `Slack: no file found with id ${request.fileId}.`,
        details: { operation: request.operation },
      };
    }

    const downloadUrl = file.url_private_download ?? file.url_private;
    if (!downloadUrl) {
      return {
        title: "Slack file download",
        text: `Slack: file ${request.fileId} has no downloadable URL (it may have been removed or is stored externally).`,
        details: { operation: request.operation },
      };
    }

    const data = await this.transport.download(downloadUrl, {
      signal: options.signal,
    });
    const fileName = safeDownloadName(file, request.fileId);
    const localPath = await this.fileStore.write(fileName, data);
    return {
      title: "Slack file download",
      text: formatDownloadedFile(file, localPath),
      details: { operation: request.operation, localPath },
    };
  }

  private async postMessage(
    request: PostMessageOperation,
    options: SlackOperationOptions,
  ): Promise<SlackOperationResult> {
    validatePostTarget(request);
    const reviewer = requireReviewer(options);
    const decision = await reviewer.review({
      title: `Send message to ${request.toUser ? `@${request.toUser}` : request.channel}?`,
      editableText: request.text,
      summary: summarizePostMessage({
        channel: request.channel,
        toUser: request.toUser,
        threadTs: request.threadTs,
        text: request.text,
      }),
    });
    if (!decision.proceed) {
      return cancelledPostResult(request, reviewer.hasUI);
    }

    const channel = await this.resolvePostChannel(request, options.signal);
    const body: Record<string, unknown> = {
      channel,
      text: decision.text ?? request.text,
    };
    if (request.threadTs) body.thread_ts = request.threadTs;
    const response = await this.transport.post<ChatPostResponse>(
      "chat.postMessage",
      { body, signal: options.signal },
    );
    const kind = request.threadTs ? "threaded reply" : "message";
    const target = request.toUser ? `@${request.toUser} (DM ${channel})` : channel;
    return {
      title: "Slack message",
      text: `Slack: ${kind} sent to ${target} (ts: ${response.ts ?? "(unknown)"}).`,
      details: {
        operation: request.operation,
        channel,
        timestamp: response.ts,
      },
    };
  }

  private async resolvePostChannel(
    request: PostMessageOperation,
    signal?: AbortSignal,
  ): Promise<string> {
    if (request.channel) return request.channel;
    const opened = await this.transport.post<OpenConversationResponse>(
      "conversations.open",
      { body: { users: request.toUser }, signal },
    );
    const channel = opened.channel?.id;
    if (!channel) {
      throw new Error(
        `Slack: could not open a DM with user ${request.toUser}. Verify the user ID via slack_list_channels or slack_search.`,
      );
    }
    return channel;
  }

  private async updateMessage(
    request: UpdateMessageOperation,
    options: SlackOperationOptions,
  ): Promise<SlackOperationResult> {
    const reviewer = requireReviewer(options);
    const decision = await reviewer.review({
      title: `Edit message ${request.timestamp} in ${request.channel}?`,
      editableText: request.text,
      summary: summarizeUpdateMessage({
        channel: request.channel,
        ts: request.timestamp,
        text: request.text,
      }),
    });
    if (!decision.proceed) {
      return {
        title: "Slack message edit",
        text: reviewer.hasUI
          ? `Slack: edit cancelled by user. Message ${request.timestamp} was not changed.`
          : "Slack: edit not applied (headless mode; no UI to review). Use /slack headless on to allow unsupervised writes.",
        details: { operation: request.operation, cancelled: true },
      };
    }
    await this.transport.post("chat.update", {
      body: {
        channel: request.channel,
        ts: request.timestamp,
        text: decision.text ?? request.text,
      },
      signal: options.signal,
    });
    return {
      title: "Slack message edit",
      text: `Slack: message ${request.timestamp} updated in ${request.channel}.`,
      details: {
        operation: request.operation,
        channel: request.channel,
        timestamp: request.timestamp,
      },
    };
  }

  private async deleteMessage(
    request: DeleteMessageOperation,
    options: SlackOperationOptions,
  ): Promise<SlackOperationResult> {
    const reviewer = requireReviewer(options);
    const decision = await reviewer.review({
      title: `Delete message ${request.timestamp} in ${request.channel}?`,
      summary: summarizeDeleteMessage({
        channel: request.channel,
        ts: request.timestamp,
      }),
      requireInteractive: true,
    });
    if (!decision.proceed) {
      return {
        title: "Slack message deletion",
        text: `Slack: delete cancelled${reviewer.hasUI ? " by user" : " (no interactive UI to confirm a destructive write)"}. Message ${request.timestamp} was NOT deleted.`,
        details: { operation: request.operation, cancelled: true },
      };
    }
    await this.transport.post("chat.delete", {
      body: { channel: request.channel, ts: request.timestamp },
      signal: options.signal,
    });
    return {
      title: "Slack message deletion",
      text: `Slack: message ${request.timestamp} deleted from ${request.channel} (permanent).`,
      details: {
        operation: request.operation,
        channel: request.channel,
        timestamp: request.timestamp,
      },
    };
  }

  private async addReaction(
    request: AddReactionOperation,
    options: SlackOperationOptions,
  ): Promise<SlackOperationResult> {
    await this.transport.post("reactions.add", {
      body: {
        channel: request.channel,
        name: request.name,
        timestamp: request.timestamp,
      },
      signal: options.signal,
    });
    return {
      title: "Slack reaction",
      text: `Slack: added :${request.name}: reaction to message ${request.timestamp} in ${request.channel}.`,
      details: {
        operation: request.operation,
        channel: request.channel,
        timestamp: request.timestamp,
      },
    };
  }

  private resolveMessageNames(
    messages: SlackMessage[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    return Promise.all(
      messages.map((message) =>
        message.user
          ? this.resolveUserName(message.user, signal)
          : Promise.resolve(message.username ?? "unknown"),
      ),
    );
  }

  private resolveSelfUserId(signal?: AbortSignal): Promise<string> {
    if (this.selfUserIdValue) {
      return withAbort(Promise.resolve(this.selfUserIdValue), signal);
    }
    if (this.selfUserIdRequest) {
      return withAbort(this.selfUserIdRequest, signal);
    }
    const request = this.transport
      .get<AuthTestResponse>("auth.test")
      .then((response) => {
        if (!response.user_id) {
          throw new Error("Slack auth.test did not return user_id.");
        }
        this.selfUserIdValue = response.user_id;
        return response.user_id;
      })
      .finally(() => {
        this.selfUserIdRequest = undefined;
      });
    this.selfUserIdRequest = request;
    return withAbort(request, signal);
  }

  private resolveUserName(
    userId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const cached = this.userNames.get(userId);
    if (cached) return withAbort(Promise.resolve(cached), signal);
    const pending = this.pendingUserNames.get(userId);
    if (pending) return withAbort(pending, signal);

    const request = this.transport
      .get<UserInfoResponse>("users.info", {
        query: { user: userId },
      })
      .then((response) => {
        const user = response.user;
        const name =
          user?.profile?.display_name ||
          user?.profile?.real_name ||
          user?.real_name ||
          user?.name ||
          userId;
        cacheDirectoryValue(this.userNames, userId, name);
        return name;
      })
      .catch(() => {
        cacheDirectoryValue(this.userNames, userId, userId);
        return userId;
      })
      .finally(() => {
        this.pendingUserNames.delete(userId);
      });
    this.pendingUserNames.set(userId, request);
    return withAbort(request, signal);
  }

  private resolveChannelName(
    channelId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const cached = this.channelNames.get(channelId);
    if (cached) return withAbort(Promise.resolve(cached), signal);
    const pending = this.pendingChannelNames.get(channelId);
    if (pending) return withAbort(pending, signal);

    const request = this.transport
      .get<ChannelInfoResponse>("conversations.info", {
        query: { channel: channelId },
      })
      .then((response) => {
        const name = response.channel?.name || channelId;
        cacheDirectoryValue(this.channelNames, channelId, name);
        return name;
      })
      .catch(() => {
        cacheDirectoryValue(this.channelNames, channelId, channelId);
        return channelId;
      })
      .finally(() => {
        this.pendingChannelNames.delete(channelId);
      });
    this.pendingChannelNames.set(channelId, request);
    return withAbort(request, signal);
  }
}

function validatePostTarget(request: PostMessageOperation): void {
  if (request.channel && request.toUser) {
    throw new Error(
      "Slack: provide channel OR to_user, not both. channel posts to a channel/group/DM; to_user opens a DM with that user. Pick one.",
    );
  }
  if (!request.channel && !request.toUser) {
    throw new Error(
      "Slack: provide either channel (a channel/DM/group ID) or to_user (a user ID).",
    );
  }
}

function cancelledPostResult(
  request: PostMessageOperation,
  hasUI: boolean,
): SlackOperationResult {
  return {
    title: "Slack message",
    text: hasUI
      ? "Slack: message cancelled by user. Nothing was sent."
      : "Slack: message not sent (headless mode; no UI to review). Use /slack headless on to allow unsupervised writes.",
    details: { operation: request.operation, cancelled: true },
  };
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", cancel);
    const cancel = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function cacheDirectoryValue(
  cache: Map<string, string>,
  key: string,
  value: string,
): void {
  if (!cache.has(key) && cache.size >= MAX_DIRECTORY_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function requireReviewer(options: SlackOperationOptions): SlackWriteReviewer {
  if (!options.reviewer) {
    throw new Error("Slack writes require a review context.");
  }
  return options.reviewer;
}

function safeDownloadName(file: SlackFileInfo, fallback: string): string {
  const portableName = (file.name ?? fallback).replaceAll("\\", "/");
  const leafName = basename(portableName);
  const cleaned = leafName
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^\.+/, "");
  const safeBase = cleaned || fallback.replace(/[^A-Za-z0-9_-]+/g, "-") || "file";
  if (safeBase.includes(".")) return safeBase;
  const extension = file.filetype?.replace(/[^A-Za-z0-9]+/g, "");
  return extension ? `${safeBase}.${extension}` : safeBase;
}

export function createSlackWorkspace(
  transport: SlackTransport = defaultTransport,
  fileStore: SlackFileStore = defaultFileStore,
): SlackWorkspace {
  return new DefaultSlackWorkspace(transport, fileStore);
}

export function createSlackDirectory(
  transport: SlackTransport = defaultTransport,
): SlackDirectory {
  return new DefaultSlackWorkspace(transport, defaultFileStore).directory;
}
