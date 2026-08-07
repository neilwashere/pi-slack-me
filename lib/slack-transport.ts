import {
  slackDownload,
  slackGet,
  slackPost,
  type SlackDownloadOptions,
  type SlackGetOptions,
  type SlackPostOptions,
} from "./api";

export interface SlackTransport {
  get<T>(method: string, options?: SlackGetOptions): Promise<T>;
  post<T>(method: string, options?: SlackPostOptions): Promise<T>;
  download(url: string, options?: SlackDownloadOptions): Promise<ArrayBuffer>;
}

const defaultTransport: SlackTransport = {
  get: slackGet,
  post: slackPost,
  download: slackDownload,
};

export function createSlackTransport(): SlackTransport {
  return defaultTransport;
}
