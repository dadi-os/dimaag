import type { FastifyInstance } from "fastify";
import { patchMessageContent } from "../runtime/attachments.js";
import { deliverUserMessage } from "../runtime/deliver.js";
import { requireAgent } from "../runtime/tools.js";
import { postMessageBody, parse } from "./schemas.js";

export async function registerMessages(app: FastifyInstance): Promise<void> {
  app.post("/messages", async (request, reply) => {
    const body = parse(postMessageBody, request.body);
    await requireAgent(app.db, body.to_agent_id);
    const content = await patchMessageContent(
      app.dwar,
      body.content,
      body.attachments,
    );
    const row = await deliverUserMessage(
      {
        db: app.db,
        transcript: app.runtime.transcript,
        events: app.runtime.events,
        enqueueConversation: app.runtime.enqueueConversation,
      },
      body.to_agent_id,
      content,
    );
    return reply.status(201).send({
      to_agent_id: row.toAgentId,
      content: row.content,
      seq: row.seq,
      created_at: row.createdAt.toISOString(),
    });
  });
}
