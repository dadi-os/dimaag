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
    thought_signature: z.string().nullish(),
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

const describeResponseSchema = z.object({
  description: z.string().min(1),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

export type DwarDescribeImageRequest = {
  image: { media_type: string; data: string };
  prompt?: string;
};

export type DwarDescribeImageResponse = {
  description: string;
  usage: { input_tokens: number; output_tokens: number };
};

export type DwarClient = {
  reason: (request: DwarChatRequest) => Promise<DwarChatResponse>;
  converse: (request: DwarChatRequest) => Promise<DwarChatResponse>;
  describeImage: (
    request: DwarDescribeImageRequest,
  ) => Promise<DwarDescribeImageResponse>;
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
        const out: {
          type: "tool_use";
          id: string;
          name: string;
          input: unknown;
          thought_signature?: string;
        } = {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        };
        if (block.thought_signature) {
          out.thought_signature = block.thought_signature;
        }
        return out;
      }),
    };
  }

  async function describeImage(
    request: DwarDescribeImageRequest,
  ): Promise<DwarDescribeImageResponse> {
    const body: Record<string, unknown> = { image: request.image };
    if (request.prompt !== undefined) {
      body.prompt = request.prompt;
    }
    const data = await withRetry(config, () =>
      http.post("/image/describe", body).then((res) => res.data),
    );
    const parsed = describeResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new DimaagError(502, "dwar", "Dwar image describe response is malformed");
    }
    return parsed.data;
  }

  return {
    reason: (request) => postChat("/chat/reasoning", request),
    converse: (request) => postChat("/chat/conversation", request),
    describeImage,
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
      return new DimaagError(502, "upstream_unreachable", "Dwar is unreachable");
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
