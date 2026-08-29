import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentTools, agents, messages, tools } from "../db/schema.js";
import { DimaagError } from "../errors.js";
import type {
  DwarChatRequest,
  DwarMessage,
  DwarTool,
  Lane,
} from "../types/domain.js";
import { DISPATCH_MESSAGE, SEND_MESSAGE, STEER_REASONING } from "../types/domain.js";
import {
  dispatchMessageTool,
  sendMessageTool,
  steerReasoningTool,
} from "./tools.js";

/**
 * One assembler for both lanes. The transcript is identical; only the tool set differs.
 *
 * Transcript: every message this agent received, plus its own outgoing messages to the
 * counterparty of the most recent inbound, ordered by seq.
 */
export async function assembleContext(opts: {
  db: Db;
  agentId: string;
  lane: Lane;
  maxTranscriptMessages: number;
}): Promise<DwarChatRequest> {
  const agentRows = await opts.db.select().from(agents).where(eq(agents.id, opts.agentId));
  const agent = agentRows[0];
  if (!agent) {
    throw new DimaagError(404, "not_found", `agent ${opts.agentId} not found`);
  }

  const inbound = await opts.db
    .select()
    .from(messages)
    .where(eq(messages.toAgentId, opts.agentId))
    .orderBy(asc(messages.seq));

  const latest = inbound[inbound.length - 1];
  let outgoing: typeof inbound = [];
  if (latest) {
    const counterpart = latest.fromAgentId;
    outgoing = await opts.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.fromAgentId, opts.agentId),
          counterpart === null ? isNull(messages.toAgentId) : eq(messages.toAgentId, counterpart),
        ),
      )
      .orderBy(asc(messages.seq));
  }

  const byId = new Map<string, (typeof inbound)[number]>();
  for (const row of inbound) {
    byId.set(row.id, row);
  }
  for (const row of outgoing) {
    byId.set(row.id, row);
  }
  const merged = [...byId.values()].sort((a, b) => a.seq - b.seq);
  const sliced = merged.slice(-opts.maxTranscriptMessages);

  const dwarMessages: DwarMessage[] = sliced.map((row) => ({
    role: row.toAgentId === opts.agentId ? "user" : "assistant",
    content: row.content,
  }));

  return {
    system: agent.systemPrompt,
    messages: dwarMessages,
    tools: await toolsForLane(opts.db, opts.agentId, opts.lane),
  };
}

async function toolsForLane(db: Db, agentId: string, lane: Lane): Promise<DwarTool[]> {
  if (lane === "conversation") {
    return [dispatchMessageTool, steerReasoningTool];
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
  return [...granted, sendMessageTool];
}

export const embeddedReasoningTools = [SEND_MESSAGE] as const;
export const embeddedConversationTools = [DISPATCH_MESSAGE, STEER_REASONING] as const;
