import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentTools, agents, tools } from "../db/schema.js";
import { DimaagError } from "../errors.js";
import type { DwarChatRequest, DwarMessage, DwarTool, Lane } from "../types/domain.js";
import {
  DISPATCH_MESSAGE,
  LIST_AGENTS,
  RECORD_THOUGHT,
  SEND_MESSAGE,
  STEER_REASONING,
  WAIT,
  YIELD,
} from "../types/domain.js";
import {
  dispatchMessageTool,
  listAgentsTool,
  recordThoughtTool,
  sendMessageTool,
  steerReasoningTool,
  waitTool,
  yieldTool,
} from "./tools.js";
import type { TranscriptStore } from "./transcript.js";

/**
 * lineageBlock states runtime facts the model cannot know on its own: this
 * agent's id and its parent. Lane roles, messaging discipline, and the rest of
 * the standing doctrine live in Dwar's per-lane block (cached, shared across
 * agents) — deliberately not restated here, so there is one source of truth.
 */
function lineageBlock(agentId: string, parentAgentId: string | null): string {
  const parentLine =
    parentAgentId === null
      ? "You are a root agent (no parent)."
      : `Your parent is ${parentAgentId}.`;
  return `Your agent id is ${agentId}.\n${parentLine}`;
}

/**
 * One assembler for both lanes. dimaag's system is agent-specific only —
 * charter (the agent's stored prompt), lineage facts, then its active children.
 * The lane doctrine is appended by Dwar as a cached block, so nothing lane- or
 * tool-related is built here. Message history is truncated to the last
 * `transcriptWindowMessages` turns; only the tool set differs across lanes.
 */
export async function assembleContext(opts: {
  db: Db;
  agentId: string;
  lane: Lane;
  transcript: TranscriptStore;
  transcriptWindowMessages: number;
}): Promise<DwarChatRequest> {
  const agentRows = await opts.db.select().from(agents).where(eq(agents.id, opts.agentId));
  const agent = agentRows[0];
  if (!agent) {
    throw new DimaagError(404, "not_found", `agent ${opts.agentId} not found`);
  }

  const childRows = await opts.db
    .select({
      id: agents.id,
      active: agents.active,
      systemPrompt: agents.systemPrompt,
    })
    .from(agents)
    .where(eq(agents.parentAgentId, opts.agentId));
  const activeChildren = childRows.filter((c) => c.active);

  let system = `${agent.systemPrompt}\n\n${lineageBlock(agent.id, agent.parentAgentId)}`;
  if (activeChildren.length > 0) {
    const lines = activeChildren.map((c) => {
      const purpose = c.systemPrompt.trim().split(/\n/)[0] ?? "";
      const brief = purpose.length > 120 ? `${purpose.slice(0, 117)}…` : purpose;
      return brief ? `- ${c.id}: ${brief}` : `- ${c.id}`;
    });
    system = `${system}\n\nYour active direct children:\n${lines.join("\n")}`;
  }

  const entries = opts.transcript.transcriptFor(opts.agentId);
  const windowed =
    entries.length > opts.transcriptWindowMessages
      ? entries.slice(entries.length - opts.transcriptWindowMessages)
      : entries;
  const dwarMessages: DwarMessage[] = windowed.map((row) => {
    if (row.fromAgentId === opts.agentId && row.toAgentId === opts.agentId) {
      return {
        role: "assistant" as const,
        content: `[Thought]\n${row.content}`,
      };
    }
    if (row.toAgentId === opts.agentId) {
      const fromLabel = row.fromAgentId === null ? "Ankur" : row.fromAgentId;
      return {
        role: "user" as const,
        content: `[From: ${fromLabel}]\n${row.content}`,
      };
    }
    const toLabel = row.toAgentId === null ? "Ankur" : row.toAgentId;
    return {
      role: "assistant" as const,
      content: `[To: ${toLabel}]\n${row.content}`,
    };
  });

  return {
    system,
    messages: dwarMessages,
    tools: await toolsForLane(opts.db, opts.agentId, opts.lane),
  };
}

async function toolsForLane(db: Db, agentId: string, lane: Lane): Promise<DwarTool[]> {
  if (lane === "conversation") {
    return [dispatchMessageTool, steerReasoningTool, listAgentsTool, yieldTool];
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
  return [...granted, sendMessageTool, listAgentsTool, waitTool, recordThoughtTool, yieldTool];
}

export const embeddedReasoningTools = [SEND_MESSAGE, LIST_AGENTS, WAIT, RECORD_THOUGHT, YIELD] as const;
export const embeddedConversationTools = [
  DISPATCH_MESSAGE,
  STEER_REASONING,
  LIST_AGENTS,
  YIELD,
] as const;
