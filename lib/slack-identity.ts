import { createHash } from "node:crypto";

/** Stable local identity shared by the sidecar lock and durable inbox path. */
export function slackIdentityHash(
  userToken = process.env.SLACK_USER_TOKEN ?? "",
  appToken = process.env.SLACK_APP_TOKEN ?? "",
): string {
  const normalizedUserToken = userToken.replace(/^xoxe\./, "");
  const userParts = normalizedUserToken.split("-");
  const userIdentity =
    userParts[0] === "xoxp" && userParts[1] && userParts[2]
      ? `${userParts[1]}:${userParts[2]}`
      : normalizedUserToken;
  const appParts = appToken.split("-");
  const appIdentity =
    appParts[0] === "xapp" && appParts[1] && appParts[2]
      ? `${appParts[1]}:${appParts[2]}`
      : appToken;
  return createHash("sha256")
    .update(`${userIdentity}\0${appIdentity}`)
    .digest("hex")
    .slice(0, 16);
}
