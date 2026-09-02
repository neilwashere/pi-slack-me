// lib/slack-inbox-store.ts
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
var MAX_RETAINED_MESSAGES = 1e3;
var MAX_SEEN_KEYS = 1e3;
var DEFAULT_LEASE_MS = 5 * 6e4;
var STORE_VERSION = 3;
function inboxKey(channelId, timestamp) {
  return `${channelId}:${timestamp}`;
}
function channelWatermarkKey(channelId) {
  return `channel:${channelId}`;
}
function defaultSlackInboxStorePath() {
  const override = process.env.PI_SLACK_INBOX_STORE?.trim();
  if (override) return override;
  const piDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const userToken = process.env.SLACK_USER_TOKEN ?? "";
  const tokenParts = userToken.split("-");
  const stableUserIdentity = tokenParts[0] === "xoxp" && tokenParts[1] && tokenParts[2] ? `${tokenParts[1]}:${tokenParts[2]}` : userToken;
  const credentialHash = createHash("sha256").update(stableUserIdentity).digest("hex").slice(0, 16);
  return join(piDir, `pi-slack-me-inbox-${credentialHash}.json`);
}
function normalizeMatchValue(value) {
  return value.trim().toLowerCase().replace(/^@/, "");
}
var SlackInboxStore = class {
  path;
  now;
  records = /* @__PURE__ */ new Map();
  seenKeys = /* @__PURE__ */ new Set();
  seenKeyOrder = [];
  watermarks = /* @__PURE__ */ new Map();
  threads = /* @__PURE__ */ new Map();
  channels = /* @__PURE__ */ new Map();
  continuations = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    this.path = options.path ?? defaultSlackInboxStorePath();
    this.now = options.now ?? Date.now;
    this.load();
  }
  /**
   * Whether this key was ever admitted, including messages since completed. A
   * cheap pre-check for callers that would otherwise do API work to
   * classify a message add() is about to reject.
   */
  isSeen(key) {
    return this.records.has(key) || this.seenKeys.has(key);
  }
  /**
   * Retain a newly observed message. Returns false when its key has been seen
   * before, which is the caller's signal to skip all downstream notification.
   */
  add(message, options = {}) {
    const key = inboxKey(message.channelId, message.timestamp);
    if (this.records.has(key) || this.seenKeys.has(key)) return false;
    if (this.records.size >= MAX_RETAINED_MESSAGES) {
      throw new Error(
        `Slack inbox is full (${MAX_RETAINED_MESSAGES} unacked messages).`
      );
    }
    return this.commit(() => {
      this.rememberKey(key);
      this.records.set(key, {
        ...message,
        key,
        unread: true,
        deliveryCount: 0
      });
      if (message.channelType) {
        this.channels.set(message.channelId, message.channelType);
      }
      if (options.trackParticipation !== false && (message.threadTimestamp || message.isMention)) {
        this.trackThreadInMemory(
          message.channelId,
          message.threadTimestamp ?? message.timestamp,
          message.timestamp
        );
      }
      return true;
    });
  }
  /**
   * Oldest unread messages, marked read. Acked state is untouched, so a message
   * read here is still pending for an agent.
   */
  readUnread(limit = 10) {
    const bounded = boundedLimit(limit);
    if (bounded === 0) return [];
    const selected = this.sortedRecords().filter((record) => record.unread).slice(0, bounded);
    if (selected.length === 0) return [];
    return this.commit(() => {
      for (const record of selected) record.unread = false;
      return selected.map(toMessage);
    });
  }
  /**
   * Lease the oldest matching unacked messages to an agent. A pulled message
   * stays retained; only ack() removes it. Its lease expires after leaseMs, at
   * which point another pull hands it out again with a higher deliveryCount.
   */
  pull(filter = {}) {
    const bounded = boundedLimit(filter.limit ?? 10);
    if (bounded === 0) return [];
    const now = this.now();
    const leaseMs = Math.max(0, filter.leaseMs ?? DEFAULT_LEASE_MS);
    const fromUsers = filter.fromUsers?.map(normalizeMatchValue);
    const channelIds = filter.channelIds?.map(normalizeMatchValue);
    const selected = this.sortedRecords().filter((record) => {
      if (record.leaseExpiresAt !== void 0 && record.leaseExpiresAt > now) {
        return false;
      }
      if (fromUsers?.length && !fromUsers.includes(normalizeMatchValue(record.userId)) && !fromUsers.includes(normalizeMatchValue(record.userName))) {
        return false;
      }
      if (channelIds?.length && !channelIds.includes(normalizeMatchValue(record.channelId)) && !channelIds.includes(normalizeMatchValue(record.channelName))) {
        return false;
      }
      if (filter.attentionKinds?.length && (record.attentionKind === void 0 || !filter.attentionKinds.includes(record.attentionKind))) {
        return false;
      }
      return true;
    }).slice(0, bounded);
    if (selected.length === 0) return [];
    return this.commit(() => {
      for (const record of selected) {
        record.deliveryCount += 1;
        record.leaseExpiresAt = now + leaseMs;
      }
      return selected.map((record) => ({
        ...toMessage(record),
        key: record.key,
        deliveryCount: record.deliveryCount
      }));
    });
  }
  /** Complete messages by key. Returns how many were actually retained. */
  ack(keys) {
    const retainedKeys = [...new Set(keys)].filter(
      (key) => this.records.has(key)
    );
    if (retainedKeys.length === 0) return 0;
    return this.commit(() => {
      for (const key of retainedKeys) this.records.delete(key);
      return retainedKeys.length;
    });
  }
  /** Drop every retained message. Seen keys survive, so cleared work is not replayed. */
  clear() {
    const count = this.records.size;
    if (count === 0) return 0;
    return this.commit(() => {
      this.records.clear();
      return count;
    });
  }
  counts() {
    let unread = 0;
    for (const record of this.records.values()) {
      if (record.unread) unread += 1;
    }
    return { unread, pending: this.records.size };
  }
  watermark(scope) {
    return this.watermarks.get(scope);
  }
  rememberChannels(channels) {
    const changed = channels.some(
      ({ channelId, channelType }) => this.channels.get(channelId) !== channelType
    );
    if (!changed) return;
    this.commit(() => {
      for (const { channelId, channelType } of channels) {
        this.channels.set(channelId, channelType);
      }
    });
  }
  knownChannels() {
    const channelIds = new Set(this.channels.keys());
    const prefix = "channel:";
    for (const scope of this.watermarks.keys()) {
      if (scope.startsWith(prefix)) channelIds.add(scope.slice(prefix.length));
    }
    return [...channelIds].map((channelId) => ({
      channelId,
      channelType: this.channels.get(channelId),
      timestamp: this.watermarks.get(channelWatermarkKey(channelId))
    }));
  }
  advanceWatermark(scope, timestamp) {
    const current = this.watermarks.get(scope);
    if (current !== void 0 && current >= timestamp) return;
    this.commit(() => this.advanceWatermarkInMemory(scope, timestamp));
  }
  recoveryContinuation(scope) {
    const continuation = this.continuations.get(scope);
    return continuation ? { ...continuation } : void 0;
  }
  saveRecoveryContinuation(scope, continuation) {
    this.commit(
      () => this.continuations.set(scope, { ...continuation })
    );
  }
  completeRecoveryScope(scope, timestamp) {
    this.commit(() => {
      this.advanceWatermarkInMemory(scope, timestamp);
      this.continuations.delete(scope);
    });
  }
  trackedThreads() {
    return [...this.threads.values()].map((thread) => ({ ...thread }));
  }
  tracksThread(channelId, threadTimestamp) {
    return this.threads.has(inboxKey(channelId, threadTimestamp));
  }
  trackThread(channelId, threadTimestamp, latestTimestamp = threadTimestamp, channelType) {
    const key = inboxKey(channelId, threadTimestamp);
    const current = this.threads.get(key);
    const channelKnown = channelType ? this.channels.get(channelId) === channelType : true;
    if (current && current.latestTimestamp >= latestTimestamp && channelKnown) {
      return;
    }
    this.commit(() => {
      this.trackThreadInMemory(channelId, threadTimestamp, latestTimestamp);
      if (channelType) this.channels.set(channelId, channelType);
    });
  }
  observeOwnMessage(channelId, channelType, threadTimestamp, timestamp) {
    this.commit(() => {
      this.channels.set(channelId, channelType);
      this.trackThreadInMemory(channelId, threadTimestamp, timestamp);
    });
  }
  advanceWatermarkInMemory(scope, timestamp) {
    const current = this.watermarks.get(scope);
    if (current === void 0 || current < timestamp) {
      this.watermarks.set(scope, timestamp);
    }
  }
  trackThreadInMemory(channelId, threadTimestamp, latestTimestamp) {
    const key = inboxKey(channelId, threadTimestamp);
    const current = this.threads.get(key);
    if (current && current.latestTimestamp >= latestTimestamp) return;
    this.threads.set(key, { channelId, threadTimestamp, latestTimestamp });
    while (this.threads.size > MAX_SEEN_KEYS) {
      const oldest = this.threads.keys().next().value;
      if (!oldest) return;
      this.threads.delete(oldest);
    }
  }
  sortedRecords() {
    return [...this.records.values()].sort(
      (left, right) => left.timestamp.localeCompare(right.timestamp)
    );
  }
  rememberKey(key) {
    this.seenKeys.add(key);
    this.seenKeyOrder.push(key);
    while (this.seenKeyOrder.length > MAX_SEEN_KEYS) {
      const expired = this.seenKeyOrder.shift();
      if (expired) this.seenKeys.delete(expired);
    }
  }
  /** Restore the in-memory state if an atomic disk update fails. */
  commit(mutation) {
    const recordsBefore = new Map(
      [...this.records].map(([key, record]) => [key, { ...record }])
    );
    const seenBefore = [...this.seenKeyOrder];
    const watermarksBefore = new Map(this.watermarks);
    const threadsBefore = new Map(
      [...this.threads].map(([key, thread]) => [key, { ...thread }])
    );
    const channelsBefore = new Map(this.channels);
    const continuationsBefore = new Map(
      [...this.continuations].map(([scope, continuation]) => [
        scope,
        { ...continuation }
      ])
    );
    try {
      const result = mutation();
      this.persist();
      return result;
    } catch (error) {
      this.records.clear();
      for (const [key, record] of recordsBefore) this.records.set(key, record);
      this.seenKeys.clear();
      this.seenKeyOrder.length = 0;
      for (const key of seenBefore) this.rememberKey(key);
      this.watermarks.clear();
      for (const entry of watermarksBefore) this.watermarks.set(...entry);
      this.threads.clear();
      for (const entry of threadsBefore) this.threads.set(...entry);
      this.channels.clear();
      for (const entry of channelsBefore) this.channels.set(...entry);
      this.continuations.clear();
      for (const entry of continuationsBefore) this.continuations.set(...entry);
      throw error;
    }
  }
  load() {
    if (!existsSync(this.path)) return;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      throw new Error(
        `Slack inbox store is unreadable or corrupt at ${this.path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (parsed?.version !== STORE_VERSION) {
      throw new Error(
        `Slack inbox store at ${this.path} has unsupported version ${String(parsed?.version)}.`
      );
    }
    for (const key of parsed.seenKeys ?? []) {
      if (typeof key === "string") this.rememberKey(key);
    }
    for (const record of parsed.records ?? []) {
      if (typeof record?.key === "string") this.records.set(record.key, record);
    }
    for (const [scope, timestamp] of Object.entries(parsed.watermarks ?? {})) {
      if (typeof timestamp === "string") this.watermarks.set(scope, timestamp);
    }
    for (const [channelId, channelType] of Object.entries(
      parsed.channels ?? {}
    )) {
      if (channelType === "channel" || channelType === "group" || channelType === "im" || channelType === "mpim") {
        this.channels.set(channelId, channelType);
      }
    }
    for (const [scope, continuation] of Object.entries(
      parsed.continuations ?? {}
    )) {
      if (typeof continuation?.floor === "string" && typeof continuation.cutoff === "string" && typeof continuation.latest === "string") {
        this.continuations.set(scope, continuation);
      }
    }
    for (const thread of parsed.trackedThreads ?? []) {
      if (typeof thread?.channelId === "string" && typeof thread.threadTimestamp === "string" && typeof thread.latestTimestamp === "string") {
        this.threads.set(
          inboxKey(thread.channelId, thread.threadTimestamp),
          thread
        );
      }
    }
  }
  persist() {
    const payload = {
      version: STORE_VERSION,
      records: [...this.records.values()],
      seenKeys: [...this.seenKeyOrder],
      watermarks: Object.fromEntries(this.watermarks),
      trackedThreads: [...this.threads.values()],
      channels: Object.fromEntries(this.channels),
      continuations: Object.fromEntries(this.continuations)
    };
    const temporaryPath = `${this.path}.tmp`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 448 });
    writeFileSync(temporaryPath, JSON.stringify(payload), {
      encoding: "utf8",
      mode: 384
    });
    renameSync(temporaryPath, this.path);
  }
};
function boundedLimit(limit) {
  if (!Number.isFinite(limit)) return 10;
  return Math.min(100, Math.max(0, Math.trunc(limit)));
}
function toMessage(record) {
  const {
    key: _key,
    unread: _unread,
    deliveryCount: _deliveryCount,
    leaseExpiresAt: _leaseExpiresAt,
    ...message
  } = record;
  return message;
}

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

// lib/slack-retry.ts
var DEFAULT_MAX_ATTEMPTS = 3;
var DEFAULT_RETRY_DELAY_MS = 1e3;
var MAX_RETRY_DELAY_MS = 3e4;
async function slackGetWithRetry(transport, method, query, options = {}) {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await transport.get(method, { query });
    } catch (error) {
      const retryable = error instanceof SlackApiError && (error.isRateLimited || error.status >= 500);
      if (!retryable || attempt === maxAttempts - 1) throw error;
      const retryDelay = Math.min(
        Math.max(0, error.retryAfter ?? DEFAULT_RETRY_DELAY_MS / 1e3) * 1e3,
        MAX_RETRY_DELAY_MS
      );
      await new Promise((resolve2) => setTimeout(resolve2, retryDelay));
    }
  }
  throw new Error(`Slack ${method} retry limit was exhausted.`);
}

// lib/slack-catch-up.ts
var DEFAULT_LOOKBACK_MS = 24 * 60 * 6e4;
var DEFAULT_MAX_PAGES_PER_SCOPE = 5;
var DEFAULT_MAX_MESSAGES = 200;
var PAGE_SIZE = 100;
var SlackCatchUp = class {
  constructor(options) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.watchedChannels = new Set(options.watchedChannels);
  }
  options;
  now;
  watchedChannels;
  active;
  selfUserId;
  run() {
    if (this.active) return this.active;
    const active = this.perform().finally(() => {
      if (this.active === active) this.active = void 0;
    });
    this.active = active;
    return active;
  }
  async perform() {
    this.assertAvailable();
    const startedAtMs = this.now();
    const cutoff = slackTimestamp(startedAtMs);
    const floor = slackTimestamp(
      startedAtMs - (this.options.lookbackMs ?? DEFAULT_LOOKBACK_MS)
    );
    const result = {
      added: 0,
      scanned: 0,
      scopes: 0,
      truncated: false,
      errors: []
    };
    await this.captureScope(
      result,
      "workspace mentions",
      () => this.catchUpMentions(result, floor, cutoff)
    );
    const channels = /* @__PURE__ */ new Map();
    for (const channel of this.options.store.knownChannels()) {
      channels.set(channel.channelId, {
        channelType: channel.channelType,
        timestamp: channel.timestamp
      });
    }
    for (const channelId of this.watchedChannels) {
      if (!channels.has(channelId)) channels.set(channelId, {});
    }
    await this.captureScope(
      result,
      "direct conversations",
      () => this.discoverDirectConversations(result, channels)
    );
    for (const [channelId, known] of channels) {
      if (this.messageLimitReached(result)) {
        result.truncated = true;
        break;
      }
      await this.captureScope(
        result,
        `conversation ${channelId}`,
        () => this.catchUpChannel(
          result,
          channelId,
          known.channelType ?? inferConversationType(channelId),
          maxTimestamp(known.timestamp, floor),
          cutoff
        )
      );
    }
    for (const thread of this.options.store.trackedThreads()) {
      if (this.messageLimitReached(result)) {
        result.truncated = true;
        break;
      }
      await this.captureScope(
        result,
        `thread ${thread.channelId}:${thread.threadTimestamp}`,
        () => this.catchUpThread(
          result,
          thread.channelId,
          thread.threadTimestamp,
          maxTimestamp(thread.latestTimestamp, floor),
          cutoff
        )
      );
    }
    return {
      ...result,
      startedAt: slackTimestamp(startedAtMs),
      completedAt: slackTimestamp(this.now())
    };
  }
  async captureScope(result, label, work) {
    result.scopes += 1;
    try {
      await work();
    } catch (error) {
      result.errors.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async catchUpMentions(result, lookbackFloor, cutoff) {
    this.assertAvailable();
    const auth = await slackGetWithRetry(
      this.options.transport,
      "auth.test",
      {}
    );
    if (!auth.user_id) throw new Error("Slack auth.test did not return user_id.");
    this.selfUserId = auth.user_id;
    let handle = auth.user;
    if (!handle) {
      const info = await slackGetWithRetry(
        this.options.transport,
        "users.info",
        { user: auth.user_id }
      );
      handle = info.user?.name;
    }
    if (!handle) throw new Error("Slack did not return the current user handle.");
    const floor = maxTimestamp(
      this.options.store.watermark("mentions"),
      lookbackFloor
    );
    const afterDate = searchAfterDate(floor);
    let page = 1;
    let lastProcessed = floor;
    let complete = true;
    const maxPages = this.maxPages();
    while (page <= maxPages) {
      this.assertAvailable();
      const response = await slackGetWithRetry(
        this.options.transport,
        "search.messages",
        {
          query: `@${handle} after:${afterDate}`,
          sort: "timestamp",
          sort_dir: "asc",
          count: PAGE_SIZE,
          page
        }
      );
      const matches = [...response.messages?.matches ?? []].sort(compareTs);
      for (const match of matches) {
        if (!match.ts || match.ts <= floor || match.ts > cutoff) continue;
        const channelId = match.channel?.id;
        const message = ordinaryMessage(
          channelId,
          conversationTypeFromSearch(match),
          match
        );
        if (!message || !message.text.includes(`<@${auth.user_id}>`)) continue;
        if (!this.reserveMessage(result)) {
          complete = false;
          break;
        }
        if (await this.options.ingest(message)) result.added += 1;
        this.assertAvailable();
        this.rememberRecoveredThread(message);
        lastProcessed = maxTimestamp(lastProcessed, message.ts);
      }
      if (!complete) break;
      const paging = response.messages?.paging;
      const pages = paging?.pages ?? page;
      if (page >= pages) break;
      if (page === maxPages) {
        complete = false;
        result.truncated = true;
        break;
      }
      page += 1;
    }
    this.assertAvailable();
    this.options.store.advanceWatermark(
      "mentions",
      complete ? cutoff : lastProcessed
    );
  }
  async discoverDirectConversations(result, channels) {
    let cursor;
    let pages = 0;
    const discovered = [];
    do {
      this.assertAvailable();
      const response = await slackGetWithRetry(
        this.options.transport,
        "users.conversations",
        { types: "im,mpim", limit: PAGE_SIZE, cursor }
      );
      pages += 1;
      for (const channel of response.channels ?? []) {
        if (!channel.id) continue;
        const channelType = channel.is_mpim ? "mpim" : "im";
        channels.set(channel.id, {
          channelType,
          timestamp: this.options.store.watermark(
            channelWatermarkKey(channel.id)
          )
        });
        discovered.push({ channelId: channel.id, channelType });
      }
      cursor = response.response_metadata?.next_cursor || void 0;
      if (cursor && pages >= this.maxPages()) {
        result.truncated = true;
        break;
      }
    } while (cursor);
    this.assertAvailable();
    this.options.store.rememberChannels(discovered);
  }
  async catchUpChannel(result, channelId, channelType, initialFloor, initialCutoff) {
    const scope = channelWatermarkKey(channelId);
    const continuation = this.options.store.recoveryContinuation(scope);
    const floor = continuation?.floor ?? initialFloor;
    const cutoff = continuation?.cutoff ?? initialCutoff;
    let latest = continuation?.latest ?? cutoff;
    let cursor;
    let pages = 0;
    let complete = true;
    do {
      this.assertAvailable();
      const response = await slackGetWithRetry(
        this.options.transport,
        "conversations.history",
        {
          channel: channelId,
          oldest: floor,
          latest,
          inclusive: "false",
          limit: PAGE_SIZE,
          cursor
        }
      );
      pages += 1;
      for (const raw of response.messages ?? []) {
        if (!raw.ts || raw.ts <= floor || raw.ts > cutoff) continue;
        const message = ordinaryMessage(channelId, channelType, raw);
        if (!message) {
          if (raw.ts < latest) latest = raw.ts;
          continue;
        }
        if (!this.reserveMessage(result)) {
          complete = false;
          break;
        }
        if (await this.options.ingest(message)) result.added += 1;
        this.assertAvailable();
        this.rememberRecoveredThread(message);
        if (raw.ts < latest) latest = raw.ts;
      }
      if (!complete) break;
      cursor = response.response_metadata?.next_cursor || void 0;
      if (cursor && pages >= this.maxPages()) {
        complete = false;
        result.truncated = true;
        break;
      }
    } while (cursor);
    this.assertAvailable();
    if (complete) {
      this.options.store.completeRecoveryScope(scope, cutoff);
    } else {
      this.options.store.saveRecoveryContinuation(scope, {
        floor,
        cutoff,
        latest
      });
    }
  }
  async catchUpThread(result, channelId, threadTimestamp, floor, cutoff) {
    let cursor;
    let pages = 0;
    let lastProcessed = floor;
    let complete = true;
    do {
      this.assertAvailable();
      const response = await slackGetWithRetry(
        this.options.transport,
        "conversations.replies",
        {
          channel: channelId,
          ts: threadTimestamp,
          oldest: floor,
          latest: cutoff,
          inclusive: "false",
          limit: PAGE_SIZE,
          cursor
        }
      );
      pages += 1;
      const messages = [...response.messages ?? []].sort(compareTs);
      for (const raw of messages) {
        if (!raw.ts || raw.ts === threadTimestamp || raw.ts <= floor || raw.ts > cutoff) {
          continue;
        }
        const message = ordinaryMessage(
          channelId,
          inferConversationType(channelId),
          { ...raw, thread_ts: threadTimestamp }
        );
        if (!message) {
          lastProcessed = maxTimestamp(lastProcessed, raw.ts);
          continue;
        }
        if (!this.reserveMessage(result)) {
          complete = false;
          break;
        }
        if (await this.options.ingest(message)) result.added += 1;
        this.assertAvailable();
        lastProcessed = maxTimestamp(lastProcessed, raw.ts);
      }
      if (!complete) break;
      cursor = response.response_metadata?.next_cursor || void 0;
      if (cursor && pages >= this.maxPages()) {
        complete = false;
        result.truncated = true;
        break;
      }
    } while (cursor);
    this.assertAvailable();
    if (complete) {
      this.options.store.trackThread(channelId, threadTimestamp, cutoff);
    } else if (lastProcessed > floor) {
      this.options.store.trackThread(
        channelId,
        threadTimestamp,
        lastProcessed
      );
    }
  }
  assertAvailable() {
    if (this.options.isAvailable?.() === false) {
      throw new Error("Slack catch-up stopped because the listener is unavailable.");
    }
  }
  rememberRecoveredThread(message) {
    const wasAuthoredBySelf = message.user === this.selfUserId;
    const mentionsSelf = this.selfUserId !== void 0 && message.text.includes(`<@${this.selfUserId}>`);
    if (!message.thread_ts && !wasAuthoredBySelf && !mentionsSelf) return;
    this.options.store.trackThread(
      message.channel,
      message.thread_ts ?? message.ts,
      message.ts,
      message.channel_type
    );
  }
  reserveMessage(result) {
    if (this.messageLimitReached(result)) {
      result.truncated = true;
      return false;
    }
    result.scanned += 1;
    return true;
  }
  messageLimitReached(result) {
    return result.scanned >= Math.max(1, this.options.maxMessages ?? DEFAULT_MAX_MESSAGES);
  }
  maxPages() {
    return Math.max(
      1,
      this.options.maxPagesPerScope ?? DEFAULT_MAX_PAGES_PER_SCOPE
    );
  }
};
function ordinaryMessage(channelId, channelType, raw) {
  if (!channelId || !raw.user || !raw.text || !raw.ts || raw.bot_id) {
    return void 0;
  }
  if (raw.subtype && raw.subtype !== "thread_broadcast") return void 0;
  return {
    type: "message",
    channel: channelId,
    channel_type: channelType,
    user: raw.user,
    text: raw.text,
    ts: raw.ts,
    thread_ts: raw.thread_ts
  };
}
function conversationTypeFromSearch(match) {
  if (match.channel?.is_im) return "im";
  if (match.channel?.is_mpim) return "mpim";
  if (match.channel?.is_group) return "group";
  return "channel";
}
function inferConversationType(channelId) {
  if (channelId.startsWith("D")) return "im";
  if (channelId.startsWith("G")) return "group";
  return "channel";
}
function compareTs(left, right) {
  return (left.ts ?? "").localeCompare(right.ts ?? "");
}
function maxTimestamp(left, right) {
  return left !== void 0 && left > right ? left : right;
}
function slackTimestamp(epochMs) {
  return (epochMs / 1e3).toFixed(6);
}
function searchAfterDate(timestamp) {
  return new Date(Number.parseFloat(timestamp) * 1e3).toISOString().slice(0, 10);
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
function isOrdinaryMessage(event) {
  if (!event || event.type !== "message") return false;
  if (event.channel_type !== "channel" && event.channel_type !== "group" && event.channel_type !== "im" && event.channel_type !== "mpim") {
    return false;
  }
  if (!event.channel || !event.user) return false;
  if (!event.text || !event.ts) return false;
  if (event.subtype && event.subtype !== "thread_broadcast") return false;
  return !event.bot_id;
}
var SlackEventListener = class {
  socket;
  watchedChannels;
  store;
  directory;
  threadTracker;
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
  lastError;
  constructor(options) {
    this.socket = options.socket;
    this.store = options.store ?? new SlackInboxStore();
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
    const status = {
      state: this.state,
      unread: this.store.counts().unread
    };
    if (this.lastError) status.lastError = this.lastError;
    return status;
  }
  reportExternalError(error) {
    this.reportError(error);
  }
  clearExternalError() {
    if (!this.lastError) return;
    this.lastError = void 0;
    this.emitStatus();
  }
  readInbox(limit = 10) {
    const messages = this.store.readUnread(limit);
    if (messages.length > 0) this.emitStatus();
    return messages;
  }
  /**
   * Lease unacked messages to an agent. Unlike readInbox, this does not
   * complete them: an unacked lease expires and the message is handed out
   * again, so an agent that dies mid-work loses nothing.
   */
  pullInbox(filter) {
    return this.store.pull(filter);
  }
  ackInbox(keys) {
    const acked = this.store.ack(keys);
    if (acked > 0) this.emitStatus();
    return acked;
  }
  clearInbox() {
    const count = this.store.clear();
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
    if (!isOrdinaryMessage(event)) return;
    await this.processMessage(
      event,
      envelope.body?.event_id ?? inboxKey(event.channel, event.ts),
      lifecycle,
      true
    );
  }
  canIngestBackfill() {
    return this.desiredRunning && this.selfUserId !== void 0;
  }
  /** Admit one message recovered through the Web API after an offline gap. */
  ingestBackfill(event) {
    if (!this.desiredRunning) return Promise.resolve(false);
    return this.processMessage(
      event,
      `backfill:${inboxKey(event.channel, event.ts)}`,
      this.lifecycle,
      false
    );
  }
  async processMessage(event, eventId, lifecycle, trackParticipation) {
    const selfUserId = this.selfUserId;
    if (!selfUserId) return false;
    if (event.user === selfUserId) {
      const threadTimestamp = event.thread_ts ?? event.ts;
      this.threadTracker?.mark(event.channel, threadTimestamp);
      if (trackParticipation) {
        this.store.observeOwnMessage(
          event.channel,
          event.channel_type,
          threadTimestamp,
          event.ts
        );
      }
      return false;
    }
    const key = inboxKey(event.channel, event.ts);
    if (this.store.isSeen(key)) return false;
    const disposition = await this.classify(event, selfUserId);
    if (!disposition) return false;
    return this.enqueue({
      event,
      eventId,
      isMention: disposition === "mention",
      attentionKind: disposition === "watched" ? void 0 : disposition,
      lifecycle,
      trackParticipation
    });
  }
  async classify(event, selfUserId) {
    if (event.text.includes(`<@${selfUserId}>`)) {
      this.threadTracker?.mark(event.channel, event.thread_ts ?? event.ts);
      return "mention";
    }
    if (event.channel_type === "im" || event.channel_type === "mpim") {
      return "direct-message";
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
    if (this.store.tracksThread(channel, threadTimestamp)) return true;
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
  async enqueue({
    event,
    eventId,
    isMention,
    attentionKind,
    lifecycle,
    trackParticipation
  }) {
    const [userName, channelName] = await Promise.all([
      this.directory.userName(event.user),
      this.directory.channelName(event.channel)
    ]);
    if (!this.desiredRunning || lifecycle !== this.lifecycle) return false;
    const message = {
      eventId,
      channelId: event.channel,
      channelName,
      channelType: event.channel_type,
      userId: event.user,
      userName,
      text: event.text,
      timestamp: event.ts,
      threadTimestamp: event.thread_ts,
      isMention,
      attentionKind
    };
    if (!this.store.add(message, { trackParticipation })) return false;
    this.emitStatus();
    if (isMention) this.onMention?.(message);
    if (attentionKind) this.onAttention?.(message);
    return true;
  }
  setState(state) {
    this.state = state;
    this.emitStatus();
  }
  emitStatus() {
    this.onStatusChange?.(this.status());
  }
  reportError(error) {
    const message = `Slack Socket Mode: ${sanitizeSocketError(error)}`;
    this.lastError = message;
    this.emitStatus();
    try {
      this.onError?.(message);
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
  getRepliesPage(query) {
    return slackGetWithRetry(
      this.transport,
      "conversations.replies",
      query
    );
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
  const watchedChannels = options.watchedChannels ?? parseWatchedChannels(process.env.SLACK_LISTEN_CHANNELS);
  const store = new SlackInboxStore();
  let previousState = "stopped";
  let catchUp;
  const eventListener = new SlackEventListener({
    socket: createSlackSocketClient(options.appToken),
    store,
    directory,
    threadTracker: createSlackThreadTracker(transport),
    watchedChannels,
    onStatusChange: (status) => {
      emit({ type: "status", status });
      const justConnected = status.state === "connected" && previousState !== "connected";
      previousState = status.state;
      if (justConnected) void runCatchUp();
    },
    onAttention: (message) => emit({ type: "attention", message })
  });
  catchUp = new SlackCatchUp({
    transport,
    store,
    watchedChannels,
    ingest: (message) => eventListener.ingestBackfill(message),
    isAvailable: () => eventListener.canIngestBackfill()
  });
  const runCatchUp = async () => {
    if (!eventListener.canIngestBackfill()) {
      throw new Error(
        "Slack catch-up requires a started listener with an authenticated user."
      );
    }
    const result = await catchUp.run();
    if (result.truncated || result.errors.length > 0) {
      eventListener.reportExternalError(
        new Error(
          `catch-up incomplete (${result.errors.length} error(s), truncated=${String(result.truncated)}).`
        )
      );
    } else {
      eventListener.clearExternalError();
    }
    return result;
  };
  return {
    start: () => eventListener.start(),
    stop: () => eventListener.stop(),
    status: () => eventListener.status(),
    readInbox: (limit) => eventListener.readInbox(limit),
    pullInbox: (filter) => eventListener.pullInbox(filter),
    ackInbox: (keys) => eventListener.ackInbox(keys),
    catchUp: runCatchUp,
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
import { createHash as createHash2 } from "node:crypto";
import { join as join2 } from "node:path";

// lib/slack-sidecar-protocol.ts
var SLACK_SIDECAR_PROTOCOL_VERSION = 2;

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
  const credentialHash = createHash2("sha256").update(credentialIdentity).digest("hex").slice(0, 16);
  const name = `v${SLACK_SIDECAR_PROTOCOL_VERSION}-${credentialHash}`;
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\pi-slack-me-${user}-${name}`;
  }
  return join2("/tmp", `pi-slack-me-${user}`, `${name}.sock`);
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
import { dirname as dirname2, resolve } from "node:path";
import { createServer } from "node:net";
var MAX_REQUEST_BYTES = 1024 * 1024;
var SHARED_TEMP_DIRECTORIES = /* @__PURE__ */ new Set(["/tmp", "/private/tmp"]);
async function prepareSlackSidecarDirectory(socketPath) {
  if (process.platform === "win32") return;
  const socketDirectory = dirname2(socketPath);
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
function normalizedStringList(value, label) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Slack inbox ${label} must be an array of strings.`);
  }
  return value;
}
function normalizedPullFilter(filter) {
  if (filter === void 0) return void 0;
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
    throw new Error("Slack inbox pull filter must be an object.");
  }
  if (filter.leaseMs !== void 0 && (typeof filter.leaseMs !== "number" || !Number.isFinite(filter.leaseMs) || filter.leaseMs < 1e3 || filter.leaseMs > 864e5)) {
    throw new Error(
      "Slack inbox leaseMs must be between 1000 and 86400000 milliseconds."
    );
  }
  const attentionKinds = normalizedStringList(
    filter.attentionKinds,
    "attentionKinds"
  );
  for (const kind of attentionKinds ?? []) {
    if (kind !== "mention" && kind !== "thread-reply" && kind !== "direct-message") {
      throw new Error(
        'Slack inbox attentionKinds accepts only "mention", "thread-reply", and "direct-message".'
      );
    }
  }
  return {
    limit: normalizedInboxLimit(filter.limit),
    fromUsers: normalizedStringList(filter.fromUsers, "fromUsers"),
    channelIds: normalizedStringList(filter.channelIds, "channelIds"),
    attentionKinds,
    leaseMs: filter.leaseMs
  };
}
function normalizedAckKeys(keys) {
  const normalized = normalizedStringList(keys, "ack keys");
  if (!normalized) throw new Error("Slack inbox ack requires keys.");
  return normalized;
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
      case "pull-inbox":
        return this.options.backend.pullInbox(
          normalizedPullFilter(request.filter)
        );
      case "ack-inbox":
        return this.options.backend.ackInbox(normalizedAckKeys(request.keys));
      case "catch-up":
        return this.options.backend.catchUp();
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
