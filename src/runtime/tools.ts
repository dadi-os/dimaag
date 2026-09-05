import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { z, ZodError } from "zod";
import type { Db } from "../db/client.js";
import { writeAgentLog } from "../db/logs.js";
import { agentTools, agents, tools } from "../db/schema.js";
import { DimaagError } from "../errors.js";
import type { DwarTool, DwarToolUseBlock, Lane } from "../types/domain.js";
import {
  DISPATCH_MESSAGE,
  MODIFY_AGENT,
  SEND_MESSAGE,
  SPAWN_AGENT,
  STEER_REASONING,
} from "../types/domain.js";
import { findTool } from "../tools/registry.js";
import type { LaneLocks } from "./locks.js";
import type { SteerQueue } from "./steer.js";
import type { IntentQueue } from "./intents.js";
import type { TranscriptStore } from "./transcript.js";

export type ToolExecResult = {
  content: string;
  isError: boolean;
  audit: Record<string, unknown>;
};

export type ToolContext = {
  db: Db;
  callerId: string;
  lane: Lane;
  steer: SteerQueue;
  intents: IntentQueue;
  locks: LaneLocks;
  transcript: TranscriptStore;
  enqueueConversation: (agentId: string) => void;
  enqueueReasoning: (agentId: string) => void;
};

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

export const steerReasoningInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    instruction: { type: "string", description: "What reasoning should do next" },
  },
  required: ["instruction"],
};

export const spawnAgentInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    name: { type: "string", description: "Unique agent name" },
    system_prompt: {
      type: "string",
      description: "Prompt for both lanes. Omit to copy the caller's current prompt.",
    },
    tool_names: {
      type: "array",
      items: { type: "string" },
      description: "Registry tool names to grant the child",
    },
  },
  required: ["name", "tool_names"],
};

export const modifyAgentInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    agent_id: { type: "string", description: "Self or a direct child" },
    system_prompt: { type: "string" },
    active: { type: "boolean" },
  },
  required: ["agent_id"],
};

export const sendMessageTool: DwarTool = {
  name: SEND_MESSAGE,
  description:
    "Hand an intent to your conversation lane so it can compose and dispatch a message. Does not send anything itself. to_agent_id null is the user.",
  input_schema: sendMessageInputSchema,
};

export const dispatchMessageTool: DwarTool = {
  name: DISPATCH_MESSAGE,
  description:
    "Write a message to another agent or to the user (to_agent_id null). This is the only way a message addressed to someone else is persisted.",
  input_schema: dispatchMessageInputSchema,
};

export const steerReasoningTool: DwarTool = {
  name: STEER_REASONING,
  description:
    "Queue an instruction for your own reasoning lane. Starts a reasoning run if that lane is idle.",
  input_schema: steerReasoningInputSchema,
};

const sendInput = z.object({
  to_agent_id: z.string().uuid().nullable(),
  intent: z.string().min(1),
});

const dispatchInput = z.object({
  to_agent_id: z.string().uuid().nullable(),
  content: z.string().min(1),
});

const steerInput = z.object({
  instruction: z.string().min(1),
});

const spawnInput = z.object({
  name: z.string().min(1),
  system_prompt: z.string().min(1).optional(),
  tool_names: z.array(z.string().min(1)),
});

