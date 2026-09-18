/** List and execute grantable registry tools (CLI / ops surface). */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DimaagError } from "../errors.js";
import { executeTool } from "../runtime/tools.js";
import { requireAgent } from "../tools/shared.js";
import { allTools, findTool } from "../tools/registry.js";
import { parse } from "./schemas.js";

const nameParam = z.object({ name: z.string().min(1) }).strict();

const executeBody = z
  .object({
    as_agent_id: z.string().uuid(),
  })
  .passthrough();

/** Register GET /tools, GET /tools/:name, POST /tools/:name/execute. */
export async function registerTools(app: FastifyInstance): Promise<void> {
  app.get("/tools", async () => ({
    tools: allTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
  }));

  app.get("/tools/:name", async (request) => {
    const { name } = parse(nameParam, request.params);
    const tool = findTool(name);
    if (!tool) {
      throw new DimaagError(404, "not_found", `tool ${name} not found`);
    }
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    };
  });

  app.post("/tools/:name/execute", async (request) => {
    const { name } = parse(nameParam, request.params);
    const tool = findTool(name);
    if (!tool) {
      throw new DimaagError(404, "not_found", `tool ${name} not found`);
    }
    const raw =
      request.body === undefined || request.body === null || request.body === ""
        ? {}
        : request.body;
    const parsed = parse(executeBody, raw);
    const { as_agent_id: asAgentId, ...input } = parsed;
    await requireAgent(app.db, asAgentId);
    const result = await executeTool(app.runtime.toolContext(asAgentId, "reasoning"), {
      type: "tool_use",
      id: "cli",
      name,
      input,
    });
    return {
      ok: !result.isError,
      content: result.content,
      is_error: result.isError,
    };
  });
}
