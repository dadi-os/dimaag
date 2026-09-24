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
  WAIT,
  YIELD,
} from "../types/domain.js";
import {
  dispatchMessageTool,
  listAgentsTool,
  sendMessageTool,
  steerReasoningTool,
  waitTool,
  yieldTool,
} from "./tools.js";
import type { TranscriptStore } from "./transcript.js";

const OLDER_HISTORY_HINT =
  "Older turns beyond the live window are available via dimaag_get_logs.";

/**
 * laneBlock tells the model which lane it is on. Conversation never sees
 * granted domain tools; without this text it invents "tools are missing."
 * Do not catalog specific registry tool names here — only lane roles.
 */
function laneBlock(lane: Lane): string {
  if (lane === "conversation") {
    return [
      "You are on the conversation lane.",
      "You manage this agent's reasoning lane and its messages to other agents and the user.",
      "Your tools here are dispatch_message, steer_reasoning, list_agents, and yield only.",
      "Granted domain tools run on the reasoning lane. They are not missing — they are not bound to this lane. Steer reasoning to do domain work; use terminate on steer_reasoning to halt reasoning so its next tool call does not run.",
      "Never tell anyone you lack grants or spawn capability because you cannot see domain tools here.",
      "Do not claim another agent is working unless you have already dispatched to them. End the turn with yield.",
    ].join("\n");
  }
  return [
    "You are on the reasoning lane.",
    "Your granted domain tools are available here, along with send_message, list_agents, wait, and yield. Use only the tools listed in this request — do not invent tool names.",
    "If a tool returns an error, do not repeat the same call with the same arguments. Change approach, or send_message to escalate.",
    "When you must wait for something to settle (a page, a job, a reply expected shortly), call wait to pause instead of looping and burning turns; a steer or terminate cuts it short.",
    "If you lack a capability you need, message your parent to request the grant and state your case. Keep task dialogue with whoever contracted or messaged you about the job.",
    "A not_found on a browser or terminal session means that session is not running — bring it back if you hold the pool tools, or report that exact error. That is not a missing-grant problem.",
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
      ? [
          "Messaging:",
          "- Whoever messages you about a job is your point of contact for that job — reply to them with progress, blockers, and results.",
          "- You may message the user (to_agent_id null) when they are that point of contact, or when you need a decision only they can make.",
          "- When a child needs a capability only you can grant, they will ask you; judge the case and grant or refuse.",
        ].join("\n")
      : [
          "Messaging:",
          "- Whoever messaged you about the job is your point of contact for task progress, blockers, and results — usually the agent that contracted you (not always your parent).",
          `- Your parent (${parentAgentId}) owns grants. If you need a capability you do not hold, ask your parent with a clear case. Do not invent tool names you were not granted.`,
          "- If the user interjects while you are working for another agent, acknowledge the user and keep reporting the job to that contracting agent unless the user is now clearly taking over the conversation with you.",
          "- Address agents by exact kebab-case id from list_agents (or null for the user).",
        ].join("\n");
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
  return [...granted, sendMessageTool, listAgentsTool, waitTool, yieldTool];
}

export const embeddedReasoningTools = [SEND_MESSAGE, LIST_AGENTS, WAIT, YIELD] as const;
export const embeddedConversationTools = [
  DISPATCH_MESSAGE,
  STEER_REASONING,
  LIST_AGENTS,
  YIELD,
] as const;
