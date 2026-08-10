// lib/auth.ts
var SlackAuthError = class extends Error {
  kind;
  constructor() {
    super(
      'Slack: SLACK_USER_TOKEN env var is not set. Create a Slack app at https://api.slack.com/apps, add channels:read, channels:history, and users:read for public-channel access, then add any optional capability scopes listed in the README. Install it to your workspace, then `export SLACK_USER_TOKEN="xoxp-..."` in the shell that runs pi.'
    );
    this.name = "SlackAuthError";
    this.kind = "missing_token";
  }
};
function getSlackToken() {
  const token = process.env.SLACK_USER_TOKEN?.trim();
  if (!token) throw new SlackAuthError();
  return token;
}

// lib/api.ts
var SLACK_BASE_URL = "https://slack.com/api";
var REQUEST_TIMEOUT_MS = 3e4;
function createRequestAbort(external) {
  const controller = new AbortController();
  let cause;
  const cancel = () => {
    if (cause) return;
    cause = "cancelled";
    controller.abort(external?.reason);
  };
  if (external?.aborted) {
    cancel();
  } else {
    external?.addEventListener("abort", cancel, { once: true });
  }
  const timer = setTimeout(() => {
    if (cause) return;
    cause = "timeout";
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  timer.unref();
  return {
    signal: controller.signal,
    cause: () => cause,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", cancel);
    }
  };
}
var SlackApiError = class extends Error {
  status;
  code;
  retryAfter;
  isRateLimited;
  isAuthError;
  constructor(message, status = 0, code, retryAfter) {
    super(message);
    this.name = "SlackApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.isRateLimited = status === 429 || code === "ratelimited";
    this.isAuthError = status === 401 || code === "invalid_auth" || code === "not_authed" || code === "token_revoked" || code === "token_expired";
  }
};
function buildUrl(method, query) {
  const params = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === void 0 || v === null) continue;
      params.set(k, String(v));
    }
  }
  const queryString = params.toString();
  return `${SLACK_BASE_URL}/${method}${queryString ? `?${queryString}` : ""}`;
}
async function readSlackJson(method, response) {
  if (response.status === 429) {
    const retryAfterRaw = response.headers.get("retry-after");
    const retryAfter = retryAfterRaw ? Number(retryAfterRaw) : void 0;
    throw new SlackApiError(
      `Slack rate limited on ${method}.` + (retryAfter ? ` Retry in ~${retryAfter}s.` : " Retry shortly."),
      response.status,
      "ratelimited",
      retryAfter
    );
  }
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
  }
  if (parsed && parsed.ok === false) {
    throw new SlackApiError(
      friendlyError(method, parsed.error, response.status),
      response.status,
      parsed.error
    );
  }
  if (!response.ok) {
    throw new SlackApiError(
      friendlyStatus(method, response.status),
      response.status
    );
  }
  if (!parsed) {
    throw new SlackApiError(
      `Slack ${method}: invalid JSON response.`,
      response.status
    );
  }
  return parsed;
}
async function requestSlackJson(method, url, init, externalSignal) {
  const abort = createRequestAbort(externalSignal);
  try {
    const response = await fetch(url, { ...init, signal: abort.signal });
    return await readSlackJson(method, response);
  } catch (err) {
    if (err instanceof SlackApiError) throw err;
    throw new SlackApiError(transportError(method, err, abort.cause()));
  } finally {
    abort.dispose();
  }
}
function slackGet(method, options = {}) {
  const token = getSlackToken();
  return requestSlackJson(
    method,
    buildUrl(method, options.query),
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    },
    options.signal
  );
}
function slackPost(method, options = {}) {
  const token = getSlackToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json"
  };
  let body;
  if (options.body !== void 0) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    body = JSON.stringify(options.body);
  }
  return requestSlackJson(
    method,
    buildUrl(method, options.query),
    { method: "POST", headers, body },
    options.signal
  );
}
async function slackDownload(url, options = {}) {
  const token = getSlackToken();
  const abort = createRequestAbort(options.signal);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: abort.signal
    });
    if (!response.ok) {
      throw new SlackApiError(
        `Slack file download failed (HTTP ${response.status}).`,
        response.status
      );
    }
    return await response.arrayBuffer();
  } catch (err) {
    if (err instanceof SlackApiError) throw err;
    throw new SlackApiError(
      transportError("file download", err, abort.cause())
    );
  } finally {
    abort.dispose();
  }
}
function transportError(method, err, cause) {
  if (cause === "cancelled") return `Slack ${method} request cancelled.`;
  const msg = err instanceof Error ? err.message : String(err);
  if (cause === "timeout" || msg.toLowerCase().includes("abort")) {
    return `Slack ${method} timed out after ${REQUEST_TIMEOUT_MS / 1e3}s.`;
  }
  return `Network error reaching Slack (${method}): ${msg}`;
}
function requiredScopeFor(method) {
  if (method.startsWith("chat.")) return "chat:write";
  if (method === "conversations.open") return "im:write";
  if (method === "reactions.add") return "reactions:write";
  return "a required scope";
}
function friendlyError(method, code, status) {
  if (!code) return `Slack ${method} failed (HTTP ${status}).`;
  switch (code) {
    case "not_in_channel":
      return `Slack: not_in_channel. With a user token this means the calling user is not a member of that conversation. Try slack_list_channels to see conversations you can access.`;
    case "channel_not_found":
      return `Slack: channel_not_found. The channel ID is wrong, archived, or not visible to the calling user. Run slack_list_channels to confirm.`;
    case "missing_scope":
      return `Slack: missing_scope. The user token lacks ${requiredScopeFor(method)} for ${method}. Re-install the app with the scopes listed in the README.`;
    case "cant_update_message":
      return `Slack: cant_update_message. Only messages authored by the calling user can be edited with a user token. Verify the message ts is one of your own.`;
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
    case "token_expired":
      return `Slack: ${code}. The SLACK_USER_TOKEN is invalid, revoked, or expired. Re-install the app at https://api.slack.com/apps and update the token.`;
    default:
      return `Slack ${method} failed: ${code}.`;
  }
}
function friendlyStatus(method, status) {
  if (status === 401)
    return `Slack ${method}: unauthorized (HTTP 401). Check SLACK_USER_TOKEN.`;
  if (status === 404)
    return `Slack ${method}: endpoint or resource not found (HTTP 404).`;
  if (status >= 500)
    return `Slack ${method}: server error (HTTP ${status}). Retry; check https://status.slack.com.`;
  return `Slack ${method} failed (HTTP ${status}).`;
}

