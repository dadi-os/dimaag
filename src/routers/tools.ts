/** List and execute grantable registry tools (CLI / ops surface). */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentIdSchema } from "../agent-id.js";
import { DimaagError } from "../errors.js";
import { executeTool } from "../runtime/tools.js";
import { requireActiveAgent, requireToolGrant } from "../tools/shared.js";
import { allTools, findTool } from "../tools/registry.js";
import { parse } from "./schemas.js";

const nameParam = z.object({ name: z.string().min(1) }).strict();

const executeBody = z
  .object({
    as_agent_id: z.union([z.literal("dadi"), z.literal("user"), agentIdSchema]),
  })
  .passthrough();

/** Tools Dadi may run via `as_agent_id: "dadi"` — router authority only. */
const DADI_AUTHORITY_TOOLS = new Set([
  "dimaag_spawn_agent",
  "dimaag_grant_tool",
  "dimaag_revoke_tool",
  "dimaag_modify_agent",
  "dimaag_get_agent",
]);

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
    const callerKind =
      asAgentId === "dadi" ? "dadi" : asAgentId === "user" ? "user" : "agent";
    const callerId = callerKind === "agent" ? asAgentId : null;
    if (asAgentId === "dadi" && !DADI_AUTHORITY_TOOLS.has(name)) {
      throw new DimaagError(
        422,
        "invalid_request",
        "as_agent_id dadi is limited to router authority tools",
      );
    }
    if (callerId !== null) {
      await requireActiveAgent(app.db, callerId);
      await requireToolGrant(app.db, callerId, name);
    }
    const result = await executeTool(app.runtime.toolContext(callerId, "reasoning", callerKind), {
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
