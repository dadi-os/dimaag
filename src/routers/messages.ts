import type { FastifyInstance } from "fastify";
import { writeAgentLog } from "../db/logs.js";
import { requireAgent } from "../runtime/tools.js";
import { postMessageBody, parse } from "./schemas.js";

export async function registerMessages(app: FastifyInstance): Promise<void> {
  app.post("/messages", async (request, reply) => {
    const body = parse(postMessageBody, request.body);
    await requireAgent(app.db, body.to_agent_id);
    const row = app.runtime.transcript.append({
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
        message_id: null,
        from_agent_id: null,
        to_agent_id: row.toAgentId,
        content: row.content,
        seq: row.seq,
      },
    });
    app.runtime.events.emit({
      type: "message",
      agent_id: body.to_agent_id,
      from_agent_id: null,
      to_agent_id: row.toAgentId,
      content: row.content,
      seq: row.seq,
      at: row.createdAt.toISOString(),
    });
    app.runtime.enqueueConversation(body.to_agent_id);
    return reply.status(201).send({
      to_agent_id: row.toAgentId,
      content: row.content,
      seq: row.seq,
      created_at: row.createdAt.toISOString(),
    });
  });
}
