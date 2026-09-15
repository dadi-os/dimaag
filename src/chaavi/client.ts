/** HTTP client for Chaavi vault item lookup, login fill, and secret inject. */

import axios, { type AxiosInstance } from "axios";
import { z } from "zod";
import type { Config } from "../config.js";
import { CHAAVI_BASE_URL } from "../constants.js";
import { DimaagError } from "../errors.js";

const kind = z.enum(["login", "note", "secret"]);

const itemSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    kind,
    username: z.string().nullable(),
    uris: z.array(z.string()),
  })
  .passthrough();

const itemsResponseSchema = z
  .object({
    items: z.array(itemSchema),
  })
  .passthrough();

const loginResponseSchema = z
  .object({
    username: z.string(),
    password: z.string(),
  })
  .passthrough();

const secretResponseSchema = z
  .object({
    value: z.string(),
  })
  .passthrough();

export type ChaaviKind = z.infer<typeof kind>;
export type ChaaviItem = z.infer<typeof itemSchema>;
export type ChaaviLogin = z.infer<typeof loginResponseSchema>;
export type ChaaviSecret = z.infer<typeof secretResponseSchema>;

export type ListItemsRequest = {
  q?: string;
  uri?: string;
  kind?: ChaaviKind;
};

/** Chaavi surface used by agent tools. Secrets stay off the model-visible path. */
export type ChaaviClient = {
  listItems: (query?: ListItemsRequest) => Promise<{ items: ChaaviItem[] }>;
  getLogin: (itemId: string) => Promise<ChaaviLogin>;
  getSecret: (itemId: string) => Promise<ChaaviSecret>;
};

/** Build a retrying axios client pointed at `CHAAVI_BASE_URL`. */
export function createChaaviClient(config: Config): ChaaviClient {
  const http: AxiosInstance = axios.create({
    baseURL: CHAAVI_BASE_URL,
    timeout: config.chaavi.timeout_ms,
    headers: { "content-type": "application/json" },
  });

  async function get<T>(
    path: string,
    schema: z.ZodType<T>,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const data = await withRetry(config, () =>
      http.get(path, params !== undefined ? { params } : undefined).then((res) => res.data),
    );
    return parseResponse(schema, data);
  }

  async function post<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const data = await withRetry(config, () => http.post(path, {}).then((res) => res.data));
    return parseResponse(schema, data);
  }

  return {
    listItems: (query = {}) => get("/v1/items", itemsResponseSchema, omitUndefined(query)),
    getLogin: (itemId) => post(`/v1/items/${encodeURIComponent(itemId)}/login`, loginResponseSchema),
    getSecret: (itemId) =>
      post(`/v1/items/${encodeURIComponent(itemId)}/secret`, secretResponseSchema),
  };
}

function omitUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function parseResponse<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new DimaagError(502, "chaavi", "Chaavi response is malformed");
  }
  return parsed.data;
}

async function withRetry(config: Config, fn: () => Promise<unknown>): Promise<unknown> {
  const { retry_attempts: attempts, backoff_ms: backoff } = config.chaavi;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts - 1) {
        throw mapChaaviError(err);
      }
    }
    const delay = backoff[Math.min(attempt, backoff.length - 1)];
    if (delay === undefined) {
      throw mapChaaviError(lastError);
    }
    await sleep(delay);
  }
  throw mapChaaviError(lastError);
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

const PASSTHROUGH_TYPES = new Set([
  "vault_unconfigured",
  "vault_unreachable",
  "not_found",
  "invalid_request",
  "internal_error",
]);

function mapChaaviError(err: unknown): DimaagError {
  if (err instanceof DimaagError) {
    return err;
  }
  if (axios.isAxiosError(err)) {
    if (!err.response) {
      return new DimaagError(502, "chaavi", "Chaavi is unreachable");
    }
    const status = err.response.status;
    const { type, message } = chaaviErrorParts(err.response.data);
    if (PASSTHROUGH_TYPES.has(type)) {
      return new DimaagError(status, type, message);
    }
    if (status >= 400 && status < 500) {
      return new DimaagError(status, "chaavi", message);
    }
    return new DimaagError(502, "chaavi", `Chaavi failed: ${message}`);
  }
  return new DimaagError(502, "chaavi", "Chaavi request failed");
}

function chaaviErrorParts(data: unknown): { type: string; message: string } {
  if (typeof data === "object" && data !== null && "error" in data) {
    const error = (data as { error: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const type =
        "type" in error && typeof (error as { type: unknown }).type === "string"
          ? (error as { type: string }).type
          : "chaavi";
      const message =
        "message" in error &&
        typeof (error as { message: unknown }).message === "string" &&
        (error as { message: string }).message.length > 0
          ? (error as { message: string }).message
          : "Chaavi request failed";
      return { type, message };
    }
  }
  return { type: "chaavi", message: "Chaavi request failed" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
