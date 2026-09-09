/** HTTP client for Nas terminals and host filesystem. */

import axios, { type AxiosInstance, type AxiosRequestConfig } from "axios";
import { z } from "zod";
import type { Config } from "../config.js";
import { NAS } from "../constants.js";
import { DimaagError } from "../errors.js";

const createTerminalResponseSchema = z
  .object({
    id: z.string().min(1),
    cwd: z.string().min(1),
  })
  .passthrough();

const terminalInfoSchema = z
  .object({
    id: z.string().min(1),
    cwd: z.string(),
    created_at: z.string(),
    busy: z.boolean(),
  })
  .passthrough();

const execResponseSchema = z
  .object({
    exit_code: z.number().int().nullable(),
    output: z.string(),
    truncated: z.boolean(),
    timed_out: z.boolean(),
  })
  .passthrough();

const captureResponseSchema = z
  .object({
    output: z.string(),
  })
  .passthrough();

const keysResponseSchema = z
  .object({
    sent: z.literal(true),
  })
  .passthrough();

const readResponseSchema = z
  .object({
    content: z.string(),
    total_lines: z.number().int(),
    truncated: z.boolean(),
  })
  .passthrough();

const writeResponseSchema = z
  .object({
    bytes: z.number().int(),
  })
  .passthrough();

const editResponseSchema = z
  .object({
    replaced: z.literal(true),
  })
  .passthrough();

const globResponseSchema = z
  .object({
    paths: z.array(z.string()),
    truncated: z.boolean(),
  })
  .passthrough();

const grepMatchSchema = z
  .object({
    path: z.string(),
    line: z.number().int(),
    text: z.string(),
  })
  .passthrough();

const grepResponseSchema = z
  .object({
    matches: z.array(grepMatchSchema),
    truncated: z.boolean(),
  })
  .passthrough();

const createBrowserResponseSchema = z
  .object({
    id: z.number().int(),
    display: z.string(),
    cdp_url: z.string().min(1),
  })
  .passthrough();

const browserInfoSchema = z
  .object({
    id: z.number().int(),
    display: z.string(),
    cdp_url: z.string(),
    healthy: z.boolean(),
  })
  .passthrough();

export type CreateTerminalRequest = { cwd?: string };
export type CreateTerminalResponse = z.infer<typeof createTerminalResponseSchema>;
export type TerminalInfo = z.infer<typeof terminalInfoSchema>;
export type ExecRequest = {
  command: string;
  timeout_seconds?: number;
  max_bytes?: number;
};
export type ExecResponse = z.infer<typeof execResponseSchema>;
export type CaptureRequest = { lines?: number };
export type CaptureResponse = z.infer<typeof captureResponseSchema>;
export type KeysRequest = { keys: string[] };
export type ReadFileRequest = {
  path: string;
  offset?: number;
  limit?: number;
  max_bytes?: number;
};
export type WriteFileRequest = { path: string; content: string };
export type EditFileRequest = { path: string; old_string: string; new_string: string };
export type GlobRequest = { pattern: string; cwd?: string; limit?: number };
export type GrepRequest = {
  pattern: string;
  cwd?: string;
  glob?: string;
  limit?: number;
  max_bytes?: number;
};
export type CreateBrowserResponse = z.infer<typeof createBrowserResponseSchema>;
export type BrowserInfo = z.infer<typeof browserInfoSchema>;

/** Nas surface used by agent tools. */
export type NasClient = {
  createTerminal: (body?: CreateTerminalRequest) => Promise<CreateTerminalResponse>;
  listTerminals: () => Promise<TerminalInfo[]>;
  closeTerminal: (id: string) => Promise<void>;
  exec: (id: string, body: ExecRequest) => Promise<ExecResponse>;
  capture: (id: string, query?: CaptureRequest) => Promise<CaptureResponse>;
  sendKeys: (id: string, body: KeysRequest) => Promise<{ sent: true }>;
  readFile: (body: ReadFileRequest) => Promise<z.infer<typeof readResponseSchema>>;
  writeFile: (body: WriteFileRequest) => Promise<z.infer<typeof writeResponseSchema>>;
  editFile: (body: EditFileRequest) => Promise<z.infer<typeof editResponseSchema>>;
  glob: (body: GlobRequest) => Promise<z.infer<typeof globResponseSchema>>;
  grep: (body: GrepRequest) => Promise<z.infer<typeof grepResponseSchema>>;
  createBrowser: () => Promise<CreateBrowserResponse>;
  listBrowsers: () => Promise<BrowserInfo[]>;
  closeBrowser: (id: number) => Promise<void>;
  browserScreenshot: (id: number) => Promise<Buffer>;
};

