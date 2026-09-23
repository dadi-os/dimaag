/**
 * Built-in lane tools (send/dispatch/steer/yield/list_agents) and the executeTool dispatcher.
 * Registry tools are resolved for the reasoning lane; conversation uses the switch below.
 */

import { and, asc, eq } from "drizzle-orm";
import { z, ZodError } from "zod";
import { agentIdOrUserSchema, agentIdSchema } from "../agent-id.js";
import { agents } from "../db/schema.js";
import { DimaagError } from "../errors.js";
import type { DwarTool, DwarToolUseBlock } from "../types/domain.js";
import {
  DISPATCH_MESSAGE,
  LIST_AGENTS,
  SEND_MESSAGE,
  STEER_REASONING,
  YIELD,
} from "../types/domain.js";
import { findTool } from "../tools/registry.js";
import {
  fail,
  ok,
  requireAgent,
  requireActiveAgent,
  requireToolGrant,
  failWithoutAgentIdentity,
  type ToolContext,
  type ToolExecResult,
} from "../tools/shared.js";
import { deliverAgentMessage } from "./deliver.js";

export type { ToolContext, ToolExecResult } from "../tools/shared.js";
export { requireAgent, requireActiveAgent, requireToolGrant } from "../tools/shared.js";

export const sendMessageInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    to_agent_id: {
      type: ["string", "null"],
      description: "Recipient kebab-case agent id, or null for the user",
    },
    intent: {
      type: "string",
      description: "What you want said, not the final wording",
    },
  },
  required: ["to_agent_id", "intent"],
};

export const dispatchMessageInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    to_agent_id: {
      type: ["string", "null"],
      description: "Recipient kebab-case agent id, or null for the user",
    },
    content: { type: "string", description: "The message to persist and deliver" },
  },
  required: ["to_agent_id", "content"],
};

export const steerReasoningInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    instruction: { type: "string", description: "What reasoning should do next" },
  },
  required: ["instruction"],
};

export const yieldInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const listAgentsInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: "Exact kebab-case agent id. Returns at most one row.",
    },
    include_inactive: {
      type: "boolean",
      description: "When true, include dormant agents. Defaults to false.",
    },
  },
  additionalProperties: false,
};

/** Hand intent to conversation; does not persist a message. */
export const sendMessageTool: DwarTool = {
  name: SEND_MESSAGE,
  description:
    "Hand an intent to your conversation lane so it can compose and dispatch a message. Does not send anything itself. to_agent_id null is the user. Prefer your parent for progress and blockers when you have one — see the routing block in your system prompt. Report real tool errors (for example not_found on a browser_id) honestly; do not invent that your granted tools are missing.",
  input_schema: sendMessageInputSchema,
};

/** Persist and deliver a message to another agent or the user. */
export const dispatchMessageTool: DwarTool = {
  name: DISPATCH_MESSAGE,
  description:
    "Write a message to another agent or to the user (to_agent_id null). This is the only way a message addressed to someone else is persisted. Does not end the turn — call yield when done. Prefer your parent for task progress and blockers when you have one — see the routing block. Never claim domain tools are missing: those tools live on the reasoning lane; use steer_reasoning for work that needs them.",
  input_schema: dispatchMessageInputSchema,
};

/** Queue an instruction for the caller's reasoning lane. */
export const steerReasoningTool: DwarTool = {
  name: STEER_REASONING,
  description:
    "Queue an instruction for your own reasoning lane, where granted domain tools actually run. Starts a reasoning run if that lane is idle. Use this for any work that needs browser_*, terminal_*, chaavi_*, spawn, grant, or other granted tools — do not report those tools as missing from conversation. Pass a concrete instruction (action plus browser_id or terminal_id when known).",
  input_schema: steerReasoningInputSchema,
};

/** End the current lane turn. */
export const yieldTool: DwarTool = {
  name: YIELD,
  description:
    "End this lane turn. Call when you have nothing more to do right now. Sending a message or running other tools does not end the turn — only yield does.",
  input_schema: yieldInputSchema,
};

/** Look up agents by exact id or list the roster (id, name alias, parent, active). */
export const listAgentsTool: DwarTool = {
  name: LIST_AGENTS,
  description:
    "List agents visible to you: id, name (alias of id), parent, and whether each is active. Pass id for an exact kebab-case lookup (empty list on miss). Pass include_inactive true to include dormant agents.",
  input_schema: listAgentsInputSchema,
};

const sendInput = z.object({
  to_agent_id: agentIdOrUserSchema,
  intent: z.string().min(1),
});

