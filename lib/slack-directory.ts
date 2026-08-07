import { createSlackTransport, type SlackTransport } from "./slack-transport";
import type { SlackChannel, SlackUser } from "./types";

const MAX_DIRECTORY_ENTRIES = 1_000;

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

export interface SlackDirectory {
  selfUserId(signal?: AbortSignal): Promise<string>;
  userName(userId: string, signal?: AbortSignal): Promise<string>;
  channelName(channelId: string, signal?: AbortSignal): Promise<string>;
}

class CachedSlackDirectory implements SlackDirectory {
  private readonly userNames = new Map<string, string>();
  private readonly pendingUserNames = new Map<string, Promise<string>>();
  private readonly channelNames = new Map<string, string>();
  private readonly pendingChannelNames = new Map<string, Promise<string>>();
  private selfUserIdValue?: string;
  private selfUserIdRequest?: Promise<string>;

  constructor(private readonly transport: SlackTransport) {}

  selfUserId(signal?: AbortSignal): Promise<string> {
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

  userName(userId: string, signal?: AbortSignal): Promise<string> {
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

  channelName(channelId: string, signal?: AbortSignal): Promise<string> {
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

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", cancel);
    const cancel = () => {
      cleanup();
      reject(
        signal.reason ??
          new DOMException("The operation was aborted", "AbortError"),
      );
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

export function createSlackDirectory(
  transport: SlackTransport = createSlackTransport(),
): SlackDirectory {
  return new CachedSlackDirectory(transport);
}