// lib/slack-transport.ts
var defaultTransport = {
  get: slackGet,
  post: slackPost,
  download: slackDownload
};
function createSlackTransport() {
  return defaultTransport;
}

// lib/slack-directory.ts
var MAX_DIRECTORY_ENTRIES = 1e3;
var CachedSlackDirectory = class {
  constructor(transport) {
    this.transport = transport;
  }
  transport;
  userNames = /* @__PURE__ */ new Map();
  pendingUserNames = /* @__PURE__ */ new Map();
  channelNames = /* @__PURE__ */ new Map();
  pendingChannelNames = /* @__PURE__ */ new Map();
  selfUserIdValue;
  selfUserIdRequest;
  selfUserId(signal) {
    if (this.selfUserIdValue) {
      return withAbort(Promise.resolve(this.selfUserIdValue), signal);
    }
    if (this.selfUserIdRequest) {
      return withAbort(this.selfUserIdRequest, signal);
    }
    const request = this.transport.get("auth.test").then((response) => {
      if (!response.user_id) {
        throw new Error("Slack auth.test did not return user_id.");
      }
      this.selfUserIdValue = response.user_id;
      return response.user_id;
    }).finally(() => {
      this.selfUserIdRequest = void 0;
    });
    this.selfUserIdRequest = request;
    return withAbort(request, signal);
  }
  userName(userId, signal) {
    const cached = this.userNames.get(userId);
    if (cached) return withAbort(Promise.resolve(cached), signal);
    const pending = this.pendingUserNames.get(userId);
    if (pending) return withAbort(pending, signal);
    const request = this.transport.get("users.info", {
      query: { user: userId }
    }).then((response) => {
      const user = response.user;
      const name = user?.profile?.display_name || user?.profile?.real_name || user?.real_name || user?.name || userId;
      cacheDirectoryValue(this.userNames, userId, name);
      return name;
    }).catch(() => {
      cacheDirectoryValue(this.userNames, userId, userId);
      return userId;
    }).finally(() => {
      this.pendingUserNames.delete(userId);
    });
    this.pendingUserNames.set(userId, request);
    return withAbort(request, signal);
  }
  channelName(channelId, signal) {
    const cached = this.channelNames.get(channelId);
    if (cached) return withAbort(Promise.resolve(cached), signal);
    const pending = this.pendingChannelNames.get(channelId);
    if (pending) return withAbort(pending, signal);
    const request = this.transport.get("conversations.info", {
      query: { channel: channelId }
    }).then((response) => {
      const name = response.channel?.name || channelId;
      cacheDirectoryValue(this.channelNames, channelId, name);
      return name;
    }).catch(() => {
      cacheDirectoryValue(this.channelNames, channelId, channelId);
      return channelId;
    }).finally(() => {
      this.pendingChannelNames.delete(channelId);
    });
    this.pendingChannelNames.set(channelId, request);
    return withAbort(request, signal);
  }
};
function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve2, reject) => {
    const cleanup = () => signal.removeEventListener("abort", cancel);
    const cancel = () => {
      cleanup();
      reject(
        signal.reason ?? new DOMException("The operation was aborted", "AbortError")
      );
    };
    signal.addEventListener("abort", cancel, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve2(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}
function cacheDirectoryValue(cache, key, value) {
  if (!cache.has(key) && cache.size >= MAX_DIRECTORY_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== void 0) cache.delete(oldest);
  }
  cache.set(key, value);
}
function createSlackDirectory(transport = createSlackTransport()) {
  return new CachedSlackDirectory(transport);
}

// lib/slack-events.ts
var MAX_INBOX_MESSAGES = 100;
var MAX_SEEN_EVENT_IDS = 1e3;
var INITIAL_RECONNECT_DELAY_MS = 1e3;
var MAX_RECONNECT_DELAY_MS = 3e4;
var MAX_RECONNECT_BACKOFF_STEP = 5;
var SOCKET_START_TIMEOUT_MS = 1e4;
var DISCONNECT_RETRY_DELAY_MS = 1e3;
var STOP_TIMEOUT_MS = 5e3;
async function completionResult(promise) {
  const value = await promise;
  return { timedOut: false, value };
}
async function waitWithTimeout(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      completionResult(promise),
      new Promise((resolve2) => {
        timeout = setTimeout(() => resolve2({ timedOut: true }), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
function sanitizeSocketError(error) {
  const rawMessage = error instanceof Error ? error.message : String(error ?? "");
  const message = rawMessage.trim() ? rawMessage : "connection failed without error details.";
  return message.replace(/\b(?:xapp|xox[a-z]?)-[a-z0-9-]+\b/gi, "[REDACTED]").replace(/\bwss:\/\/\S+/gi, "[REDACTED]");
}
function socketFailure(error) {
  return new Error(sanitizeSocketError(error));
}
function isOrdinaryPublicMessage(event) {
  if (!event) return false;
  if (event.type !== "message" || event.channel_type !== "channel")
    return false;
  if (!event.channel || !event.user) return false;
  if (!event.text || !event.ts) return false;
  if (event.subtype && event.subtype !== "thread_broadcast") return false;
  return !event.bot_id;
}
var SlackEventListener = class {
  socket;
  watchedChannels;
  seenEventIds = /* @__PURE__ */ new Set();
  seenEventOrder = [];
  directory;
  threadTracker;
  inbox = [];
  onStatusChange;
  onMention;
  onAttention;
  onError;
  state = "stopped";
  selfUserId;
  desiredRunning = false;
  lifecycle = 0;
  reconnectBackoffStep = 0;
  connectionErrorReported = false;
  reconnectTimer;
  startPromise;
  stopPromise;
  socketStartPromise;
  constructor(options) {
    this.socket = options.socket;
    this.directory = options.directory ?? createSlackDirectory();
    this.threadTracker = options.threadTracker;
    this.watchedChannels = new Set(options.watchedChannels ?? []);
    this.onStatusChange = options.onStatusChange;
    this.onMention = options.onMention;
    this.onAttention = options.onAttention;
    this.onError = options.onError;
    this.socket.on("message", (payload) => {
      void this.receive(payload).catch((error) => {
        if (this.desiredRunning) this.reportError(error);
      });
    });
    this.socket.on("error", (error) => this.handleConnectionError(error));
    this.socket.on("reconnecting", () => {
      if (this.desiredRunning) this.setState("reconnecting");
    });
    this.socket.on("connected", () => {
      if (!this.desiredRunning) return;
      this.reconnectBackoffStep = 0;
      this.connectionErrorReported = false;
      this.setState("connected");
    });
    this.socket.on("disconnected", () => {
      if (!this.desiredRunning) {
        this.setState("stopped");
        return;
      }
      this.setState("disconnected");
      this.scheduleReconnect();
    });
  }
  start() {
    if (this.stopPromise) {
      return Promise.reject(
        new Error("Slack Socket Mode is still shutting down.")
      );
    }
    if (this.state === "connected" && this.desiredRunning) {
      return Promise.resolve();
    }
    if (this.startPromise) {
      if (this.desiredRunning) return this.startPromise;
      return Promise.reject(
        new Error("Slack Socket Mode is still shutting down.")
      );
    }
    if (this.socketStartPromise) {
      return Promise.reject(
        new Error("Slack Socket Mode is still shutting down.")
      );
    }
    this.desiredRunning = true;
    this.clearReconnectTimer();
    this.reconnectBackoffStep = 0;
    this.connectionErrorReported = false;
    const lifecycle = ++this.lifecycle;
    this.setState("connecting");
    return this.beginConnect(lifecycle);
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    const stopPromise = this.performStop();
    this.stopPromise = stopPromise;
    const clearStopPromise = () => {
      if (this.stopPromise === stopPromise) this.stopPromise = void 0;
    };
    void stopPromise.then(clearStopPromise, clearStopPromise);
    return stopPromise;
  }
  async performStop() {
    if (this.state === "stopped" && !this.startPromise && !this.reconnectTimer) {
      return;
    }
    this.desiredRunning = false;
    this.lifecycle += 1;
    this.clearReconnectTimer();
    const activeSocketStart = this.socketStartPromise;
    let disconnectError;
    const disconnect = async () => {
      try {
        await this.socket.disconnect();
      } catch (error) {
        disconnectError ??= error;
      }
    };
    const firstDisconnect = disconnect();
    const retryDisconnect = (async () => {
      const outcome2 = await waitWithTimeout(
        firstDisconnect,
        DISCONNECT_RETRY_DELAY_MS
      );
      if (outcome2.timedOut) await disconnect();
    })();
    const finalDisconnect = (async () => {
      if (!activeSocketStart) return;
      try {
        await activeSocketStart;
      } catch {
      }
      await disconnect();
    })();
    const cleanup = Promise.all([
      firstDisconnect,
      retryDisconnect,
      finalDisconnect
    ]);
    const outcome = await waitWithTimeout(cleanup, STOP_TIMEOUT_MS);
    this.setState("stopped");
    if (outcome.timedOut) {
      throw new Error("Slack Socket Mode shutdown timed out.");
    }
    if (disconnectError !== void 0) throw disconnectError;
  }
  status() {
    return {
      state: this.state,
      unread: this.inbox.filter((message) => message.unread).length
    };
  }
  readInbox(limit = 10) {
    const boundedLimit = Number.isFinite(limit) ? Math.min(MAX_INBOX_MESSAGES, Math.max(0, Math.trunc(limit))) : 10;
    if (boundedLimit === 0) return [];
    const messages = this.inbox.slice(-boundedLimit);
    for (const message of messages) message.unread = false;
    if (messages.length > 0) this.emitStatus();
    return messages.map(({ unread: _unread, ...message }) => message);
  }
  clearInbox() {
    const count = this.inbox.length;
    this.inbox.length = 0;
    if (count > 0) this.emitStatus();
    return count;
  }
  beginConnect(lifecycle) {
    const startPromise = this.connect(lifecycle);
    this.startPromise = startPromise;
    const clearStartPromise = () => {
      if (this.startPromise === startPromise) this.startPromise = void 0;
    };
    void startPromise.then(clearStartPromise, () => {
      clearStartPromise();
      if (this.desiredRunning && lifecycle === this.lifecycle) {
        this.scheduleReconnect();
      }
    });
    return startPromise;
  }
  async connect(lifecycle) {
    try {
      if (!this.selfUserId) {
        const selfUserId = await this.directory.selfUserId();
        if (!this.desiredRunning || lifecycle !== this.lifecycle) return;
        this.selfUserId = selfUserId;
      }
      if (!this.desiredRunning || lifecycle !== this.lifecycle) return;
      await this.startSocket();
      if (!this.desiredRunning || lifecycle !== this.lifecycle) return;
      this.reconnectBackoffStep = 0;
      this.connectionErrorReported = false;
      this.setState("connected");
    } catch (error) {
      const failure = socketFailure(error);
      if (this.desiredRunning && lifecycle === this.lifecycle) {
        this.handleConnectionError(failure);
      }
      throw failure;
    }
  }
  async startSocket() {
    const socketStart = this.socket.start();
    this.socketStartPromise = socketStart;
    const trackedSocketStart = this.trackSocketStart(socketStart);
    const outcome = await waitWithTimeout(socketStart, SOCKET_START_TIMEOUT_MS);
    if (!outcome.timedOut) return;
    const cleanup = Promise.all([
      trackedSocketStart,
      this.disconnectSocketIgnoringError()
    ]);
    const cleanupOutcome = await waitWithTimeout(cleanup, STOP_TIMEOUT_MS);
    if (cleanupOutcome.timedOut) {
      this.reconnectBackoffStep = MAX_RECONNECT_BACKOFF_STEP;
    }
    throw new Error("connection timed out.");
  }
  async trackSocketStart(socketStart) {
    try {
      await socketStart;
    } catch {
    } finally {
      if (this.socketStartPromise === socketStart) {
        this.socketStartPromise = void 0;
      }
    }
  }
  async disconnectSocketIgnoringError() {
    try {
      await this.socket.disconnect();
    } catch {
    }
  }
  handleConnectionError(error) {
    if (!this.desiredRunning) return;
    this.setState("error");
    if (!this.connectionErrorReported) {
      this.connectionErrorReported = true;
      this.reportError(error);
    }
    this.scheduleReconnect();
  }
  scheduleReconnect() {
    if (!this.desiredRunning) return;
    if (this.reconnectTimer) {
      this.setState("reconnecting");
      return;
    }
    if (this.startPromise) return;
    const lifecycle = this.lifecycle;
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** this.reconnectBackoffStep,
      MAX_RECONNECT_DELAY_MS
    );
    this.reconnectBackoffStep = Math.min(
      this.reconnectBackoffStep + 1,
      MAX_RECONNECT_BACKOFF_STEP
    );
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = void 0;
      if (!this.desiredRunning || lifecycle !== this.lifecycle) return;
      void this.beginConnect(lifecycle).then(
        () => void 0,
        () => void 0
      );
    }, delay);
  }
  clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = void 0;
  }
  async receive(payload) {
    const envelope = payload;
    await this.acknowledge(envelope);
    if (!this.desiredRunning) return;
    const lifecycle = this.lifecycle;
    const event = envelope.event;
    if (!isOrdinaryPublicMessage(event)) return;
    const selfUserId = this.selfUserId;
    if (!selfUserId) return;
    if (event.user === selfUserId) {
      this.threadTracker?.mark(event.channel, event.thread_ts ?? event.ts);
      return;
    }
    const eventId = envelope.body?.event_id ?? `${event.channel}:${event.ts}`;
    if (!this.rememberEvent(eventId)) return;
    const disposition = await this.classify(event, selfUserId);
    if (!disposition) return;
    const attentionKind = disposition === "watched" ? void 0 : disposition;
    await this.enqueue({
      event,
      eventId,
      isMention: disposition === "mention",
      attentionKind,
      lifecycle
    });
  }
  async classify(event, selfUserId) {
    if (event.text.includes(`<@${selfUserId}>`)) {
      this.threadTracker?.mark(event.channel, event.thread_ts ?? event.ts);
      return "mention";
    }
    if (event.thread_ts && await this.participatesInThread(
      event.channel,
      event.thread_ts,
      selfUserId
    )) {
      return "thread-reply";
    }
    return this.watchedChannels.has(event.channel) ? "watched" : void 0;
  }
  async participatesInThread(channel, threadTimestamp, selfUserId) {
    if (!this.threadTracker) return false;
    try {
      return await this.threadTracker.participates(
        channel,
        threadTimestamp,
        selfUserId
      );
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }
  async acknowledge(envelope) {
    try {
      await envelope.ack?.();
    } catch (error) {
      if (this.desiredRunning) this.reportError(error);
    }
  }
  rememberEvent(eventId) {
    if (this.seenEventIds.has(eventId)) return false;
    this.seenEventIds.add(eventId);
    this.seenEventOrder.push(eventId);
    if (this.seenEventOrder.length > MAX_SEEN_EVENT_IDS) {
      const expired = this.seenEventOrder.shift();
      if (expired) this.seenEventIds.delete(expired);
    }
    return true;
  }
  async enqueue({
    event,
    eventId,
    isMention,
    attentionKind,
    lifecycle
  }) {
    const [userName, channelName] = await Promise.all([
      this.directory.userName(event.user),
      this.directory.channelName(event.channel)
    ]);
    if (!this.desiredRunning || lifecycle !== this.lifecycle) return;
    const message = {
      eventId,
      channelId: event.channel,
      channelName,
      userId: event.user,
      userName,
      text: event.text,
      timestamp: event.ts,
      threadTimestamp: event.thread_ts,
      isMention,
      attentionKind,
      unread: true
    };
    this.inbox.push(message);
    this.inbox.sort(
      (left, right) => left.timestamp.localeCompare(right.timestamp)
    );
    if (this.inbox.length > MAX_INBOX_MESSAGES) this.inbox.shift();
    this.emitStatus();
    const { unread: _unread, ...publicMessage } = message;
    if (isMention) this.onMention?.(publicMessage);
    if (attentionKind) this.onAttention?.(publicMessage);
  }
  setState(state) {
    this.state = state;
    this.emitStatus();
  }
  emitStatus() {
    this.onStatusChange?.(this.status());
  }
  reportError(error) {
    try {
      this.onError?.(`Slack Socket Mode: ${sanitizeSocketError(error)}`);
    } catch {
    }
  }
};

// lib/slack-inbox.ts
function parseWatchedChannels(value) {
  if (!value) return [];
  return [
    ...new Set(
      value.split(/[,\s]+/).map((id) => id.trim()).filter(Boolean)
    )
  ];
}

// lib/slack-socket-client.ts
import { LogLevel, SocketModeClient } from "@slack/socket-mode";
var silentSocketLogger = {
  debug: () => void 0,
  info: () => void 0,
  warn: () => void 0,
  error: () => void 0,
  setLevel: () => void 0,
  getLevel: () => LogLevel.ERROR,
  setName: () => void 0
};
function createSlackSocketClient(appToken) {
  return new SocketModeClient({
    appToken,
    logger: silentSocketLogger,
    autoReconnectEnabled: false,
    clientOptions: { retryConfig: { retries: 0 }, timeout: 1e4 }
  });
}

// lib/slack-thread-tracker.ts
var MAX_CACHED_THREADS = 1e3;
var MAX_PAGE_ATTEMPTS = 3;
var DEFAULT_RETRY_DELAY_MS = 1e3;
var MAX_RETRY_DELAY_MS = 3e4;
var CachedSlackThreadTracker = class {
  constructor(transport) {
    this.transport = transport;
  }
  transport;
  markedThreads = /* @__PURE__ */ new Set();
  cache = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  mark(channel, threadTimestamp) {
    this.markedThreads.add(this.threadKey(channel, threadTimestamp));
    this.trim(this.markedThreads);
  }
  participates(channel, threadTimestamp, selfUserId) {
    if (this.markedThreads.has(this.threadKey(channel, threadTimestamp))) {
      return Promise.resolve(true);
    }
    const key = `${selfUserId}:${this.threadKey(channel, threadTimestamp)}`;
    const cached = this.cache.get(key);
    if (cached !== void 0) return Promise.resolve(cached);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const lookup = this.lookup(channel, threadTimestamp, selfUserId).then((participates) => {
      this.cache.set(key, participates);
      this.trim(this.cache);
      return participates;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, lookup);
    return lookup;
  }
  async lookup(channel, threadTimestamp, selfUserId) {
    let cursor;
    const seenCursors = /* @__PURE__ */ new Set();
    while (true) {
      const query = {
        channel,
        ts: threadTimestamp,
        limit: 200
      };
      if (cursor) query.cursor = cursor;
      const response = await this.getRepliesPage(query);
      if (response.messages?.some(
        (message) => message.user === selfUserId || message.text?.includes(`<@${selfUserId}>`) === true
      )) {
        return true;
      }
      const nextCursor = response.response_metadata?.next_cursor || void 0;
      if (!nextCursor || seenCursors.has(nextCursor)) return false;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }
  async getRepliesPage(query) {
    for (let attempt = 0; attempt < MAX_PAGE_ATTEMPTS; attempt += 1) {
      try {
        return await this.transport.get(
          "conversations.replies",
          { query }
        );
      } catch (error) {
        const retryable = error instanceof SlackApiError && (error.isRateLimited || error.status >= 500);
        if (!retryable || attempt === MAX_PAGE_ATTEMPTS - 1) throw error;
        const retryDelay = Math.min(
          Math.max(0, error.retryAfter ?? DEFAULT_RETRY_DELAY_MS / 1e3) * 1e3,
          MAX_RETRY_DELAY_MS
        );
        await new Promise((resolve2) => setTimeout(resolve2, retryDelay));
      }
    }
    throw new Error("Slack thread history retry limit was exhausted.");
  }
  threadKey(channel, threadTimestamp) {
    return `${channel}:${threadTimestamp}`;
  }
  trim(cache) {
    while (cache.size > MAX_CACHED_THREADS) {
      const oldest = cache.keys().next().value;
      if (!oldest) return;
      cache.delete(oldest);
    }
  }
};
function createSlackThreadTracker(transport) {
  return new CachedSlackThreadTracker(transport);
}

// lib/slack-inbox-backend.ts
function createSlackInboxBackend(options) {
  const listeners = /* @__PURE__ */ new Set();
  const transport = createSlackTransport();
  const directory = createSlackDirectory(transport);
  const emit = (event) => {
    for (const listener of listeners) listener(event);
  };
  const eventListener = new SlackEventListener({
    socket: createSlackSocketClient(options.appToken),
    directory,
    threadTracker: createSlackThreadTracker(transport),
    watchedChannels: options.watchedChannels ?? parseWatchedChannels(process.env.SLACK_LISTEN_CHANNELS),
    onStatusChange: (status) => emit({ type: "status", status }),
    onAttention: (message) => emit({ type: "attention", message })
  });
  return {
    start: () => eventListener.start(),
    stop: () => eventListener.stop(),
    status: () => eventListener.status(),
    readInbox: (limit) => eventListener.readInbox(limit),
    clearInbox: () => eventListener.clearInbox(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

// lib/herdr-notifier.ts
import { createConnection } from "node:net";
var REQUEST_TIMEOUT_MS2 = 750;
var MAX_RESPONSE_BYTES = 1024 * 1024;
var requestSequence = 0;
function oneLine(value, limit) {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 1))}\u2026` : normalized;
}
function channelLabel(message) {
  return message.channelName === message.channelId ? message.channelId : `#${message.channelName}`;
}
function sendHerdrRequest(socketPath, method, params) {
  return new Promise((resolve2, reject) => {
    const id = `pi-slack-herdr-${process.pid}-${++requestSequence}`;
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else if (response) resolve2(response);
      else reject(new Error("Herdr returned no response."));
    };
    const timeout = setTimeout(
      () => finish(new Error(`Herdr ${method} request timed out.`)),
      REQUEST_TIMEOUT_MS2
    );
    timeout.unref?.();
    socket.setEncoding("utf8");
    socket.on(
      "connect",
      () => socket.write(`${JSON.stringify({ id, method, params })}
`)
    );
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) {
        finish(new Error("Herdr returned an oversized response."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.id !== id) {
          finish(new Error("Herdr returned a mismatched response."));
        } else if (response.error) {
          finish(
            new Error(response.error.message ?? `Herdr ${method} failed.`)
          );
        } else {
          finish(void 0, response);
        }
      } catch {
        finish(new Error("Herdr returned invalid JSON."));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => finish(new Error("Herdr closed the connection.")));
  });
}
var HerdrNotifier = class {
  async notify(message, clients) {
    const grouped = /* @__PURE__ */ new Map();
    for (const client of clients) {
      if (!client.herdrSocketPath) continue;
      const group = grouped.get(client.herdrSocketPath) ?? [];
      group.push(client);
      grouped.set(client.herdrSocketPath, group);
    }
    if (grouped.size === 0) return;
    const probeResults = await Promise.all(
      [...grouped].map(async ([socketPath, sessionClients]) => {
        try {
          const response = await sendHerdrRequest(
            socketPath,
            "session.snapshot",
            {}
          );
          const snapshot = response.result?.snapshot;
          const focusedPaneId = snapshot?.focused_pane_id;
          const focusedSessionPath = snapshot?.agents?.find(
            (agent) => agent.pane_id === focusedPaneId
          )?.agent_session?.value;
          return {
            socketPath,
            clients: sessionClients,
            focusedPaneId,
            focusedSessionPath
          };
        } catch {
          return void 0;
        }
      })
    );
    const probes = probeResults.filter(
      (probe) => probe !== void 0
    );
    const target = probes.find(
      (probe) => probe.clients.some(
        (client) => client.herdrPaneId === probe.focusedPaneId || client.sessionPath !== void 0 && client.sessionPath === probe.focusedSessionPath
      )
    ) ?? probes[0];
    if (!target) return;
    const title = oneLine(
      `Slack ${message.isMention ? "mention" : "thread reply"} \xB7 ${message.userName} in ${channelLabel(message)}`,
      80
    );
    const body = oneLine(message.text, 240);
    try {
      await sendHerdrRequest(target.socketPath, "notification.show", {
        title,
        body,
        sound: "none"
      });
    } catch {
    }
  }
};

// lib/global-slack-inbox.ts
import { createHash } from "node:crypto";
import { join } from "node:path";

// lib/slack-sidecar-protocol.ts
var SLACK_SIDECAR_PROTOCOL_VERSION = 1;

// lib/global-slack-inbox.ts
var MAX_MESSAGE_BYTES = 20 * 1024 * 1024;
function defaultSlackSidecarSocketPath() {
  const override = process.env.PI_SLACK_SIDECAR_SOCKET?.trim();
  if (override) return override;
  const user = process.getuid?.() ?? process.env.USER ?? "default";
  const credentialIdentity = [
    process.env.SLACK_APP_TOKEN ?? "",
    process.env.SLACK_USER_TOKEN ?? ""
  ].join("\0");
  const credentialHash = createHash("sha256").update(credentialIdentity).digest("hex").slice(0, 16);
  const name = `v${SLACK_SIDECAR_PROTOCOL_VERSION}-${credentialHash}`;
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\pi-slack-me-${user}-${name}`;
  }
  return join("/tmp", `pi-slack-me-${user}`, `${name}.sock`);
}

// lib/slack-sidecar-lock.ts
import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { createConnection as createConnection2 } from "node:net";
var INCOMPLETE_LOCK_GRACE_MS = 5e3;
var SOCKET_PROBE_TIMEOUT_MS = 250;
function processIsAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
function lockProcessId(value) {
  const parsed = Number.parseInt(value.split(":", 1)[0] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : void 0;
}
async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
async function removeIfPresent(path) {
  try {
    await unlink(path);
  } catch {
    return;
  }
}
function socketIsReachable(socketPath) {
  return new Promise((resolve2) => {
    const socket = createConnection2(socketPath);
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve2(reachable);
    };
    const timeout = setTimeout(() => finish(false), SOCKET_PROBE_TIMEOUT_MS);
    timeout.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
async function removeStaleLock(lockPath) {
  let value;
  try {
    value = await readFile(lockPath, "utf8");
  } catch (error) {
    return error.code === "ENOENT";
  }
  const processId = lockProcessId(value);
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  const isRecent = Date.now() - lockStat.mtimeMs < INCOMPLETE_LOCK_GRACE_MS;
  if (processId && processIsAlive(processId)) {
    if (isRecent) return false;
    const socketPath = lockPath.endsWith(".lock") ? lockPath.slice(0, -".lock".length) : void 0;
    if (!socketPath || await socketIsReachable(socketPath)) return false;
  } else if (!processId && isRecent) {
    return false;
  }
  const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    return error.code === "ENOENT";
  }
  await removeIfPresent(stalePath);
  return true;
}
async function acquireSlackSidecarLock(lockPath) {
  const token = `${process.pid}:${randomUUID()}
`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 384);
      try {
        await handle.writeFile(token, "utf8");
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          const current = await readOptional(lockPath);
          if (current === token) await removeIfPresent(lockPath);
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!await removeStaleLock(lockPath)) return void 0;
    }
  }
  return void 0;
}

// lib/slack-sidecar-server.ts
import { chmod, lstat, mkdir, unlink as unlink2 } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createServer } from "node:net";
var MAX_REQUEST_BYTES = 1024 * 1024;
var SHARED_TEMP_DIRECTORIES = /* @__PURE__ */ new Set(["/tmp", "/private/tmp"]);
async function prepareSlackSidecarDirectory(socketPath) {
  if (process.platform === "win32") return;
  const socketDirectory = dirname(socketPath);
  await mkdir(socketDirectory, { recursive: true, mode: 448 });
  const directoryPath = resolve(socketDirectory);
  if (SHARED_TEMP_DIRECTORIES.has(directoryPath)) {
    throw new Error("Slack sidecar socket requires a private directory.");
  }
  const directoryStat = await lstat(directoryPath);
  if (!directoryStat.isDirectory()) {
    throw new Error("Slack sidecar path parent must be a real directory.");
  }
  const userId = process.getuid?.();
  if (userId !== void 0 && directoryStat.uid !== userId) {
    throw new Error(
      "Slack sidecar directory is not owned by the current user."
    );
  }
  await chmod(directoryPath, 448);
}
async function removeSocketFile(socketPath) {
  try {
    await unlink2(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function unsupportedRequest(request) {
  throw new Error(
    `Unsupported Slack sidecar request: ${JSON.stringify(request)}`
  );
}
function normalizedInboxLimit(limit) {
  if (limit === void 0) return void 0;
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new Error("Slack inbox limit must be a finite number.");
  }
  return Math.min(100, Math.max(0, Math.trunc(limit)));
}
var SlackSidecarServer = class {
  constructor(options) {
    this.options = options;
  }
  options;
  clients = /* @__PURE__ */ new Map();
  server;
  unsubscribeBackend;
  idleTimer;
  closing;
  async start() {
    if (this.server) return;
    await prepareSlackSidecarDirectory(this.options.socketPath);
    await removeSocketFile(this.options.socketPath);
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise((resolve2, reject) => {
      server.once("error", reject);
      server.listen(this.options.socketPath, () => {
        server.removeListener("error", reject);
        resolve2();
      });
    });
    await chmod(this.options.socketPath, 384);
    this.unsubscribeBackend = this.options.backend.subscribe((event) => {
      if (event.type === "status") {
        this.broadcastSnapshot({ status: event.status });
        return;
      }
      void this.deliverAttention(event.message);
    });
    try {
      await this.options.backend.start();
    } catch {
    }
    this.scheduleIdleShutdown();
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = this.performClose();
    return this.closing;
  }
  async performClose() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = void 0;
    this.unsubscribeBackend?.();
    this.unsubscribeBackend = void 0;
    try {
      await this.options.backend.stop();
    } catch {
    }
    for (const client of this.clients.values()) client.socket.destroy();
    this.clients.clear();
    const server = this.server;
    this.server = void 0;
    if (server) {
      await new Promise((resolve2) => server.close(() => resolve2()));
    }
    await removeSocketFile(this.options.socketPath);
  }
  accept(socket) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = void 0;
    socket.setEncoding("utf8");
    const client = { socket, buffer: "" };
    this.clients.set(socket, client);
    socket.on("data", (chunk) => this.receive(client, chunk));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      this.clients.delete(socket);
      this.scheduleIdleShutdown();
    });
  }
  receive(client, chunk) {
    client.buffer += chunk;
    if (Buffer.byteLength(client.buffer) > MAX_REQUEST_BYTES) {
      client.socket.destroy();
      return;
    }
    let newline = client.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = client.buffer.slice(0, newline);
      client.buffer = client.buffer.slice(newline + 1);
      if (line) void this.receiveLine(client, line);
      newline = client.buffer.indexOf("\n");
    }
  }
  async receiveLine(client, line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      client.socket.destroy();
      return;
    }
    try {
      const result = await this.handle(client, request);
      this.send(client.socket, {
        kind: "response",
        id: request.id,
        ok: true,
        result
      });
    } catch (error) {
      this.send(client.socket, {
        kind: "response",
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  async handle(client, request) {
    if (request.type === "hello") {
      if (request.protocolVersion !== SLACK_SIDECAR_PROTOCOL_VERSION) {
        throw new Error(
          `Slack inbox protocol mismatch: sidecar=${SLACK_SIDECAR_PROTOCOL_VERSION}, client=${request.protocolVersion}.`
        );
      }
      client.identity = request.identity;
      return this.snapshot();
    }
    if (!client.identity)
      throw new Error("Slack inbox client has not registered.");
    switch (request.type) {
      case "status":
        return this.snapshot();
      case "set-listening":
        if (request.enabled) await this.options.backend.start();
        else await this.options.backend.stop();
        return this.snapshot();
      case "read-inbox": {
        const limit = normalizedInboxLimit(request.limit);
        return limit === 0 ? [] : this.options.backend.readInbox(limit);
      }
      case "clear-inbox":
        return this.options.backend.clearInbox();
      default:
        return unsupportedRequest(request);
    }
  }
  async deliverAttention(message) {
    try {
      await this.options.onAttention?.(message, this.clientIdentities());
    } catch {
    }
  }
  snapshot() {
    return { status: this.options.backend.status() };
  }
  clientIdentities() {
    return [...this.clients.values()].flatMap(
      (client) => client.identity ? [client.identity] : []
    );
  }
  broadcastSnapshot(snapshot) {
    const message = `${JSON.stringify({ kind: "snapshot", snapshot })}
`;
    for (const client of this.clients.values()) {
      if (client.identity && !client.socket.destroyed)
        client.socket.write(message);
    }
  }
  send(socket, response) {
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}
`);
  }
  scheduleIdleShutdown() {
    if (this.clients.size > 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(
      () => void this.close(),
      this.options.idleTimeoutMs ?? 3e4
    );
    this.idleTimer.unref?.();
  }
};

// lib/slack-sidecar-entry.ts
async function run() {
  const socketPath = defaultSlackSidecarSocketPath();
  await prepareSlackSidecarDirectory(socketPath);
  const lock = await acquireSlackSidecarLock(`${socketPath}.lock`);
  if (!lock) return;
  const appToken = process.env.SLACK_APP_TOKEN?.trim();
  if (!appToken) {
    await lock.release();
    throw new Error("SLACK_APP_TOKEN is not configured for Slack Socket Mode.");
  }
  const notifier = new HerdrNotifier();
  const server = new SlackSidecarServer({
    socketPath,
    backend: createSlackInboxBackend({ appToken }),
    onAttention: (message, clients) => notifier.notify(message, clients)
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close();
    await lock.release();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.once("beforeExit", () => void shutdown());
  try {
    await server.start();
  } catch (error) {
    await shutdown();
    throw error;
  }
}
void run().catch(() => {
  process.exitCode = 1;
});
