import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agentLogs, agents, agentTools, tools } from "../db/schema.js";
import type { AgentRow } from "../db/schema.js";
import { DimaagError } from "../errors.js";
import type { LaneLocks } from "../runtime/locks.js";
import { requireAgent } from "../runtime/tools.js";
import { toAgentRecord, toLogRecord } from "../serialize.js";
import type { AgentRecord } from "../types/domain.js";
import { idParam, logsQuery, parse } from "./schemas.js";

function withRunning(row: AgentRow, locks: LaneLocks): AgentRecord {
  return {
    ...toAgentRecord(row),
    running: {
      reasoning: locks.isHeld(row.id, "reasoning"),
      conversation: locks.isHeld(row.id, "conversation"),
    },
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
    ...withRunning(agentRow, app.runtime.locks),
    children: childRows.map((row) => withRunning(row, app.runtime.locks)),
    tools: toolRows.map((row) => ({
      name: row.name,
      description: row.description,
      usage: row.usage,
    })),
  };
}

export async function registerAgents(app: FastifyInstance): Promise<void> {
  app.get("/agents", async () => {
    const rows = await app.db.select().from(agents);
    return {
      agents: rows.map((row) => withRunning(row, app.runtime.locks)),
    };
  });

  // Before /agents/:id — "root" is not a UUID.
  app.get("/agents/root", async () => {
    const rows = await app.db.select().from(agents).where(isNull(agents.parentAgentId));
    if (rows.length === 0) {
      throw new DimaagError(
        404,
        "not_found",
        "no root agent (parent_agent_id is null); seedRootDadi may not have run",
      );
    }
    if (rows.length > 1) {
      throw new DimaagError(
        409,
        "conflict",
        `data corruption: ${rows.length} agents with parent_agent_id null; expected exactly one`,
      );
    }
    const root = rows[0];
    if (!root) {
      throw new DimaagError(
        404,
        "not_found",
        "no root agent (parent_agent_id is null); seedRootDadi may not have run",
      );
    }
    return agentDetail(app, root);
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
