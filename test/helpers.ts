import { randomUUID } from "node:crypto";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { createDb, type Db, type Sql } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import type { DwarChatRequest, DwarChatResponse } from "../src/types/domain.js";
import type { DwarClient } from "../src/dwar/client.js";
import type {
  IngestRequest,
  IngestResponse,
  NodeResponse,
  QueryRequest,
  QueryResponse,
  RecallResponse,
  YaadClient,
} from "../src/yaad/client.js";
import { agents } from "../src/db/schema.js";
import { syncTools } from "../src/tools/sync.js";
import { DimaagError } from "../src/errors.js";

export function testConfig(): Config {
  return loadConfig();
}

export const silentLog = {
  error() {},
  info() {},
  warn() {},
};

export function endTurn(text = "ok"): DwarChatResponse {
  return {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

export function toolUse(name: string, input: unknown, id = "call-1"): DwarChatResponse {
  return {
    content: [{ type: "tool_use", id, name, input }],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

export function mockDwar(opts: {
  reason?: (
    request: DwarChatRequest,
  ) => DwarChatResponse | Promise<DwarChatResponse>;
  converse?: (
    request: DwarChatRequest,
  ) => DwarChatResponse | Promise<DwarChatResponse>;
}): DwarClient & {
  reasoningCalls: DwarChatRequest[];
  conversationCalls: DwarChatRequest[];
} {
  const reasoningCalls: DwarChatRequest[] = [];
  const conversationCalls: DwarChatRequest[] = [];
  return {
    reasoningCalls,
    conversationCalls,
    async reason(request) {
      reasoningCalls.push(request);
      if (opts.reason) {
        return opts.reason(request);
      }
      return endTurn("reasoning idle");
    },
    async converse(request) {
      conversationCalls.push(request);
      if (opts.converse) {
        return opts.converse(request);
      }
      return endTurn("conversation idle");
    },
  };
}

export function mockYaad(opts: {
  recall?: (body: { query: string; limit?: number }) => Promise<RecallResponse> | RecallResponse;
  query?: (body: QueryRequest) => Promise<QueryResponse> | QueryResponse;
  getNode?: (id: string) => Promise<NodeResponse> | NodeResponse;
  ingest?: (body: IngestRequest) => Promise<IngestResponse> | IngestResponse;
} = {}): YaadClient & {
  recallCalls: Array<{ query: string; limit?: number }>;
  queryCalls: QueryRequest[];
  getNodeCalls: string[];
  ingestCalls: IngestRequest[];
} {
  const recallCalls: Array<{ query: string; limit?: number }> = [];
  const queryCalls: QueryRequest[] = [];
  const getNodeCalls: string[] = [];
  const ingestCalls: IngestRequest[] = [];
  return {
    recallCalls,
    queryCalls,
    getNodeCalls,
    ingestCalls,
    async recall(body) {
      recallCalls.push(body);
      if (opts.recall) {
        return opts.recall(body);
      }
      return {
        nodes: [],
        edges: [],
        sufficient: false,
        coverage: 0,
      };
    },
    async query(body) {
      queryCalls.push(body);
      if (opts.query) {
        return opts.query(body);
      }
      return { nodes: [], limit: 50, offset: 0 };
    },
    async getNode(id) {
      getNodeCalls.push(id);
      if (opts.getNode) {
        return opts.getNode(id);
      }
      throw new DimaagError(404, "yaad", "node not found");
    },
    async ingest(body) {
      ingestCalls.push(body);
      if (opts.ingest) {
        return opts.ingest(body);
      }
      return {
        counts: {
          create_node: 0,
          update_node: 0,
          close_node: 0,
          create_edge: 0,
          close_edge: 0,
          noop: 1,
        },
        operations: [{ op: "noop", reason: "nothing" }],
      };
    },
  };
}

export async function openTestDb(): Promise<{ db: Db; sql: Sql; close: () => Promise<void> }> {
  const config = loadConfig();
  const { client, db } = createDb(config.env.databaseUrl);
  return {
    db,
    sql: client,
    close: () => client.end(),
  };
}

export async function resetRuntime(sql: Sql, db: Db, config: Config): Promise<void> {
  await sql`TRUNCATE agent_logs, agent_tools, tools, agents CASCADE`;
  await syncTools(db);
  await seed(db, config);
}

export async function insertAgent(
  db: Db,
  args: { name: string; systemPrompt: string; parentAgentId?: string | null },
): Promise<string> {
  const id = randomUUID();
  await db.insert(agents).values({
    id,
    name: args.name,
    systemPrompt: args.systemPrompt,
    parentAgentId: args.parentAgentId ?? null,
    active: true,
  });
  return id;
}
