/**
 * `POST /router` — Ankur speaks to the router, not to an agent. The router runs
 * its lane (see runtime/router.ts) until it yields and returns every message it
 * sent as him, in order. May be empty.
 */

import type { FastifyInstance } from "fastify";
import { patchMessageContent } from "../runtime/attachments.js";
import { parse, postRouterBody } from "./schemas.js";

/** Register the router endpoint. */
export async function registerRouter(app: FastifyInstance): Promise<void> {
  app.post("/router", async (request, reply) => {
    const body = parse(postRouterBody, request.body);
    const content = await patchMessageContent(app.dwar, body.content, body.attachments);
    app.runtime.events.emit({ type: "router_started", at: new Date().toISOString() });
    try {
      const messages = await app.runtime.route(content, body.node_name);
      app.runtime.events.emit({ type: "router_finished", at: new Date().toISOString() });
      return reply.status(201).send({ messages });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.runtime.events.emit({ type: "router_failed", message, at: new Date().toISOString() });
      throw err;
    }
  });
}
