import { SlackApiError } from "./api";
import type { SlackTransport } from "./slack-transport";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

export interface SlackRetryOptions {
  maxAttempts?: number;
}

/** Retry bounded read calls only when Slack says a later attempt can succeed. */
export async function slackGetWithRetry<T>(
  transport: SlackTransport,
  method: string,
  query: Record<string, string | number | undefined>,
  options: SlackRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await transport.get<T>(method, { query });
    } catch (error) {
      const retryable =
        error instanceof SlackApiError &&
        (error.isRateLimited || error.status >= 500);
      if (!retryable || attempt === maxAttempts - 1) throw error;
      const retryDelay = Math.min(
        Math.max(0, error.retryAfter ?? DEFAULT_RETRY_DELAY_MS / 1_000) *
          1_000,
        MAX_RETRY_DELAY_MS,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelay));
    }
  }
  throw new Error(`Slack ${method} retry limit was exhausted.`);
}
