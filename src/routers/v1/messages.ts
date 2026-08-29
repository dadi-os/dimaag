import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { writeAgentLog } from "../../db/logs.js";
import { messages } from "../../db/schema.js";
import { insertMessage, requireAgent } from "../../runtime/tools.js";
import { toMessageRecord } from "../../serialize.js";
import { getMessagesQuery, parse, postMessageBody } from "./schemas.js";

export async function registerMessages(app: FastifyInstance): Promise<void> {
  app.post("/messages", async (request, reply) => {
    const body = parse(postMessageBody, request.body);
    await requireAgent(app.db, body.to_agent_id);
    const row = await insertMessage(app.db, {
      fromAgentId: null,
      toAgentId: body.to_agent_id,
      content: body.content,
    });
    await writeAgentLog(app.db, {
      agentId: body.to_agent_id,
      lane: "conversation",
      event: "message",
      payload: {
        direction: "receive",
        message_id: row.id,
        from_agent_id: null,
        to_agent_id: row.toAgentId,
        content: row.content,
        seq: row.seq,
      },
    });
    app.runtime.enqueueConversation(body.to_agent_id);
    return reply.status(201).send(toMessageRecord(row));
  });

  app.get("/messages", async (request) => {
    const query = parse(getMessagesQuery, request.query);
    await requireAgent(app.db, query.agent_id);
    const limit = query.limit ?? 50;
    const since = query.since ?? 0;
    const rows = await app.db
      .select()
      .from(messages)
      .where(
        and(
          or(
            and(isNull(messages.fromAgentId), eq(messages.toAgentId, query.agent_id)),
            and(eq(messages.fromAgentId, query.agent_id), isNull(messages.toAgentId)),
          ),
          gt(messages.seq, since),
        ),
      )
      .orderBy(asc(messages.seq))
      .limit(limit);
    return { messages: rows.map(toMessageRecord) };
  });
}
