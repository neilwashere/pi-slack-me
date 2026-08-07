// Slack authentication accepts only the user token in SLACK_USER_TOKEN. The
// token is never logged or included in errors.
//
// Creating the token: api.slack.com/apps &rarr; create app &rarr; OAuth & Permissions
// &rarr; User Token Scopes &rarr; Install to workspace &rarr; copy the xoxp- value.
// See README for the full scope list.

export class SlackAuthError extends Error {
  readonly kind: "missing_token";
  constructor() {
    super(
      "Slack: SLACK_USER_TOKEN env var is not set. " +
        "Create a Slack app at https://api.slack.com/apps, add channels:read, " +
        "channels:history, and users:read for public-channel access, then add any " +
        "optional capability scopes listed in the README. Install it to your workspace, " +
        'then `export SLACK_USER_TOKEN="xoxp-..."` in the shell that runs pi.',
    );
    this.name = "SlackAuthError";
    this.kind = "missing_token";
  }
}

export function getSlackToken(): string {
  const token = process.env.SLACK_USER_TOKEN?.trim();
  if (!token) throw new SlackAuthError();
  return token;
}

// True when the env var is present and non-empty. UI/status use only - never
// use this to gate a tool (call getSlackToken inside the tool so the rich
// SlackAuthError surfaces).
export function hasSlackToken(): boolean {
  return Boolean(process.env.SLACK_USER_TOKEN?.trim());
}
