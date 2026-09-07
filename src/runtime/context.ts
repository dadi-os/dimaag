import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentTools, agents, tools } from "../db/schema.js";
import { DimaagError } from "../errors.js";
import type { DwarChatRequest, DwarMessage, DwarTool, Lane } from "../types/domain.js";
import {
  DISPATCH_MESSAGE,
  ROUTE_MESSAGE,
  SEND_MESSAGE,
  STEER_REASONING,
  YIELD,
} from "../types/domain.js";
import {
  dispatchMessageTool,
  routeMessageTool,
  sendMessageTool,
  steerReasoningTool,
  yieldTool,
} from "./tools.js";
import type { TranscriptStore } from "./transcript.js";

/**
 * One assembler for both lanes. The transcript is identical; only the tool set differs.
 * Active direct children are appended to the system prompt so a router can reuse threads.
 */
export async function assembleContext(opts: {
  db: Db;
  agentId: string;
  lane: Lane;
  transcript: TranscriptStore;
}): Promise<DwarChatRequest> {
  const agentRows = await opts.db.select().from(agents).where(eq(agents.id, opts.agentId));
  const agent = agentRows[0];
  if (!agent) {
    throw new DimaagError(404, "not_found", `agent ${opts.agentId} not found`);
  }

  const childRows = await opts.db
    .select({
      id: agents.id,
      name: agents.name,
      active: agents.active,
      systemPrompt: agents.systemPrompt,
    })
    .from(agents)
    .where(eq(agents.parentAgentId, opts.agentId));
  const activeChildren = childRows.filter((c) => c.active);

  let system = agent.systemPrompt;
  if (activeChildren.length > 0) {
    const lines = activeChildren.map((c) => {
      const purpose = c.systemPrompt.trim().split(/\n/)[0] ?? "";
      const brief =
        purpose.length > 120 ? `${purpose.slice(0, 117)}…` : purpose;
      return brief
        ? `- ${c.name} (${c.id}): ${brief}`
        : `- ${c.name} (${c.id})`;
    });
    system = `${system}\n\nYour active direct child threads:\n${lines.join("\n")}`;
  } else if (agent.parentAgentId === null) {
    system = `${system}\n\nYou have no active child threads yet. Spawn one when a user message needs work.`;
  }

  if (agent.parentAgentId === null) {
    const routed = opts.transcript.routedUserMessages(opts.agentId);
    if (routed.length > 0) {
      const lines = routed.map((r) => {
        const preview =
          r.content.length > 80 ? `${r.content.slice(0, 77)}…` : r.content;
        return `- seq ${r.seq} → ${r.toAgentId}: ${preview}`;
      });
      system = `${system}\n\nAlready routed to a thread (do not route_message or re-steer these again):\n${lines.join("\n")}`;
    }
  }

  const entries = opts.transcript.transcriptFor(opts.agentId);
  const dwarMessages: DwarMessage[] = entries.map((row) => ({
    role: row.toAgentId === opts.agentId ? "user" : "assistant",
    content: row.content,
  }));

  return {
    system,
    messages: dwarMessages,
    tools: await toolsForLane(opts.db, opts.agentId, opts.lane, agent.parentAgentId === null),
  };
}

async function toolsForLane(
  db: Db,
  agentId: string,
  lane: Lane,
  isRoot: boolean,
): Promise<DwarTool[]> {
  if (lane === "conversation") {
    const embedded: DwarTool[] = isRoot
      ? [routeMessageTool, dispatchMessageTool, steerReasoningTool, yieldTool]
      : [dispatchMessageTool, steerReasoningTool, yieldTool];
    return embedded;
  }
  const grants = await db
    .select({
      name: tools.name,
      description: tools.description,
      inputSchema: tools.inputSchema,
      usage: agentTools.usage,
    })
    .from(agentTools)
    .innerJoin(tools, eq(agentTools.toolId, tools.id))
    .where(eq(agentTools.agentId, agentId));
  const granted: DwarTool[] = grants.map((grant) => ({
    name: grant.name,
    description: `${grant.description}\n\n${grant.usage}`,
    input_schema: grant.inputSchema,
  }));
  return [...granted, sendMessageTool, yieldTool];
}

export const embeddedReasoningTools = [SEND_MESSAGE, YIELD] as const;
export const embeddedConversationTools = [
  ROUTE_MESSAGE,
  DISPATCH_MESSAGE,
  STEER_REASONING,
  YIELD,
] as const;
