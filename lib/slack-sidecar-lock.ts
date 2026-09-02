import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { createConnection } from "node:net";

const INCOMPLETE_LOCK_GRACE_MS = 5_000;
const SOCKET_PROBE_TIMEOUT_MS = 250;

export interface SlackSidecarLock {
  release(): Promise<void>;
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

interface LockMetadata {
  processId?: number;
  probeSocketPath?: string;
}

function lockMetadata(value: string): LockMetadata {
  try {
    const parsed = JSON.parse(value) as {
      processId?: unknown;
      probeSocketPath?: unknown;
    };
    if (typeof parsed !== "object" || parsed === null) {
      throw new TypeError("Legacy lock format.");
    }
    return {
      processId:
        typeof parsed.processId === "number" &&
        Number.isSafeInteger(parsed.processId) &&
        parsed.processId > 0
          ? parsed.processId
          : undefined,
      probeSocketPath:
        typeof parsed.probeSocketPath === "string"
          ? parsed.probeSocketPath
          : undefined,
    };
  } catch {
    const processId = Number.parseInt(value.split(":", 1)[0] ?? "", 10);
    return {
      processId:
        Number.isSafeInteger(processId) && processId > 0
          ? processId
          : undefined,
    };
  }
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    return;
  }
}

function socketIsReachable(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(reachable);
    };
    const timeout = setTimeout(() => finish(false), SOCKET_PROBE_TIMEOUT_MS);
    timeout.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function removeStaleLock(
  lockPath: string,
  fallbackProbeSocketPath: string | false,
): Promise<boolean> {
  let value: string;
  try {
    value = await readFile(lockPath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const metadata = lockMetadata(value);
  const processId = metadata.processId;
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const isRecent = Date.now() - lockStat.mtimeMs < INCOMPLETE_LOCK_GRACE_MS;
  if (processId && processIsAlive(processId)) {
    if (isRecent) return false;
    const socketPath = metadata.probeSocketPath ?? fallbackProbeSocketPath;
    if (socketPath === false || (await socketIsReachable(socketPath))) {
      return false;
    }
  } else if (!processId && isRecent) {
    return false;
  }
  const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  await removeIfPresent(stalePath);
  return true;
}

export async function acquireSlackSidecarLock(
  lockPath: string,
  options: { probeSocketPath?: string | false } = {},
): Promise<SlackSidecarLock | undefined> {
  const defaultProbeSocketPath = lockPath.endsWith(".lock")
    ? lockPath.slice(0, -".lock".length)
    : false;
  const probeSocketPath =
    options.probeSocketPath ?? defaultProbeSocketPath;
  const token = `${JSON.stringify({
    processId: process.pid,
    nonce: randomUUID(),
    probeSocketPath:
      probeSocketPath === false ? undefined : probeSocketPath,
  })}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
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
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await removeStaleLock(lockPath, probeSocketPath))) {
        return undefined;
      }
    }
  }
  return undefined;
}
