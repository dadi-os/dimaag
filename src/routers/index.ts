/** Mount message, router, agent, tool, and SSE event routes. */

import type { FastifyInstance } from "fastify";
import { registerAgents } from "./agents.js";
import { registerRouter } from "./router.js";
import { registerEvents } from "./events.js";
import { registerDevices } from "./devices.js";
import { registerMessages } from "./messages.js";
import { registerTools } from "./tools.js";

export async function registerV1(app: FastifyInstance): Promise<void> {
  await registerRouter(app);
  await registerMessages(app);
  await registerAgents(app);
  await registerTools(app);
  await registerEvents(app);
  await registerDevices(app);
}
