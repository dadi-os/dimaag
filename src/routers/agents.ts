/** Agent list/detail/log routes. */

import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agentLogs, agents, agentTools, tools } from "../db/schema.js";
import type { AgentRow } from "../db/schema.js";
import { requireAgent } from "../runtime/tools.js";
import { toAgentRecord, toLogRecord } from "../serialize.js";
import type { AgentRecord } from "../types/domain.js";
import { idParam, logsQuery, parse } from "./schemas.js";

/** Attach ephemeral running locks and host sessions for API responses. */
function withLive(row: AgentRow, runtime: FastifyInstance["runtime"]): AgentRecord {
  return {
    ...toAgentRecord(row),
    running: {
      reasoning: runtime.locks.isHeld(row.id, "reasoning"),
      conversation: runtime.locks.isHeld(row.id, "conversation"),
    },
    sessions: runtime.sessions.forAgent(row.id),
  };
}

async function agentDetail(app: FastifyInstance, agentRow: AgentRow) {
  const childRows = await app.db
    .select()
    .from(agents)
    .where(eq(agents.parentAgentId, agentRow.id));
  const toolRows = await app.db
    .select({
      name: tools.name,
      description: tools.description,
      usage: agentTools.usage,
    })
    .from(agentTools)
    .innerJoin(tools, eq(agentTools.toolId, tools.id))
    .where(eq(agentTools.agentId, agentRow.id));
  return {
    ...withLive(agentRow, app.runtime),
    children: childRows.map((row) => withLive(row, app.runtime)),
    tools: toolRows.map((row) => ({
      name: row.name,
      description: row.description,
      usage: row.usage,
    })),
  };
}

/** Register agent list/detail/log routes. */
export async function registerAgents(app: FastifyInstance): Promise<void> {
  app.get("/agents", async () => {
    const rows = await app.db.select().from(agents);
    return {
      agents: rows.map((row) => withLive(row, app.runtime)),
    };
  });

  app.get("/agents/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const agentRow = await requireAgent(app.db, id);
    return agentDetail(app, agentRow);
  });

  app.get("/agents/:id/logs", async (request) => {
    const { id } = parse(idParam, request.params);
    await requireAgent(app.db, id);
    const query = parse(logsQuery, request.query);
    const limit = query.limit ?? 50;
    const rows = await app.db
      .select()
      .from(agentLogs)
      .where(
        query.event
          ? and(eq(agentLogs.agentId, id), eq(agentLogs.event, query.event))
          : eq(agentLogs.agentId, id),
      )
      .orderBy(desc(agentLogs.createdAt))
      .limit(limit);
    return { logs: rows.map(toLogRecord) };
  });

  app.get("/logs", async (request) => {
    const query = parse(logsQuery, request.query);
    const limit = query.limit ?? 50;
    const rows = await app.db
      .select()
      .from(agentLogs)
      .where(query.event ? eq(agentLogs.event, query.event) : undefined)
      .orderBy(desc(agentLogs.createdAt))
      .limit(limit);
    return { logs: rows.map(toLogRecord) };
  });
}