/** Build a retrying axios client pointed at `NAS`. */
export function createNasClient(config: Config): NasClient {
  const http: AxiosInstance = axios.create({
    baseURL: NAS,
    timeout: config.nas.timeout_ms,
    headers: { "content-type": "application/json" },
  });

  async function get<T>(
    path: string,
    schema: z.ZodType<T>,
    reqConfig?: AxiosRequestConfig,
  ): Promise<T> {
    const data = await withRetry(config, () =>
      http.get(path, reqConfig).then((res) => res.data),
    );
    return parseResponse(schema, data);
  }

  async function post<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    reqConfig?: AxiosRequestConfig,
  ): Promise<T> {
    const data = await withRetry(config, () =>
      http.post(path, body, reqConfig).then((res) => res.data),
    );
    return parseResponse(schema, data);
  }

  async function del(path: string): Promise<void> {
    await withRetry(config, () => http.delete(path).then((res) => res.data));
  }

  return {
    createTerminal: (body = {}) =>
      post("/terminals", omitUndefined(body), createTerminalResponseSchema),
    listTerminals: () => get("/terminals", z.array(terminalInfoSchema)),
    closeTerminal: (id) => del(`/terminals/${encodeURIComponent(id)}`),
    exec: (id, body) => {
      const timeoutSeconds = body.timeout_seconds ?? 120;
      return post(
        `/terminals/${encodeURIComponent(id)}/exec`,
        omitUndefined(body),
        execResponseSchema,
        { timeout: (timeoutSeconds + 10) * 1000 },
      );
    },
    capture: (id, query = {}) =>
      get(
        `/terminals/${encodeURIComponent(id)}/capture`,
        captureResponseSchema,
        { params: omitUndefined(query) },
      ),
    sendKeys: (id, body) =>
      post(`/terminals/${encodeURIComponent(id)}/keys`, body, keysResponseSchema),
    readFile: (body) => post("/fs/read", omitUndefined(body), readResponseSchema),
    writeFile: (body) => post("/fs/write", body, writeResponseSchema),
    editFile: (body) => post("/fs/edit", body, editResponseSchema),
    glob: (body) => post("/fs/glob", omitUndefined(body), globResponseSchema),
    grep: (body) => post("/fs/grep", omitUndefined(body), grepResponseSchema),
    createBrowser: () => post("/browsers", {}, createBrowserResponseSchema),
    listBrowsers: () => get("/browsers", z.array(browserInfoSchema)),
    closeBrowser: (id) => del(`/browsers/${id}`),
    browserScreenshot: async (id) => {
      const data = await withRetry(config, async () => {
        const res = await http.get(`/browsers/${id}/screenshot`, {
          responseType: "arraybuffer",
          timeout: Math.max(config.nas.timeout_ms, 60_000),
        });
        return Buffer.from(res.data as ArrayBuffer);
      });
      if (!Buffer.isBuffer(data)) {
        throw new DimaagError(502, "nas", "Nas screenshot response is malformed");
      }
      return data;
    },
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
    throw new DimaagError(502, "nas", "Nas response is malformed");
  }
  return parsed.data;
}

async function withRetry(config: Config, fn: () => Promise<unknown>): Promise<unknown> {
  const { retry_attempts: attempts, backoff_ms: backoff } = config.nas;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts - 1) {
        throw mapNasError(err);
      }
    }
    const delay = backoff[Math.min(attempt, backoff.length - 1)];
    if (delay === undefined) {
      throw mapNasError(lastError);
    }
    await sleep(delay);
  }
  throw mapNasError(lastError);
}

function isRetryable(err: unknown): boolean {
  if (!axios.isAxiosError(err)) {
    return false;
  }
  if (!err.response) {
    return true;
  }
  // Do not retry busy / edit-match conflicts — caller must decide.
  if (err.response.status === 409) {
    return false;
  }
  return err.response.status >= 500;
}

const PASSTHROUGH_TYPES = new Set([
  "not_found",
  "busy",
  "forbidden",
  "binary_file",
  "invalid_request",
  "upstream_unreachable",
  "conflict",
  "stale_ref",
  "internal_error",
]);

function mapNasError(err: unknown): DimaagError {
  if (err instanceof DimaagError) {
    return err;
  }
  if (axios.isAxiosError(err)) {
    if (!err.response) {
      return new DimaagError(502, "nas", "Nas is unreachable");
    }
    const status = err.response.status;
    const data = err.response.data;

    const { type, message } = nasErrorParts(data);
    if (PASSTHROUGH_TYPES.has(type)) {
      return new DimaagError(status, type, message);
    }
    if (status >= 400 && status < 500) {
      return new DimaagError(status, "nas", message);
    }
    return new DimaagError(502, "nas", `Nas failed: ${message}`);
  }
  return new DimaagError(502, "nas", "Nas request failed");
}

function nasErrorParts(data: unknown): { type: string; message: string } {
  if (typeof data === "object" && data !== null && "error" in data) {
    const error = (data as { error: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const type =
        "type" in error && typeof (error as { type: unknown }).type === "string"
          ? (error as { type: string }).type
          : "nas";
      const message =
        "message" in error &&
        typeof (error as { message: unknown }).message === "string" &&
        (error as { message: string }).message.length > 0
          ? (error as { message: string }).message
          : "Nas request failed";
      return { type, message };
    }
  }
  return { type: "nas", message: "Nas request failed" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
