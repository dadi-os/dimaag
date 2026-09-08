import axios, { type AxiosInstance } from "axios";
import { z } from "zod";
import type { Config } from "../config.js";
import { YAAD_BASE_URL } from "../constants.js";
import { DimaagError } from "../errors.js";

const nodeKind = z.enum(["person", "memory", "plan", "place"]);

const recallNodeSchema = z
  .object({
    id: z.string().uuid(),
    kind: nodeKind,
    title: z.string(),
    body: z.string().nullable(),
    occurred_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    detail: z.unknown().nullable(),
  })
  .passthrough();

const recallEdgeSchema = z
  .object({
    src_id: z.string().uuid(),
    dst_id: z.string().uuid(),
    type: z.string(),
  })
  .passthrough();

const recallResponseSchema = z
  .object({
    nodes: z.array(recallNodeSchema),
    edges: z.array(recallEdgeSchema),
    sufficient: z.boolean(),
    coverage: z.number(),
  })
  .passthrough();

const queryResponseSchema = z
  .object({
    nodes: z.array(z.unknown()),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .passthrough();

const nodeResponseSchema = z
  .object({
    id: z.string().uuid(),
    kind: nodeKind,
    title: z.string(),
    detail: z.unknown().nullable(),
    edges: z.object({
      outgoing: z.array(z.unknown()),
      incoming: z.array(z.unknown()),
    }),
  })
  .passthrough();

const ingestResponseSchema = z
  .object({
    counts: z.record(z.number()),
    operations: z.array(z.unknown()),
    temp_ids: z.record(z.string()).optional(),
  })
  .passthrough();

export type RecallResponse = z.infer<typeof recallResponseSchema>;
export type QueryResponse = z.infer<typeof queryResponseSchema>;
export type NodeResponse = z.infer<typeof nodeResponseSchema>;
export type IngestResponse = z.infer<typeof ingestResponseSchema>;

export type QueryRequest = {
  kind?: "person" | "memory" | "plan" | "place";
  name?: string;
  occurred_from?: string;
  occurred_to?: string;
  status?: "idea" | "tentative" | "confirmed";
  limit?: number;
  offset?: number;
};

export type IngestRequest = {
  text: string;
  occurred_at: string;
  participant_ids?: string[];
  source: "agent";
};

export type YaadClient = {
  recall: (body: { query: string; limit?: number }) => Promise<RecallResponse>;
  query: (body: QueryRequest) => Promise<QueryResponse>;
  getNode: (id: string) => Promise<NodeResponse>;
  ingest: (body: IngestRequest) => Promise<IngestResponse>;
};

export function createYaadClient(config: Config): YaadClient {
  const http: AxiosInstance = axios.create({
    baseURL: YAAD_BASE_URL,
    timeout: config.yaad.timeout_ms,
    headers: { "content-type": "application/json" },
  });

  async function post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const data = await withRetry(config, () => http.post(path, body).then((res) => res.data));
    return parseResponse(schema, data);
  }

  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const data = await withRetry(config, () => http.get(path).then((res) => res.data));
    return parseResponse(schema, data);
  }

  return {
    recall: (body) => post("/recall", body, recallResponseSchema),
    query: (body) => post("/query", body, queryResponseSchema),
    getNode: (id) => get(`/nodes/${id}`, nodeResponseSchema),
    ingest: (body) => post("/ingest", body, ingestResponseSchema),
  };
}

function parseResponse<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new DimaagError(502, "yaad", "Yaad response is malformed");
  }
  return parsed.data;
}

async function withRetry(config: Config, fn: () => Promise<unknown>): Promise<unknown> {
  const { retry_attempts: attempts, backoff_ms: backoff } = config.yaad;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts - 1) {
        throw mapYaadError(err);
      }
    }
    const delay = backoff[Math.min(attempt, backoff.length - 1)];
    if (delay === undefined) {
      throw mapYaadError(lastError);
    }
    await sleep(delay);
  }
  throw mapYaadError(lastError);
}

function isRetryable(err: unknown): boolean {
  if (!axios.isAxiosError(err)) {
    return false;
  }
  if (!err.response) {
    return true;
  }
  return err.response.status >= 500;
}

function mapYaadError(err: unknown): DimaagError {
  if (err instanceof DimaagError) {
    return err;
  }
  if (axios.isAxiosError(err)) {
    if (!err.response) {
      return new DimaagError(502, "upstream_unreachable", "Yaad is unreachable");
    }
    const status = err.response.status;
    const message = yaadMessage(err.response.data);
    if (status >= 400 && status < 500) {
      return new DimaagError(status, "yaad", message);
    }
    return new DimaagError(502, "yaad", `Yaad failed: ${message}`);
  }
  return new DimaagError(502, "yaad", "Yaad request failed");
}

function yaadMessage(data: unknown): string {
  if (typeof data === "object" && data !== null && "error" in data) {
    const error = (data as { error: unknown }).error;
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message: unknown }).message;
      if (typeof message === "string" && message.length > 0) {
        return message;
      }
    }
  }
  return "Yaad request failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
