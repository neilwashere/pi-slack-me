import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSlackSidecarLock } from "../lib/slack-sidecar-lock.js";

describe("Slack sidecar process lock", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("elects one owner and permits a replacement after release", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-slack-lock-test-"));
    directories.push(directory);
    const lockPath = join(directory, "sidecar.lock");

    const first = await acquireSlackSidecarLock(lockPath);
    const second = await acquireSlackSidecarLock(lockPath);

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    await first?.release();
    const replacement = await acquireSlackSidecarLock(lockPath);
    expect(replacement).toBeDefined();
    await replacement?.release();
  });

  it("does not steal a newly created lock before its owner writes the token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-slack-lock-test-"));
    directories.push(directory);
    const lockPath = join(directory, "sidecar.lock");
    await writeFile(lockPath, "", { mode: 0o600 });

    const lock = await acquireSlackSidecarLock(lockPath);

    expect(lock).toBeUndefined();
  });

  it("recovers an old lock after its PID is reused without a live socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-slack-lock-test-"));
    directories.push(directory);
    const socketPath = join(directory, "sidecar.sock");
    const lockPath = `${socketPath}.lock`;
    await writeFile(lockPath, `${process.pid}:old-owner\n`, { mode: 0o600 });
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);

    const lock = await acquireSlackSidecarLock(lockPath);

    expect(lock).toBeDefined();
    await lock?.release();
  });

  it("keeps an old lock when its owner socket is reachable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-slack-lock-test-"));
    directories.push(directory);
    const socketPath = join(directory, "sidecar.sock");
    const lockPath = `${socketPath}.lock`;
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await writeFile(lockPath, `${process.pid}:active-owner\n`, {
        mode: 0o600,
      });
      const old = new Date(Date.now() - 10_000);
      await utimes(lockPath, old, old);

      const lock = await acquireSlackSidecarLock(lockPath);

      expect(lock).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not steal a process-only lock from a live owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-slack-lock-test-"));
    directories.push(directory);
    const lockPath = join(directory, "inbox.writer.lock");
    await writeFile(lockPath, `${process.pid}:active-owner\n`, { mode: 0o600 });
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);

    const lock = await acquireSlackSidecarLock(lockPath, {
      probeSocketPath: false,
    });

    expect(lock).toBeUndefined();
  });

  it("recovers a writer lock after PID reuse when its owner socket is gone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-slack-lock-test-"));
    directories.push(directory);
    const socketPath = join(directory, "sidecar.sock");
    const lockPath = join(directory, "inbox.writer.lock");
    await writeFile(
      lockPath,
      `${JSON.stringify({
        processId: process.pid,
        nonce: "old-owner",
        probeSocketPath: socketPath,
      })}\n`,
      { mode: 0o600 },
    );
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);

    const lock = await acquireSlackSidecarLock(lockPath, {
      probeSocketPath: socketPath,
    });

    expect(lock).toBeDefined();
    await lock?.release();
  });

  it("recovers a lock whose owner process no longer exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-slack-lock-test-"));
    directories.push(directory);
    const lockPath = join(directory, "sidecar.lock");
    await writeFile(lockPath, "99999999\n", { mode: 0o600 });

    const lock = await acquireSlackSidecarLock(lockPath);

    expect(lock).toBeDefined();
    await lock?.release();
  });
});
