import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SlackInboxMessage } from "../lib/slack-events";
import {
  channelWatermarkKey,
  defaultSlackInboxStorePath,
  inboxKey,
  SlackInboxStore,
} from "../lib/slack-inbox-store";

let directory: string;
let storePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-slack-store-"));
  storePath = join(directory, "inbox.json");
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.SLACK_APP_TOKEN;
  delete process.env.SLACK_USER_TOKEN;
  rmSync(directory, { recursive: true, force: true });
});

function message(overrides: Partial<SlackInboxMessage> = {}): SlackInboxMessage {
  return {
    eventId: "Ev1",
    channelId: "C1",
    channelName: "triage",
    channelType: "channel",
    userId: "USAM",
    userName: "Sam",
    text: "please look at the failing deploy",
    timestamp: "1786020000.000100",
    isMention: true,
    attentionKind: "mention",
    ...overrides,
  };
}

describe("SlackInboxStore", () => {
  it("rejects a repeat of the same channel and timestamp under a new event id", () => {
    const store = new SlackInboxStore({ path: storePath });

    expect(store.add(message())).toBe(true);
    expect(store.add(message({ eventId: "Ev2" }))).toBe(false);
    expect(store.counts().pending).toBe(1);
  });

  it("still rejects a repeat after the message is acked", () => {
    const store = new SlackInboxStore({ path: storePath });
    store.add(message());
    store.ack([inboxKey("C1", "1786020000.000100")]);

    expect(store.add(message())).toBe(false);
    expect(store.counts().pending).toBe(0);
  });

  it("hides a pulled message until its lease expires, then hands it back", () => {
    let now = 1_000;
    const store = new SlackInboxStore({ path: storePath, now: () => now });
    store.add(message());

    const first = store.pull({ leaseMs: 5_000 });
    expect(first).toHaveLength(1);
    expect(first[0]?.deliveryCount).toBe(1);
    expect(store.pull({ leaseMs: 5_000 })).toEqual([]);

    now += 5_001;
    const second = store.pull({ leaseMs: 5_000 });
    expect(second).toHaveLength(1);
    expect(second[0]?.deliveryCount).toBe(2);
  });

  it("stops handing back a message once it is acked", () => {
    let now = 1_000;
    const store = new SlackInboxStore({ path: storePath, now: () => now });
    store.add(message());
    const [pulled] = store.pull({ leaseMs: 5_000 });

    expect(store.ack([pulled?.key ?? ""])).toBe(1);
    now += 60_000;
    expect(store.pull()).toEqual([]);
    expect(store.counts().pending).toBe(0);
  });

  it("reports keys that were already completed", () => {
    const store = new SlackInboxStore({ path: storePath });
    store.add(message());

    expect(store.ack([inboxKey("C1", "1786020000.000100"), "C9:1.2"])).toBe(1);
  });

  it("keeps unacked messages across a restart", () => {
    const first = new SlackInboxStore({ path: storePath, now: () => 1_000 });
    first.add(message());
    first.pull({ leaseMs: 5_000 });

    const second = new SlackInboxStore({ path: storePath, now: () => 7_000 });
    const recovered = second.pull();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.key).toBe(inboxKey("C1", "1786020000.000100"));
    expect(recovered[0]?.deliveryCount).toBe(2);
  });

  it("does not replay an acked message across a restart", () => {
    const first = new SlackInboxStore({ path: storePath });
    first.add(message());
    first.ack([inboxKey("C1", "1786020000.000100")]);

    const second = new SlackInboxStore({ path: storePath });
    expect(second.pull()).toEqual([]);
    expect(second.add(message())).toBe(false);
  });

  it("leaves a message pending for an agent after a human reads it", () => {
    const store = new SlackInboxStore({ path: storePath });
    store.add(message());

    expect(store.readUnread(10)).toHaveLength(1);
    expect(store.counts()).toEqual({ unread: 0, pending: 1 });
    expect(store.pull()).toHaveLength(1);
  });

  it("leaves a message unread for a human after an agent pulls it", () => {
    const store = new SlackInboxStore({ path: storePath });
    store.add(message());
    store.pull();

    expect(store.counts().unread).toBe(1);
    expect(store.readUnread(10)).toHaveLength(1);
  });

  it("matches a from filter on either user id or display name", () => {
    const store = new SlackInboxStore({ path: storePath });
    store.add(message());
    store.add(
      message({
        eventId: "Ev2",
        userId: "UOTHER",
        userName: "Alex",
        timestamp: "1786020000.000200",
      }),
    );

    expect(store.pull({ fromUsers: ["USAM"], leaseMs: 0 })).toHaveLength(1);
    expect(store.pull({ fromUsers: ["@sam"], leaseMs: 0 })).toHaveLength(1);
    expect(store.pull({ fromUsers: ["nobody"], leaseMs: 0 })).toEqual([]);
  });

  it("filters to a single attention kind", () => {
    const store = new SlackInboxStore({ path: storePath });
    store.add(message());
    store.add(
      message({
        eventId: "Ev2",
        timestamp: "1786020000.000200",
        isMention: false,
        attentionKind: undefined,
      }),
    );

    const mentions = store.pull({ attentionKinds: ["mention"] });
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.attentionKind).toBe("mention");
  });

  it("hands out the oldest messages first", () => {
    const store = new SlackInboxStore({ path: storePath });
    store.add(message({ eventId: "Ev2", timestamp: "1786020000.000200" }));
    store.add(message({ eventId: "Ev1", timestamp: "1786020000.000100" }));

    const pulled = store.pull({ limit: 1 });
    expect(pulled[0]?.timestamp).toBe("1786020000.000100");
  });

  it("records a live channel without claiming its recovery checkpoint is complete", () => {
    const store = new SlackInboxStore({ path: storePath });

    store.add(message());

    expect(store.watermark(channelWatermarkKey("C1"))).toBeUndefined();
    expect(store.watermark("mentions")).toBeUndefined();
    expect(store.knownChannels()).toEqual([
      { channelId: "C1", channelType: "channel", timestamp: undefined },
    ]);
  });

  it("persists channel watermarks and tracked threads after ack", () => {
    const first = new SlackInboxStore({ path: storePath });
    first.add(message());
    first.advanceWatermark(channelWatermarkKey("C1"), "1786020000.000100");
    first.advanceWatermark("mentions", "1786020000.000100");
    first.ack([inboxKey("C1", "1786020000.000100")]);

    const second = new SlackInboxStore({ path: storePath });
    expect(second.watermark(channelWatermarkKey("C1"))).toBe(
      "1786020000.000100",
    );
    expect(second.watermark("mentions")).toBe("1786020000.000100");
    expect(second.trackedThreads()).toEqual([
      {
        channelId: "C1",
        threadTimestamp: "1786020000.000100",
        latestTimestamp: "1786020000.000100",
      },
    ]);
    expect(second.knownChannels()[0]?.channelType).toBe("channel");
  });

  it("persists and atomically completes a recovery continuation", () => {
    const first = new SlackInboxStore({ path: storePath });
    first.saveRecoveryContinuation(channelWatermarkKey("C1"), {
      floor: "1.000000",
      cutoff: "9.000000",
      latest: "5.000000",
    });

    const second = new SlackInboxStore({ path: storePath });
    expect(second.recoveryContinuation(channelWatermarkKey("C1"))).toEqual({
      floor: "1.000000",
      cutoff: "9.000000",
      latest: "5.000000",
    });
    second.completeRecoveryScope(channelWatermarkKey("C1"), "9.000000");

    const third = new SlackInboxStore({ path: storePath });
    expect(third.recoveryContinuation(channelWatermarkKey("C1"))).toBeUndefined();
    expect(third.watermark(channelWatermarkKey("C1"))).toBe("9.000000");
  });

  it("rolls back an add when the durable write fails", () => {
    const blockedParent = join(directory, "not-a-directory");
    writeFileSync(blockedParent, "x");
    const store = new SlackInboxStore({
      path: join(blockedParent, "inbox.json"),
    });

    expect(() => store.add(message())).toThrow();
    expect(store.counts()).toEqual({ unread: 0, pending: 0 });
    expect(store.isSeen(inboxKey("C1", "1786020000.000100"))).toBe(false);
  });

  it("isolates default stores by Slack user identity", () => {
    process.env.PI_CODING_AGENT_DIR = directory;
    process.env.SLACK_APP_TOKEN = "xapp-one";
    process.env.SLACK_USER_TOKEN = "xoxp-111-222-secret-one";
    const first = defaultSlackInboxStorePath();
    process.env.SLACK_USER_TOKEN = "xoxp-111-333-secret-two";
    const second = defaultSlackInboxStorePath();

    expect(first).not.toBe(second);
    expect(first).not.toContain("xapp-one");
    expect(first).not.toContain("secret-one");
    expect(second).not.toContain("secret-two");
  });

  it("keeps the default store through app and user token rotation", () => {
    process.env.PI_CODING_AGENT_DIR = directory;
    process.env.SLACK_APP_TOKEN = "xapp-1-A111-old-secret";
    process.env.SLACK_USER_TOKEN = "xoxe.xoxp-111-222-old-secret";
    const beforeRotation = defaultSlackInboxStorePath();
    process.env.SLACK_APP_TOKEN = "xapp-1-A111-new-secret";
    process.env.SLACK_USER_TOKEN = "xoxe.xoxp-111-222-new-secret";

    expect(defaultSlackInboxStorePath()).toBe(beforeRotation);
  });

  it("does not re-admit a retained record after its tombstone ages out", () => {
    const store = new SlackInboxStore({ path: storePath });
    for (let index = 1; index <= 1_000; index += 1) {
      const suffix = String(index).padStart(6, "0");
      store.add(
        message({
          eventId: `Ev${suffix}`,
          timestamp: `1786020000.${suffix}`,
        }),
      );
    }
    store.ack([inboxKey("C1", "1786020000.001000")]);
    store.add(
      message({ eventId: "EvNew", timestamp: "1786020000.001001" }),
    );

    expect(
      store.add(
        message({ eventId: "EvDuplicate", timestamp: "1786020000.000001" }),
      ),
    ).toBe(false);
    expect(store.counts().pending).toBe(1_000);
  });

  it("adds a tombstone when long-retained work is acknowledged", () => {
    const store = new SlackInboxStore({ path: storePath });
    for (let index = 1; index <= 900; index += 1) {
      const suffix = String(index).padStart(6, "0");
      store.add(message({ timestamp: `1786020000.${suffix}` }));
    }
    for (let index = 901; index <= 1_100; index += 1) {
      const suffix = String(index).padStart(6, "0");
      const key = inboxKey("C1", `1786020000.${suffix}`);
      store.add(message({ timestamp: `1786020000.${suffix}` }));
      store.ack([key]);
    }
    const oldestKey = inboxKey("C1", "1786020000.000001");

    store.ack([oldestKey]);

    expect(store.isSeen(oldestKey)).toBe(true);
    expect(
      store.add(message({ timestamp: "1786020000.000001" })),
    ).toBe(false);
  });

  it("starts empty when the store file does not exist", () => {
    const store = new SlackInboxStore({ path: join(directory, "missing.json") });
    expect(store.counts()).toEqual({ unread: 0, pending: 0 });
  });

  it("quarantines structurally invalid records before they can break reads", () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 3,
        records: [{ key: "C1:1", channelId: "C1" }],
        seenKeys: [],
        watermarks: {},
        trackedThreads: [],
        channels: {},
        continuations: {},
      }),
    );

    const store = new SlackInboxStore({ path: storePath, now: () => 1234 });

    expect(store.pull()).toEqual([]);
    expect(store.startupNotice()).toContain("invalid version 3 data structure");
  });

  it("disables durability explicitly when quarantine cannot rename the file", () => {
    writeFileSync(storePath, "{not-json");
    const store = new SlackInboxStore({
      path: storePath,
      renameFile: () => {
        throw new Error("permission denied");
      },
    });

    expect(store.durabilityDisabled()).toBe(true);
    expect(store.startupNotice()).toContain("durable writes are disabled");
    expect(store.add(message())).toBe(true);
    expect(store.counts().pending).toBe(1);
    expect(readFileSync(storePath, "utf8")).toBe("{not-json");
    expect(
      readdirSync(directory).some((name) =>
        name.startsWith("inbox.json.recovery-"),
      ),
    ).toBe(true);
  });

  it("quarantines a corrupt durable store and surfaces a recovery notice", () => {
    writeFileSync(storePath, "{not-json");

    const store = new SlackInboxStore({ path: storePath, now: () => 1234 });

    expect(store.counts()).toEqual({ unread: 0, pending: 0 });
    expect(store.startupNotice()).toContain("unreadable or corrupt");
    const quarantineName = readdirSync(directory).find((name) =>
      name.startsWith("inbox.json.corrupt-1234-"),
    );
    expect(quarantineName).toBeDefined();
    expect(readFileSync(join(directory, quarantineName ?? ""), "utf8")).toBe(
      "{not-json",
    );
    const recoveryLog = readdirSync(directory).find((name) =>
      name.startsWith("inbox.json.recovery-"),
    );
    expect(recoveryLog).toBeDefined();
    expect(readFileSync(join(directory, recoveryLog ?? ""), "utf8")).toContain(
      quarantineName,
    );
  });
});
