import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z
  .object({
    services: z.string().min(1).optional(),
    level: z.enum(["debug", "info", "warn", "error"]).optional(),
    q: z.string().min(1).optional(),
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

/** Loki-backed system logs via Nas GET /logs. */
export const getLogs = defineTool({
  name: "nas_get_logs",
  description:
    "Query system/process HTTP logs from Loki via Nas. Use services (comma list), level, q, from, to, limit. This is not agent cognition — use dimaag_get_logs for thoughts and tool calls.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      services: {
        type: "string",
        description: "Comma-separated service labels (e.g. dimaag,dwar)",
      },
      level: {
        type: "string",
        enum: ["debug", "info", "warn", "error"],
      },
      q: { type: "string", description: "Substring filter" },
      from: { type: "string", description: "RFC3339 start" },
      to: { type: "string", description: "RFC3339 end" },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
    },
    required: [],
  },
  async handler(ctx, parsed) {
    const params: Record<string, string | number> = {};
    if (parsed.services !== undefined) params.services = parsed.services;
    if (parsed.level !== undefined) params.level = parsed.level;
    if (parsed.q !== undefined) params.q = parsed.q;
    if (parsed.from !== undefined) params.from = parsed.from;
    if (parsed.to !== undefined) params.to = parsed.to;
    if (parsed.limit !== undefined) params.limit = parsed.limit;
    return nasToolCall(
      () => ctx.nas.getLogs(params),
      (body) => body,
    );
  },
});
