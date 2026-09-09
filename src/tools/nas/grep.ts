import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z
  .object({
    pattern: z.string().min(1),
    cwd: z.string().min(1).optional(),
    glob: z.string().min(1).optional(),
    limit: z.number().int().positive().optional(),
    max_bytes: z.number().int().positive().optional(),
  })
  .strict();

/** Grep host files via Nas (ripgrep). Intended for workers. */
export const grepFiles = defineTool({
  name: "grep",
  description:
    "Search file contents on the host (absolute paths; Nas denies writes to OS/dadiOS runtime trees) with a regex (ripgrep). Optional glob restricts which files are searched.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "Regex pattern" },
      cwd: {
        type: "string",
        description: "Absolute directory to search from (defaults to Nas state dir)",
      },
      glob: { type: "string", description: "Optional file glob filter for ripgrep" },
      limit: { type: "number", description: "Max matches (default 200)" },
      max_bytes: { type: "number", description: "Max aggregate match bytes (default 65536)" },
    },
  },
  async handler(ctx, parsed) {
    const body = {
      pattern: parsed.pattern,
      ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
      ...(parsed.glob !== undefined ? { glob: parsed.glob } : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      ...(parsed.max_bytes !== undefined ? { max_bytes: parsed.max_bytes } : {}),
    };
    return nasToolCall(
      () => ctx.nas.grep(body),
      (response) => response,
      parsed.cwd !== undefined ? { path: parsed.cwd } : {},
    );
  },
});
