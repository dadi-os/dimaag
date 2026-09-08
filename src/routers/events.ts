/** `GET /events` — Server-Sent Events stream of runtime events. */

import type { FastifyInstance } from "fastify";

export async function registerEvents(app: FastifyInstance): Promise<void> {
  app.get("/events", (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n");

    const unsubscribe = app.runtime.events.subscribe((event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, 20000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
