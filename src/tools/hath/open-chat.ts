import { z } from "zod";
import { agentIdSchema } from "../../agent-id.js";
import { defineTool } from "../types.js";
import { requireAgent } from "../shared.js";
import { hathToolCall } from "./call.js";

const input = z
  .object({
    node_name: z.string().min(1),
    agent_id: agentIdSchema,
  })
  .strict();

/** Open an agent's thread in Ankur's Hath app, so a hand-off lands him where the work now lives. Router-only. */
export const openChat = defineTool({
  name: "hath_open_chat",
  description:
    "Open an agent's thread in Ankur's Hath app on the device he is using, so he lands in the chat where his request now lives. Call it after sending, with the thread he should watch.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      node_name: { type: "string", description: "The Hath device he spoke from, as given with his message" },
      agent_id: { type: "string", description: "The agent whose thread to open" },
    },
    required: ["node_name", "agent_id"],
  },
  async handler(ctx, parsed) {
    await requireAgent(ctx.db, parsed.agent_id);
    return hathToolCall(ctx, parsed.node_name, "hath_open_chat", { agent_id: parsed.agent_id });
  },
});
