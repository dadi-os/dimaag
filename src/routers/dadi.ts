/** `POST /dadi` — classify once, then spawn/reuse/modify. Not an agent. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentIdSchema } from "../agent-id.js";
import { agentTools, agents } from "../db/schema.js";
import { DimaagError } from "../errors.js";
import { patchMessageContent } from "../runtime/attachments.js";
import { deliverUserMessage } from "../runtime/deliver.js";
import { requireAgent } from "../runtime/tools.js";
import { findTool } from "../tools/registry.js";
import { isUniqueViolation } from "../tools/shared.js";
import { toolId } from "../tools/sync.js";
import type { DwarTool, DwarToolUseBlock } from "../types/domain.js";
import { formatZod, postDadiBody, parse } from "./schemas.js";

const decideTool: DwarTool = {
  name: "decide",
  description:
    "Choose reuse, spawn, or modify. Call exactly once. thread_id must be a listed id when reusing or modifying. Spawn uses an immutable kebab-case id (not a separate name). Modify cannot rename.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["reuse", "spawn", "modify"],
      },
      thread_id: {
        type: "string",
        description: "Existing top-level thread to reuse, or any agent to modify",
      },
      id: {
        type: "string",
        description:
          "Immutable kebab-case agent id when spawning (e.g. finance-specialist, coding-manager)",
      },
      system_prompt: {
        type: "string",
        description: "Job prompt when spawning, or replacement prompt when modifying",
      },
      active: {
        type: "boolean",
        description: "When modifying, whether the agent stays active",
      },
      grants: {
        type: "array",
        description:
          "Tools to grant on spawn. Each entry is a registry tool_name plus usage for this agent.",
        items: {
          type: "object",
          properties: {
            tool_name: { type: "string", description: "Registry tool name" },
            usage: {
              type: "string",
              description: "When and why this agent should use this tool",
            },
          },
          required: ["tool_name", "usage"],
        },
      },
    },
    required: ["action"],
  },
};

const grantEntry = z.object({
  tool_name: z.string().min(1),
  usage: z.string().min(1),
});

const reuseDecision = z.object({
  action: z.literal("reuse"),
  thread_id: agentIdSchema,
});

const spawnDecision = z.object({
  action: z.literal("spawn"),
  id: agentIdSchema,
  system_prompt: z.string().min(1),
  grants: z.array(grantEntry).optional(),
});

const modifyDecision = z.object({
  action: z.literal("modify"),
  thread_id: agentIdSchema,
  system_prompt: z.string().min(1).optional(),
  active: z.boolean().optional(),
});

const decideInput = z
  .discriminatedUnion("action", [reuseDecision, spawnDecision, modifyDecision])
  .superRefine((value, ctx) => {
    if (
      value.action === "modify" &&
      value.system_prompt === undefined &&
      value.active === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "system_prompt or active is required",
      });
    }
  });

/** Register the Dadi router endpoint. */
export async function registerDadi(app: FastifyInstance): Promise<void> {
  app.post("/dadi", async (request, reply) => {
    const body = parse(postDadiBody, request.body);
    const content = await patchMessageContent(
      app.dwar,
      body.content,
      body.attachments,
    );
    const startedAt = new Date().toISOString();
    app.runtime.events.emit({ type: "dadi_started", at: startedAt });
    try {
      const result = await routeDadi(app, content);
      app.runtime.events.emit({
        type: "dadi_finished",
        at: new Date().toISOString(),
      });
      return reply.status(201).send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.runtime.events.emit({
        type: "dadi_failed",
        message,
        at: new Date().toISOString(),
      });
      throw err;
    }
  });
}

