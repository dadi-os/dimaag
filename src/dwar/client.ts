import axios, { type AxiosInstance } from "axios";
import { z } from "zod";
import type { Config } from "../config.js";
import { DWAR_BASE_URL } from "../constants.js";
import { DimaagError } from "../errors.js";
import type { DwarChatRequest, DwarChatResponse } from "../types/domain.js";

const chatBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
]);

const chatResponseSchema = z.object({
  content: z.array(chatBlockSchema),
  stop_reason: z.enum(["end_turn", "tool_use", "max_tokens", "error"]),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

export type DwarClient = {
  reason: (request: DwarChatRequest) => Promise<DwarChatResponse>;
  converse: (request: DwarChatRequest) => Promise<DwarChatResponse>;
};

export function createDwarClient(config: Config): DwarClient {
  const http: AxiosInstance = axios.create({
    baseURL: DWAR_BASE_URL,
    timeout: config.dwar.timeout_ms,
    headers: { "content-type": "application/json" },
  });

  async function postChat(path: string, request: DwarChatRequest): Promise<DwarChatResponse> {
    const data = await withRetry(config, () =>
      http.post(path, request).then((res) => res.data),
    );
    const parsed = chatResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new DimaagError(502, "dwar", "Dwar chat response is malformed");
    }
    return {
      stop_reason: parsed.data.stop_reason,
      usage: parsed.data.usage,
      content: parsed.data.content.map((block) => {
        if (block.type === "text") {
          return { type: "text" as const, text: block.text };
        }
        return {
          type: "tool_use" as const,
          id: block.id,
          name: block.name,
          input: block.input,
        };
      }),
    };
  }

  return {
    reason: (request) => postChat("/v1/chat/reasoning", request),
    converse: (request) => postChat("/v1/chat/conversation", request),
  };
}

async function withRetry(config: Config, fn: () => Promise<unknown>): Promise<unknown> {
  const { retry_attempts: attempts, backoff_ms: backoff } = config.dwar;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts - 1) {
        throw mapDwarError(err);
      }
      const delay = backoff[Math.min(attempt, backoff.length - 1)];
      if (delay === undefined) {
        throw mapDwarError(err);
      }
      await sleep(delay);
    }
  }
  throw mapDwarError(lastError);
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

function mapDwarError(err: unknown): DimaagError {
  if (err instanceof DimaagError) {
    return err;
  }
  if (axios.isAxiosError(err)) {
    if (!err.response) {
      return new DimaagError(502, "dwar_unreachable", "Dwar is unreachable");
    }
    const message = dwarMessage(err.response.data);
    return new DimaagError(502, "dwar", message);
  }
  return new DimaagError(502, "dwar", "Dwar request failed");
}

function dwarMessage(data: unknown): string {
  if (typeof data === "object" && data !== null && "error" in data) {
    const error = (data as { error: unknown }).error;
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message: unknown }).message;
      if (typeof message === "string" && message.length > 0) {
        return message;
      }
    }
  }
  return "Dwar request failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
