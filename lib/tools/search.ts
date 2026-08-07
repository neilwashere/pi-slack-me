import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { toToolResult, type SlackDetails } from "../result";
import { createSlackWorkspace, type SlackWorkspace } from "../slack-workspace";
import {
  SEARCH_TITLE,
  SEARCH_DESCRIPTION,
  SEARCH_QUERY_DESCRIPTION,
  SEARCH_COUNT_DESCRIPTION,
  SEARCH_SORT_DESCRIPTION,
  SEARCH_SORT_DIR_DESCRIPTION,
  SEARCH_PAGE_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({
  query: Type.String({ description: SEARCH_QUERY_DESCRIPTION }),
  count: Type.Optional(
    Type.Integer({
      description: SEARCH_COUNT_DESCRIPTION,
      minimum: 1,
      maximum: 100,
    }),
  ),
  sort: Type.Optional(
    Type.Unsafe<"timestamp" | "score">({
      type: "string",
      enum: ["timestamp", "score"],
      description: SEARCH_SORT_DESCRIPTION,
    }),
  ),
  sort_dir: Type.Optional(
    Type.Unsafe<"asc" | "desc">({
      type: "string",
      enum: ["asc", "desc"],
      description: SEARCH_SORT_DIR_DESCRIPTION,
    }),
  ),
  page: Type.Optional(
    Type.Integer({ description: SEARCH_PAGE_DESCRIPTION, minimum: 1 }),
  ),
});

export function createSearchTool(
  workspace: SlackWorkspace,
): ToolDefinition<typeof Params, SlackDetails> {
  return {
    name: "slack_search",
    label: SEARCH_TITLE,
    description: SEARCH_DESCRIPTION,
    parameters: Params,
    async execute(
      _toolCallId: string,
      params: Static<typeof Params>,
      signal,
    ): Promise<AgentToolResult<SlackDetails>> {
      const result = await workspace.execute(
        {
          operation: "search",
          query: params.query,
          count: params.count,
          sort: params.sort,
          sortDir: params.sort_dir,
          page: params.page,
        },
        { signal },
      );
      return toToolResult(result.text, result.details);
    },
  };
}

export const searchTool = createSearchTool(createSlackWorkspace());