/** Classify with Dwar, then spawn, reuse, or modify. */
async function routeDadi(
  app: FastifyInstance,
  content: string,
): Promise<Record<string, unknown>> {
  const policy = readFileSync(join(app.config.serviceRoot, "prompts/dadi.md"), "utf8");
  const roster = await listTopLevelThreads(app);
  const system =
    roster.length > 0
      ? `${policy}\n\nTop-level threads:\n${roster.join("\n")}`
      : `${policy}\n\nThere are no top-level threads yet. Spawn one when the utterance is work.`;

  const response = await app.dwar.complete(
    {
      system,
      messages: [{ role: "user", content }],
      tools: [decideTool],
    },
    "dimaag/dadi",
  );
  const call = response.content.find(
    (block): block is DwarToolUseBlock => block.type === "tool_use" && block.name === "decide",
  );
  if (!call) {
    throw new DimaagError(502, "dwar", "Dadi did not call decide");
  }

  const parsed = decideInput.safeParse(call.input);
  if (!parsed.success) {
    throw new DimaagError(
      502,
      "dwar",
      `Dadi decide input is invalid: ${formatZod(parsed.error)}`,
    );
  }

  if (parsed.data.action === "reuse") {
    const thread = await requireAgent(app.db, parsed.data.thread_id);
    if (thread.parentAgentId !== null) {
      throw new DimaagError(422, "invalid_request", "reuse is limited to top-level threads");
    }
    if (!thread.active) {
      const now = new Date();
      await app.db
        .update(agents)
        .set({
          active: true,
          updatedAt: now,
        })
        .where(eq(agents.id, thread.id));
      app.runtime.events.emit({
        type: "agent_modified",
        agent_id: thread.id,
        name: thread.id,
        active: true,
        at: now.toISOString(),
      });
    }
    return deliverRouted(app, thread.id, content, false);
  }

  if (parsed.data.action === "spawn") {
    const grants = parsed.data.grants ?? [];
    const spawnId = parsed.data.id;
    const spawnPrompt = parsed.data.system_prompt;
    const seenTools = new Set<string>();
    for (const grant of grants) {
      if (seenTools.has(grant.tool_name)) {
        throw new DimaagError(
          422,
          "invalid_request",
          `duplicate grant for tool ${grant.tool_name}`,
        );
      }
      seenTools.add(grant.tool_name);
      if (!findTool(grant.tool_name)) {
        throw new DimaagError(422, "invalid_request", `no tool named ${grant.tool_name}`);
      }
    }
    try {
      await app.db.transaction(async (tx) => {
        await tx.insert(agents).values({
          id: spawnId,
          systemPrompt: spawnPrompt,
          parentAgentId: null,
          active: true,
        });
        for (const grant of grants) {
          await tx.insert(agentTools).values({
            agentId: spawnId,
            toolId: toolId(grant.tool_name),
            usage: grant.usage,
          });
        }
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DimaagError(
          409,
          "conflict",
          `an agent with id ${spawnId} already exists`,
        );
      }
      throw err;
    }
    app.runtime.events.emit({
      type: "agent_spawned",
      agent_id: spawnId,
      parent_agent_id: null,
      name: spawnId,
      at: new Date().toISOString(),
    });
    return deliverRouted(app, spawnId, content, true);
  }

  const target = await requireAgent(app.db, parsed.data.thread_id);
  const now = new Date();
  const systemPrompt = parsed.data.system_prompt ?? target.systemPrompt;
  const active = parsed.data.active ?? target.active;
  await app.db
    .update(agents)
    .set({
      systemPrompt,
      active,
      updatedAt: now,
    })
    .where(eq(agents.id, target.id));
  app.runtime.events.emit({
    type: "agent_modified",
    agent_id: target.id,
    name: target.id,
    active,
    at: now.toISOString(),
  });
  return {
    action: "modified",
    agent_id: target.id,
    name: target.id,
    active,
    system_prompt: systemPrompt,
  };
}

/** Persist the user utterance onto a thread and wake its conversation lane. */
async function deliverRouted(
  app: FastifyInstance,
  threadId: string,
  content: string,
  created: boolean,
): Promise<Record<string, unknown>> {
  const row = await deliverUserMessage(
    {
      db: app.db,
      transcript: app.runtime.transcript,
      events: app.runtime.events,
      enqueueConversation: app.runtime.enqueueConversation,
    },
    threadId,
    content,
  );
  return {
    action: "routed",
    thread_id: threadId,
    created,
    content: row.content,
    seq: row.seq,
    created_at: row.createdAt.toISOString(),
  };
}

/** listTopLevelThreads returns root agents for the classification prompt (active and dormant). */
async function listTopLevelThreads(app: FastifyInstance): Promise<string[]> {
  const rows = await app.db
    .select({
      id: agents.id,
      active: agents.active,
      systemPrompt: agents.systemPrompt,
    })
    .from(agents)
    .where(isNull(agents.parentAgentId));
  return rows.map((row) => {
    const purpose = row.systemPrompt.trim().split(/\n/)[0] ?? "";
    const brief = purpose.length > 120 ? `${purpose.slice(0, 117)}…` : purpose;
    const status = row.active ? "active" : "dormant";
    const head = `- ${row.id} [${status}]`;
    return brief ? `${head}: ${brief}` : head;
  });
}
