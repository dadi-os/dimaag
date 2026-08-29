import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agentLogs, agents } from "../../db/schema.js";
import { requireAgent } from "../../runtime/tools.js";
import { toAgentRecord, toLogRecord } from "../../serialize.js";
import { idParam, logsQuery, parse } from "./schemas.js";

export async function registerAgents(app: FastifyInstance): Promise<void> {
  app.get("/agents", async () => {
    const rows = await app.db.select().from(agents);
    return { agents: rows.map(toAgentRecord) };
  });

  app.get("/agents/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const agent = toAgentRecord(await requireAgent(app.db, id));
    const childRows = await app.db.select().from(agents).where(eq(agents.parentAgentId, id));
    return { ...agent, children: childRows.map(toAgentRecord) };
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
}