const modifyInput = z
  .object({
    agent_id: z.string().uuid(),
    system_prompt: z.string().min(1).optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => value.system_prompt !== undefined || value.active !== undefined, {
    message: "system_prompt or active is required",
  });

export async function executeTool(
  ctx: ToolContext,
  call: DwarToolUseBlock,
): Promise<ToolExecResult> {
  try {
    if (ctx.lane === "reasoning") {
      switch (call.name) {
        case SEND_MESSAGE:
          return await runSendMessage(ctx, call.input);
        case SPAWN_AGENT:
          return await runSpawnAgent(ctx, call.input);
        case MODIFY_AGENT:
          return await runModifyAgent(ctx, call.input);
        default: {
          const definition = findTool(call.name);
          if (!definition) {
            return fail(`unknown reasoning tool: ${call.name}`);
          }
          const parsed = definition.input.parse(call.input);
          return await definition.handler(ctx, parsed);
        }
      }
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

function fail(message: string): ToolExecResult {
  return { content: message, isError: true, audit: {} };
}

function ok(value: unknown, audit: Record<string, unknown> = {}): ToolExecResult {
  return { content: JSON.stringify(value), isError: false, audit };
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
  const row = ctx.transcript.append({
    fromAgentId: ctx.callerId,
    toAgentId: input.to_agent_id,
    content: input.content,
  });
  await writeAgentLog(ctx.db, {
    agentId: ctx.callerId,
    lane: "conversation",
    event: "message",
    payload: {
      direction: "send",
      message_id: null,
      from_agent_id: ctx.callerId,
      to_agent_id: row.toAgentId,
      content: row.content,
      seq: row.seq,
    },
  });
  if (row.toAgentId !== null) {
    await writeAgentLog(ctx.db, {
      agentId: row.toAgentId,
      lane: "conversation",
      event: "message",
      payload: {
        direction: "receive",
        message_id: null,
        from_agent_id: ctx.callerId,
        to_agent_id: row.toAgentId,
        content: row.content,
        seq: row.seq,
      },
    });
    ctx.enqueueConversation(row.toAgentId);
  }
  return ok({ to_agent_id: row.toAgentId, content: row.content, seq: row.seq });
}

async function runSteerReasoning(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  const input = steerInput.parse(raw);
  ctx.steer.append(ctx.callerId, input.instruction);
  if (!ctx.locks.isBusy(ctx.callerId, "reasoning")) {
    ctx.enqueueReasoning(ctx.callerId);
  }
  return ok({ queued: true });
}

async function runSpawnAgent(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  const input = spawnInput.parse(raw);
  const caller = await requireAgent(ctx.db, ctx.callerId);
  const systemPrompt = input.system_prompt ?? caller.systemPrompt;
  const toolRows =
    input.tool_names.length === 0
      ? []
      : await ctx.db.select().from(tools).where(inArray(tools.name, input.tool_names));
  if (toolRows.length !== input.tool_names.length) {
    const found = new Set(toolRows.map((row) => row.name));
    const missing = input.tool_names.filter((name) => !found.has(name));
    return fail(`unknown tools: ${missing.join(", ")}`);
  }

  const id = randomUUID();
  const now = new Date();
  try {
    await ctx.db.insert(agents).values({
      id,
      name: input.name,
      systemPrompt,
      parentAgentId: ctx.callerId,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(`agent name already exists: ${input.name}`);
    }
    throw err;
  }

  if (toolRows.length > 0) {
    await ctx.db.insert(agentTools).values(
      toolRows.map((tool) => ({
        agentId: id,
        toolId: tool.id,
        usage: "Granted at spawn.",
      })),
    );
  }

  return ok({ agent_id: id, name: input.name });
}

async function runModifyAgent(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  const input = modifyInput.parse(raw);
  const target = await requireAgent(ctx.db, input.agent_id);
  if (target.id !== ctx.callerId && target.parentAgentId !== ctx.callerId) {
    return fail("modify_agent is limited to self or direct children");
  }

  const oldPrompt = target.systemPrompt;
  const newPrompt = input.system_prompt ?? oldPrompt;
  const active = input.active ?? target.active;
  const now = new Date();
  await ctx.db
    .update(agents)
    .set({
      systemPrompt: newPrompt,
      active,
      updatedAt: now,
    })
    .where(eq(agents.id, target.id));

  return ok(
    {
      agent_id: target.id,
      old_system_prompt: oldPrompt,
      new_system_prompt: newPrompt,
      active,
    },
    { old_system_prompt: oldPrompt, new_system_prompt: newPrompt },
  );
}

export async function requireAgent(db: Db, id: string) {
  const rows = await db.select().from(agents).where(eq(agents.id, id));
  const row = rows[0];
  if (!row) {
    throw new DimaagError(404, "not_found", `agent ${id} not found`);
  }
  return row;
}

function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let i = 0; i < 4; i++) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      (current as { code: unknown }).code === "23505"
    ) {
      return true;
    }
    if (typeof current === "object" && current !== null && "cause" in current) {
      current = (current as { cause: unknown }).cause;
      continue;
    }
    break;
  }
  return false;
}