const dispatchInput = z.object({
  to_agent_id: agentIdOrUserSchema,
  content: z.string().min(1),
});

const steerInput = z.object({
  instruction: z.string().min(1),
});

const yieldInput = z.object({}).strict();

const listAgentsInput = z
  .object({
    id: agentIdSchema.optional(),
    include_inactive: z.boolean().optional(),
  })
  .strict();

/** Dispatch a tool_use block for the caller's lane; map Zod/4xx to tool errors. */
export async function executeTool(
  ctx: ToolContext,
  call: DwarToolUseBlock,
): Promise<ToolExecResult> {
  const result = await dispatchTool(ctx, call);
  if (ctx.callerId !== null) {
    ctx.sessions.observe(ctx.callerId, call.name, call.input, result.isError);
  }
  return result;
}

/** Route one tool_use to the matching handler without session bookkeeping. */
async function dispatchTool(
  ctx: ToolContext,
  call: DwarToolUseBlock,
): Promise<ToolExecResult> {
  try {
    if (call.name === YIELD) {
      yieldInput.parse(call.input ?? {});
      return ok({ yielded: true });
    }
    if (call.name === LIST_AGENTS) {
      return await runListAgents(ctx, call.input);
    }
    if (ctx.lane === "reasoning") {
      if (call.name === SEND_MESSAGE) {
        return await runSendMessage(ctx, call.input);
      }
      const definition = findTool(call.name);
      if (!definition) {
        return fail(`unknown reasoning tool: ${call.name}`);
      }
      if (ctx.callerId !== null) {
        await requireActiveAgent(ctx.db, ctx.callerId);
        await requireToolGrant(ctx.db, ctx.callerId, call.name);
      }
      const parsed = definition.input.parse(call.input);
      return await definition.handler(ctx, parsed);
    }
    switch (call.name) {
      case DISPATCH_MESSAGE:
        return await runDispatchMessage(ctx, call.input);
      case STEER_REASONING:
        return await runSteerReasoning(ctx, call.input);
      default:
        return fail(`unknown conversation tool: ${call.name}`);
    }
  } catch (err) {
    if (err instanceof ZodError) {
      return fail(err.issues.map((issue) => issue.message).join("; "));
    }
    if (err instanceof DimaagError && err.statusCode < 500) {
      return fail(err.message);
    }
    throw err;
  }
}

async function runSendMessage(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const input = sendInput.parse(raw);
  if (input.to_agent_id !== null) {
    await requireAgent(ctx.db, input.to_agent_id);
  }
  ctx.intents.append(ctx.callerId, { toAgentId: input.to_agent_id, intent: input.intent });
  ctx.enqueueConversation(ctx.callerId);
  return ok({ handed_off: true });
}

async function runDispatchMessage(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const input = dispatchInput.parse(raw);
  if (input.to_agent_id !== null) {
    await requireAgent(ctx.db, input.to_agent_id);
  }
  const row = await deliverAgentMessage(
    {
      db: ctx.db,
      transcript: ctx.transcript,
      events: ctx.events,
      enqueueConversation: ctx.enqueueConversation,
    },
    {
      fromAgentId: ctx.callerId,
      toAgentId: input.to_agent_id,
      content: input.content,
    },
  );
  return ok({ to_agent_id: row.toAgentId, content: row.content, seq: row.seq });
}

async function runSteerReasoning(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const input = steerInput.parse(raw);
  ctx.steer.append(ctx.callerId, input.instruction);
  if (!ctx.locks.isBusy(ctx.callerId, "reasoning")) {
    ctx.enqueueReasoning(ctx.callerId);
  }
  return ok({ queued: true });
}

/** runListAgents returns id/name/parent/active for matching agents (global visibility). */
async function runListAgents(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  const input = listAgentsInput.parse(raw ?? {});
  const includeInactive = input.include_inactive ?? false;
  const conditions = [];
  if (input.id !== undefined) {
    conditions.push(eq(agents.id, input.id));
  }
  if (!includeInactive) {
    conditions.push(eq(agents.active, true));
  }
  const query = ctx.db
    .select({
      id: agents.id,
      parentAgentId: agents.parentAgentId,
      active: agents.active,
    })
    .from(agents)
    .orderBy(asc(agents.id));
  const rows =
    conditions.length === 0 ? await query : await query.where(and(...conditions));

  return ok({
    agents: rows.map((row) => ({
      id: row.id,
      name: row.id,
      parent_agent_id: row.parentAgentId,
      parent_name: row.parentAgentId,
      active: row.active,
    })),
  });
}
