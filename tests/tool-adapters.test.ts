import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createAddReactionTool } from "../lib/tools/add-reaction";
import { createDeleteMessageTool } from "../lib/tools/delete-message";
import { createDownloadFileTool } from "../lib/tools/download-file";
import { createListChannelsTool } from "../lib/tools/list-channels";
import { createPostMessageTool } from "../lib/tools/post-message";
import { createReadMessagesTool } from "../lib/tools/read-messages";
import { createReadThreadTool } from "../lib/tools/read-thread";
import { createSearchTool } from "../lib/tools/search";
import { createUpdateMessageTool } from "../lib/tools/update-message";
import type { SlackOperation, SlackWorkspace } from "../lib/slack-workspace";

type AdapterFactory = (workspace: SlackWorkspace) => { execute: unknown };

interface AdapterCase {
  name: string;
  create: AdapterFactory;
  params: Record<string, unknown>;
  operation: SlackOperation;
  reviewed?: boolean;
}

const adapterCases: AdapterCase[] = [
  {
    name: "list channels",
    create: createListChannelsTool,
    params: { limit: 25, types: "im", cursor: "current-page" },
    operation: {
      operation: "list-channels",
      limit: 25,
      types: "im",
      cursor: "current-page",
    },
  },
  {
    name: "read messages",
    create: createReadMessagesTool,
    params: {
      channel: "C123",
      limit: 20,
      oldest: "100.1",
      latest: "200.2",
      cursor: "current-page",
    },
    operation: {
      operation: "read-messages",
      channel: "C123",
      limit: 20,
      oldest: "100.1",
      latest: "200.2",
      cursor: "current-page",
    },
  },
  {
    name: "read thread",
    create: createReadThreadTool,
    params: {
      channel: "C123",
      thread_ts: "100.1",
      limit: 50,
      cursor: "thread-page",
    },
    operation: {
      operation: "read-thread",
      channel: "C123",
      threadTs: "100.1",
      limit: 50,
      cursor: "thread-page",
    },
  },
  {
    name: "search",
    create: createSearchTool,
    params: {
      query: "deploy",
      count: 40,
      sort: "timestamp",
      sort_dir: "asc",
      page: 3,
    },
    operation: {
      operation: "search",
      query: "deploy",
      count: 40,
      sort: "timestamp",
      sortDir: "asc",
      page: 3,
    },
  },
  {
    name: "download file",
    create: createDownloadFileTool,
    params: { file_id: "F123" },
    operation: { operation: "download-file", fileId: "F123" },
  },
  {
    name: "post message",
    create: createPostMessageTool,
    params: { channel: "C123", text: "hello", thread_ts: "99.9" },
    operation: {
      operation: "post-message",
      channel: "C123",
      toUser: undefined,
      text: "hello",
      threadTs: "99.9",
    },
    reviewed: true,
  },
  {
    name: "update message",
    create: createUpdateMessageTool,
    params: { channel: "C123", ts: "100.1", text: "updated" },
    operation: {
      operation: "update-message",
      channel: "C123",
      timestamp: "100.1",
      text: "updated",
    },
    reviewed: true,
  },
  {
    name: "delete message",
    create: createDeleteMessageTool,
    params: { channel: "C123", ts: "100.1" },
    operation: {
      operation: "delete-message",
      channel: "C123",
      timestamp: "100.1",
    },
    reviewed: true,
  },
  {
    name: "add reaction",
    create: createAddReactionTool,
    params: { channel: "C123", name: "thumbsup", timestamp: "100.1" },
    operation: {
      operation: "add-reaction",
      channel: "C123",
      name: "thumbsup",
      timestamp: "100.1",
    },
  },
];

function invokeAdapter(
  tool: { execute: unknown },
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<AgentToolResult<unknown>> {
  const execute = tool.execute as (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: undefined,
    context: { hasUI: boolean; ui: Record<string, unknown> },
  ) => Promise<AgentToolResult<unknown>>;
  return execute("call-id", params, signal, undefined, {
    hasUI: true,
    ui: {},
  });
}

describe("Slack tool adapters", () => {
  it.each(adapterCases)(
    "maps $name to the shared workspace",
    async (testCase) => {
      const operationResult = {
        title: "Slack result",
        text: "Slack operation complete.",
        details: { operation: testCase.operation.operation },
      };
      const workspace: SlackWorkspace = {
        execute: vi.fn().mockResolvedValue(operationResult),
      };
      const signal = new AbortController().signal;

      const result = await invokeAdapter(
        testCase.create(workspace),
        testCase.params,
        signal,
      );

      const expectedOptions = testCase.reviewed
        ? {
            signal,
            reviewer: expect.objectContaining({
              hasUI: true,
              review: expect.any(Function),
            }),
          }
        : { signal };
      expect(workspace.execute).toHaveBeenCalledWith(
        testCase.operation,
        expectedOptions,
      );
      expect(result.content).toEqual([
        { type: "text", text: operationResult.text },
      ]);
      expect(result.details).toEqual(operationResult.details);
    },
  );

  it("declares count and limit parameters as integers", () => {
    const workspace: SlackWorkspace = { execute: vi.fn() };
    const tools = [
      createListChannelsTool(workspace),
      createReadMessagesTool(workspace),
      createReadThreadTool(workspace),
      createSearchTool(workspace),
    ];
    for (const tool of tools) {
      const properties = (
        tool.parameters as unknown as {
          properties: Record<string, { type?: string }>;
        }
      ).properties;
      const numeric = properties.limit ?? properties.count;
      expect(numeric?.type, tool.name).toBe("integer");
    }
  });

  it("declares search ordering as string enums", () => {
    const workspace: SlackWorkspace = { execute: vi.fn() };
    const properties = (
      createSearchTool(workspace).parameters as unknown as {
        properties: Record<string, { type?: string; enum?: string[] }>;
      }
    ).properties;
    expect(properties.sort).toMatchObject({
      type: "string",
      enum: ["timestamp", "score"],
    });
    expect(properties.sort_dir).toMatchObject({
      type: "string",
      enum: ["asc", "desc"],
    });
  });
});
