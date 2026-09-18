/** Mount message, Dadi, agent, tool, and SSE event routes. */

import type { FastifyInstance } from "fastify";
import { registerAgents } from "./agents.js";
import { registerDadi } from "./dadi.js";
import { registerEvents } from "./events.js";
import { registerHath } from "./hath.js";
import { registerMessages } from "./messages.js";
import { registerTools } from "./tools.js";

export async function registerV1(app: FastifyInstance): Promise<void> {
  await registerDadi(app);
  await registerMessages(app);
  await registerAgents(app);
  await registerTools(app);
  await registerEvents(app);
  await registerHath(app);
}
