import type { FastifyInstance } from "fastify";
import { registerAgents } from "./agents.js";
import { registerEvents } from "./events.js";
import { registerMessages } from "./messages.js";

export async function registerV1(app: FastifyInstance): Promise<void> {
  await registerMessages(app);
  await registerAgents(app);
  await registerEvents(app);
}
