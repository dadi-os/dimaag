import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z
  .object({
    pattern: z.string().min(1),
    cwd: z.string().min(1).optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

/** Glob files on the host (absolute paths; Nas denies writes to OS/dadiOS runtime trees). Intended for workers. */
export const globFiles = defineTool({
  name: "glob",
  description:
    "Find files on the host (absolute paths; Nas denies writes to OS/dadiOS runtime trees) matching a doublestar pattern. Paths are absolute, sorted by mtime descending.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. **/*.ts" },
      cwd: {
        type: "string",
        description: "Absolute directory to search from (defaults to Nas state dir)",
      },
      limit: { type: "number", description: "Max paths to return (default 500)" },
    },
  },
  async handler(ctx, parsed) {
    const body = {
      pattern: parsed.pattern,
      ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    };
    return nasToolCall(
      () => ctx.nas.glob(body),
      (response) => response,
      parsed.cwd !== undefined ? { path: parsed.cwd } : {},
    );
  },
});
