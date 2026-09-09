/**
 * Built-in lane tools (send/dispatch/route/steer/yield) and the executeTool dispatcher.
 * Registry tools are resolved for the reasoning lane; conversation uses the switch below.
 */

import { z, ZodError } from "zod";
import { DimaagError } from "../errors.js";
import type { DwarTool, DwarToolUseBlock } from "../types/domain.js";
import {
  DISPATCH_MESSAGE,
  ROUTE_MESSAGE,
  SEND_MESSAGE,
  STEER_REASONING,
  YIELD,
} from "../types/domain.js";
import { findTool } from "../tools/registry.js";
import {
  fail,
  ok,
  requireAgent,
  type ToolContext,
  type ToolExecResult,
} from "../tools/shared.js";
import { deliverAgentMessage, deliverUserMessage } from "./deliver.js";

export type { ToolContext, ToolExecResult } from "../tools/shared.js";
export { requireAgent } from "../tools/shared.js";

export const sendMessageInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    to_agent_id: {
      type: ["string", "null"],
      description: "Recipient agent id, or null for the user",
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
      description: "Recipient agent id, or null for the user",
    },
    content: { type: "string", description: "The message to persist and deliver" },
  },
  required: ["to_agent_id", "content"],
};

export const routeMessageInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    to_agent_id: {
      type: "string",
      description: "Thread agent that should receive the user's message",
    },
    content: {
      type: "string",
      description: "The user's message, copied verbatim",
    },
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

/** Hand intent to conversation; does not persist a message. */
export const sendMessageTool: DwarTool = {
  name: SEND_MESSAGE,
  description:
    "Hand an intent to your conversation lane so it can compose and dispatch a message. Does not send anything itself. to_agent_id null is the user.",
  input_schema: sendMessageInputSchema,
};

/** Persist and deliver a message to another agent or the user. */
export const dispatchMessageTool: DwarTool = {
  name: DISPATCH_MESSAGE,
  description:
    "Write a message to another agent or to the user (to_agent_id null). This is the only way a message addressed to someone else is persisted. Does not end the turn — call yield when done.",
  input_schema: dispatchMessageInputSchema,
};

/** Root-only: copy the user's message onto a thread agent verbatim. */
export const routeMessageTool: DwarTool = {
  name: ROUTE_MESSAGE,
  description:
    "Copy the user's message onto a thread agent as if the user sent it there (from_agent_id null). Root-only. Use after spawning or picking a thread; do not rephrase — pass the user's content verbatim. Does not end the turn — call yield when done.",
  input_schema: routeMessageInputSchema,
};

/** Queue an instruction for the caller's reasoning lane. */
export const steerReasoningTool: DwarTool = {
  name: STEER_REASONING,
  description:
    "Queue an instruction for your own reasoning lane. Starts a reasoning run if that lane is idle.",
  input_schema: steerReasoningInputSchema,
};

/** End the current lane turn. */
export const yieldTool: DwarTool = {
  name: YIELD,
  description:
    "End this lane turn. Call when you have nothing more to do right now. Sending a message or running other tools does not end the turn — only yield does.",
  input_schema: yieldInputSchema,
};

const sendInput = z.object({
  to_agent_id: z.string().uuid().nullable(),
  intent: z.string().min(1),
});

const dispatchInput = z.object({
  to_agent_id: z.string().uuid().nullable(),
  content: z.string().min(1),
});

const routeInput = z.object({
  to_agent_id: z.string().uuid(),
  content: z.string().min(1),
});

const steerInput = z.object({
  instruction: z.string().min(1),
});

const yieldInput = z.object({}).strict();

/** Dispatch a tool_use block for the caller's lane; map Zod/4xx to tool errors. */
export async function executeTool(
  ctx: ToolContext,
  call: DwarToolUseBlock,
): Promise<ToolExecResult> {
  try {
    if (call.name === YIELD) {
      yieldInput.parse(call.input ?? {});
      return ok({ yielded: true });
    }
    if (ctx.lane === "reasoning") {
      if (call.name === SEND_MESSAGE) {
        return await runSendMessage(ctx, call.input);
      }
      const definition = findTool(call.name);
      if (!definition) {
        return fail(`unknown reasoning tool: ${call.name}`);
      }
      const parsed = definition.input.parse(call.input);
      return await definition.handler(ctx, parsed);
    }
    switch (call.name) {
      case DISPATCH_MESSAGE:
        return await runDispatchMessage(ctx, call.input);
      case ROUTE_MESSAGE:
        return await runRouteMessage(ctx, call.input);
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
  const input = sendInput.parse(raw);
  if (input.to_agent_id !== null) {
    await requireAgent(ctx.db, input.to_agent_id);
  }
  ctx.intents.append(ctx.callerId, { toAgentId: input.to_agent_id, intent: input.intent });
  ctx.enqueueConversation(ctx.callerId);
  return ok({ handed_off: true });
}

async function runDispatchMessage(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
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

async function runRouteMessage(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  const input = routeInput.parse(raw);
  const caller = await requireAgent(ctx.db, ctx.callerId);
  if (caller.parentAgentId !== null) {
    return fail("only the root agent may route_message");
  }
  await requireAgent(ctx.db, input.to_agent_id);
  const row = await deliverUserMessage(
    {
      db: ctx.db,
      transcript: ctx.transcript,
      events: ctx.events,
      enqueueConversation: ctx.enqueueConversation,
    },
    input.to_agent_id,
    input.content,
  );
  const routedSeq = ctx.transcript.markUserMessageRouted(
    ctx.callerId,
    input.content,
    input.to_agent_id,
  );
  return ok({
    to_agent_id: row.toAgentId,
    content: row.content,
    seq: row.seq,
    routed_source_seq: routedSeq,
  });
}

async function runSteerReasoning(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  const input = steerInput.parse(raw);
  ctx.steer.append(ctx.callerId, input.instruction);
  if (!ctx.locks.isBusy(ctx.callerId, "reasoning")) {
    ctx.enqueueReasoning(ctx.callerId);
  }
  return ok({ queued: true });
}
