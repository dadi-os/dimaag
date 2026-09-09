import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z
  .object({
    path: z.string().min(1),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
    max_bytes: z.number().int().positive().optional(),
  })
  .strict();

/** Read a host file via Nas. Intended for workers. */
export const readFile = defineTool({
  name: "read_file",
  description:
    "Read a text file at an absolute host path. Returns line-numbered content (N\\tline), total_lines, and truncated. Binary files fail.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", description: "Absolute host path" },
      offset: { type: "number", description: "1-based start line (default 1)" },
      limit: { type: "number", description: "Max lines to return (default 500)" },
      max_bytes: { type: "number", description: "Max content bytes (default 65536)" },
    },
  },
  async handler(ctx, parsed) {
    const body = {
      path: parsed.path,
      ...(parsed.offset !== undefined ? { offset: parsed.offset } : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      ...(parsed.max_bytes !== undefined ? { max_bytes: parsed.max_bytes } : {}),
    };
    return nasToolCall(
      () => ctx.nas.readFile(body),
      (response) => response,
      { path: parsed.path },
    );
  },
});
