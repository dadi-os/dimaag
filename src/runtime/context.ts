import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentTools, agents, tools } from "../db/schema.js";
import { DimaagError } from "../errors.js";
import type { DwarChatRequest, DwarMessage, DwarTool, Lane } from "../types/domain.js";
import {
  DISPATCH_MESSAGE,
  LIST_AGENTS,
  SEND_MESSAGE,
  STEER_REASONING,
  YIELD,
} from "../types/domain.js";
import {
  dispatchMessageTool,
  listAgentsTool,
  sendMessageTool,
  steerReasoningTool,
  yieldTool,
} from "./tools.js";
import type { TranscriptStore } from "./transcript.js";

const OLDER_HISTORY_HINT =
  "Older turns beyond the live window are available via dimaag_get_logs.";

/**
 * laneBlock tells the model which lane it is on. Conversation never sees
 * granted domain tools; without this text it invents "tools are missing."
 */
function laneBlock(lane: Lane): string {
  if (lane === "conversation") {
    return [
      "You are on the conversation lane.",
      "Your only tools here are dispatch_message, steer_reasoning, list_agents, and yield.",
      "Granted domain tools (browser_*, terminal_*, chaavi_*, dimaag_spawn_agent, dimaag_grant_tool, and the rest) live on the reasoning lane. They are not missing from your agent — they are simply not bound to this lane.",
      "When work needs those tools, call steer_reasoning with a concrete instruction (what to do, and which browser_id or terminal_id when known). Do not tell the user or another agent that you lack tools, grants, or spawn capability because you cannot see them here.",
      "A not_found on a browser_id or terminal_id means that session is not running — steer reasoning to bring it back (or ask your parent) — it is not a missing-tool problem.",
      "Compose and send with dispatch_message; end the turn with yield.",
    ].join("\n");
  }
  return [
    "You are on the reasoning lane.",
    "Your granted domain tools are available here, along with send_message, list_agents, and yield. Use the granted tools to do the work.",
    "A not_found on a browser_id or terminal_id means that session is not running (often after a host or process restart). Bring it back if you hold the pool spawn tool, or report that exact error to your parent — do not claim your tools are missing.",
    "To speak to someone, call send_message with an intent; conversation will compose. End the turn with yield.",
  ].join("\n");
}

/**
 * routingBlock states this agent's id and parent so both lanes know who to
 * address. Guidance lives in the prompt — messaging tools do not enforce it.
 */
function routingBlock(agentId: string, parentAgentId: string | null): string {
  const parentLine =
    parentAgentId === null
      ? "You are a root agent (no parent)."
      : `Your parent is ${parentAgentId}.`;
  const routing =
    parentAgentId === null
      ? "Routing: You may message the user (to_agent_id null). When a child escalates a blocker or completion to you, resolve it or ask the user."
      : `Routing: Prefer your parent (${parentAgentId}) for progress, blockers, and completion — not the user (to_agent_id null). If stuck, message your parent with what you tried and what failed. If the user wrote to you directly, forward that to your parent rather than chatting with the user unless your parent or the user clearly expects a direct reply.`;
  return `Your agent id is ${agentId}.\n${parentLine}\n${routing}`;
}

/**
 * One assembler for both lanes. The transcript is identical; only the tool set differs.
 * Active direct children are appended so a parent can address workers it spawned.
 * Message history is truncated to the last `transcriptWindowMessages` turns.
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

  let system = agent.systemPrompt;
  if (activeChildren.length > 0) {
    const lines = activeChildren.map((c) => {
      const purpose = c.systemPrompt.trim().split(/\n/)[0] ?? "";
      const brief = purpose.length > 120 ? `${purpose.slice(0, 117)}…` : purpose;
      return brief ? `- ${c.id}: ${brief}` : `- ${c.id}`;
    });
    system = `${system}\n\nYour active direct children:\n${lines.join("\n")}`;
  }
  system = `${system}\n\n${laneBlock(opts.lane)}\n\n${routingBlock(agent.id, agent.parentAgentId)}\n\n${OLDER_HISTORY_HINT}`;

  const entries = opts.transcript.transcriptFor(opts.agentId);
  const windowed =
    entries.length > opts.transcriptWindowMessages
      ? entries.slice(entries.length - opts.transcriptWindowMessages)
      : entries;
  const dwarMessages: DwarMessage[] = windowed.map((row) => {
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
  return [...granted, sendMessageTool, listAgentsTool, yieldTool];
}

export const embeddedReasoningTools = [SEND_MESSAGE, LIST_AGENTS, YIELD] as const;
export const embeddedConversationTools = [
  DISPATCH_MESSAGE,
  STEER_REASONING,
  LIST_AGENTS,
  YIELD,
] as const;
