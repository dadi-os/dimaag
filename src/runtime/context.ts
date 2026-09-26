import { asc, eq } from "drizzle-orm";
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
import type { TranscriptEntry, TranscriptStore } from "./transcript.js";

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

/** An assembled lane request plus the newest transcript seq it includes (0 when empty). */
export type AssembledContext = DwarChatRequest & { throughSeq: number };

/**
 * One assembler for both lanes. dimaag's system is agent-specific only —
 * charter (the agent's stored prompt), lineage facts, then its active children.
 * The lane doctrine is appended by Dwar as a cached block, so nothing lane- or
 * tool-related is built here. Message history keeps at least the last
 * `transcriptWindowMessages` turns; its start only advances in steps of
 * `transcriptWindowStep` so the provider's cached prefix survives new messages.
 * Only the tool set differs across lanes.
 */
export async function assembleContext(opts: {
  db: Db;
  agentId: string;
  lane: Lane;
  transcript: TranscriptStore;
  transcriptWindowMessages: number;
  transcriptWindowStep: number;
}): Promise<AssembledContext> {
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
  const overflow = entries.length - opts.transcriptWindowMessages;
  const start =
    overflow > 0 ? Math.floor(overflow / opts.transcriptWindowStep) * opts.transcriptWindowStep : 0;
  const dwarMessages: DwarMessage[] = entries.slice(start).map((row) => {
    const labelled = labelEntry(row, opts.agentId);
    return { role: labelled.role, content: `${labelled.label}\n${row.content}` };
  });

  return {
    system,
    messages: dwarMessages,
    tools: await toolsForLane(opts.db, opts.agentId, opts.lane),
    throughSeq: entries.at(-1)?.seq ?? 0,
  };
}

/**
 * arrivalsSince folds transcript entries newer than `afterSeq` into one user
 * turn, so messages that land mid-wake join the scratchpad at the point they
 * arrived instead of rewriting the history above it. `turn` is null when
 * nothing arrived; `throughSeq` is the newest seq seen.
 */
export function arrivalsSince(
  transcript: TranscriptStore,
  agentId: string,
  afterSeq: number,
): { turn: DwarMessage | null; throughSeq: number } {
  const fresh = transcript.transcriptFor(agentId).filter((row) => row.seq > afterSeq);
  if (fresh.length === 0) {
    return { turn: null, throughSeq: afterSeq };
  }
  const lines = fresh.map((row) => `${labelEntry(row, agentId).label}\n${row.content}`);
  return {
    turn: { role: "user", content: `[Arrived during this wake]\n\n${lines.join("\n\n")}` },
    throughSeq: fresh.at(-1)!.seq,
  };
}

/** labelEntry gives a transcript row its turn role and `[From:]`/`[To:]`/`[Thought]` label from this agent's point of view. */
function labelEntry(
  row: TranscriptEntry,
  agentId: string,
): { role: "user" | "assistant"; label: string } {
  if (row.fromAgentId === agentId && row.toAgentId === agentId) {
    return { role: "assistant", label: "[Thought]" };
  }
  if (row.toAgentId === agentId) {
    return { role: "user", label: `[From: ${row.fromAgentId === null ? "Ankur" : row.fromAgentId}]` };
  }
  return { role: "assistant", label: `[To: ${row.toAgentId === null ? "Ankur" : row.toAgentId}]` };
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
    .where(eq(agentTools.agentId, agentId))
    .orderBy(asc(tools.name));
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
