import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { asc, eq } from "drizzle-orm";
import {
  DISPATCH_MESSAGE,
  GET_AGENT,
  LIST_AGENTS,
  MODIFY_AGENT,
  SEND_MESSAGE,
} from "../src/types/domain.js";
import { assembleContext } from "../src/runtime/context.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { agents, agentTools, scheduledMessages, tools } from "../src/db/schema.js";
import { writeAgentLog } from "../src/db/logs.js";
import { toolId } from "../src/tools/sync.js";
import { allTools, findTool } from "../src/tools/registry.js";
import {
  endTurn,
  insertAgent,
  insertManager,
  insertWorker,
  mockDwar,
  mockGhar,
  mockChaavi,
  mockNas,
  mockYaad,
  openTestDb,
  resetRuntime,
  silentLog,
  testConfig,
  toolUse,
  yieldTurn,
} from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

before(async () => {
  await migrate(config);
  await resetRuntime(handle.sql, handle.db, config);
});

after(async () => {
  await handle.close();
});

test("two concurrent messages to one agent serialize on its conversation lock", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: [],
  });
  let active = 0;
  let overlap = false;
  const dwar = mockDwar({
    converse: async () => {
      active += 1;
      if (active > 1) {
        overlap = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return endTurn();
    },
  });
  const runtime = createRuntime({ db: handle.db, dwar, ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(), yaad: mockYaad(), config, log: silentLog });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar,
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    runtime,
  });
  const body = {
    to_agent_id: workerId,
    content: "hello",
  };
  const [a, b] = await Promise.all([
    app.inject({ method: "POST", url: "/messages", payload: { ...body, content: "one" } }),
    app.inject({ method: "POST", url: "/messages", payload: { ...body, content: "two" } }),
  ]);
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 201);
  await runtime.waitUntilIdle();
  assert.equal(overlap, false);
  assert.equal(dwar.conversationCalls.length, 2);
  await app.close();
});

test("modify_agent on a non-child is rejected", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertWorker(handle.db, {
    name: "parent",
    systemPrompt: "parent prompt",
    tools: [MODIFY_AGENT],
  });
  const strangerId = await insertAgent(handle.db, {
    name: "stranger",
    systemPrompt: "stranger prompt",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "m1",
    name: MODIFY_AGENT,
    input: { agent_id: strangerId, active: false },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /direct children/);
});

test("modify_agent on a direct child is allowed", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertWorker(handle.db, {
    name: "boss",
    systemPrompt: "boss prompt",
    tools: [MODIFY_AGENT],
  });
  const childId = await insertAgent(handle.db, {
    name: "worker",
    systemPrompt: "old prompt",
    parentAgentId: parentId,
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "m2",
    name: MODIFY_AGENT,
    input: { agent_id: childId, system_prompt: "new prompt" },
  });
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.content).new_system_prompt, "new prompt");
  assert.equal(result.audit.old_system_prompt, "old prompt");
});

test("modify_agent updates prompt on self and a direct child", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertWorker(handle.db, {
    name: "boss",
    systemPrompt: "boss prompt",
    tools: [MODIFY_AGENT],
  });
  const childId = await insertAgent(handle.db, {
    name: "worker",
    systemPrompt: "child prompt",
    parentAgentId: parentId,
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });

  const self = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "rn-self",
    name: MODIFY_AGENT,
    input: { agent_id: parentId, system_prompt: "boss prompt v2" },
  });
  assert.equal(self.isError, false);
  const selfBody = JSON.parse(self.content);
  assert.equal(selfBody.old_system_prompt, "boss prompt");
  assert.equal(selfBody.new_system_prompt, "boss prompt v2");
  assert.equal(self.audit.old_system_prompt, "boss prompt");
  assert.equal(self.audit.new_system_prompt, "boss prompt v2");
  const [parent] = await handle.db.select().from(agents).where(eq(agents.id, parentId));
  assert.equal(parent?.systemPrompt, "boss prompt v2");
  assert.equal(parent?.id, "boss");

  const child = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "rn-child",
    name: MODIFY_AGENT,
    input: { agent_id: childId, system_prompt: "child prompt v2" },
  });
  assert.equal(child.isError, false);
  assert.equal(JSON.parse(child.content).new_system_prompt, "child prompt v2");
  const [row] = await handle.db.select().from(agents).where(eq(agents.id, childId));
  assert.equal(row?.systemPrompt, "child prompt v2");
  assert.equal(row?.id, "worker");
});

test("modify_agent of a stranger is rejected", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertWorker(handle.db, {
    name: "parent",
    systemPrompt: "parent",
    tools: [MODIFY_AGENT],
  });
  const strangerId = await insertAgent(handle.db, {
    name: "stranger",
    systemPrompt: "stranger",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "rn-stranger",
    name: MODIFY_AGENT,
    input: { agent_id: strangerId, system_prompt: "hijacked" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /direct children/);
  const [row] = await handle.db.select().from(agents).where(eq(agents.id, strangerId));
  assert.equal(row?.systemPrompt, "stranger");
});

test("modify_agent rejects empty updates", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const selfId = await insertWorker(handle.db, {
    name: "alpha",
    systemPrompt: "alpha",
    tools: [MODIFY_AGENT],
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(selfId, "reasoning"), {
    type: "tool_use",
    id: "rn-empty",
    name: MODIFY_AGENT,
    input: { agent_id: selfId },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /system_prompt or active is required/);
});

test("modify_agent accepts active alone", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const selfId = await insertWorker(handle.db, {
    name: "solo",
    systemPrompt: "keep me",
    tools: [MODIFY_AGENT],
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(selfId, "reasoning"), {
    type: "tool_use",
    id: "rn-only",
    name: MODIFY_AGENT,
    input: { agent_id: selfId, active: false },
  });
  assert.equal(result.isError, false);
  const body = JSON.parse(result.content);
  assert.equal(body.new_system_prompt, "keep me");
  assert.equal(body.active, false);
});

test("reasoning context has send_message, list_agents, and no dispatch_message", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: [],
  });
  const ctx = await assembleContext({
    db: handle.db,
    agentId: workerId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
  });
  const names = ctx.tools.map((tool) => tool.name);
  assert.ok(names.includes(SEND_MESSAGE));
  assert.ok(names.includes(LIST_AGENTS));
  assert.ok(names.includes("yield"));
  assert.equal(names.includes(DISPATCH_MESSAGE), false);
});

test("reasoning cannot write another agent's mailbox", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const callerId = await insertAgent(handle.db, {
    name: "caller",
    systemPrompt: "empty grants",
  });
  const targetId = await insertAgent(handle.db, {
    name: "mailbox",
    systemPrompt: "mailbox",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const before = runtime.transcript.transcriptFor(targetId).length;
  const result = await executeTool(runtime.toolContext(callerId, "reasoning"), {
    type: "tool_use",
    id: "d1",
    name: DISPATCH_MESSAGE,
    input: { to_agent_id: targetId, content: "sneak" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /unknown reasoning tool/);
  const after = runtime.transcript.transcriptFor(targetId).length;
  assert.equal(before, after);
});

test("a steer with reasoning idle starts a Dwar reasoning call", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const callerId = await insertAgent(handle.db, {
    name: "steer-caller",
    systemPrompt: "steer",
  });
  const dwar = mockDwar({
    reason: async () => endTurn("steered"),
    converse: async () => endTurn(),
  });
  const runtime = createRuntime({ db: handle.db, dwar, ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(), yaad: mockYaad(), config, log: silentLog });
  await executeTool(runtime.toolContext(callerId, "conversation"), {
    type: "tool_use",
    id: "s1",
    name: "steer_reasoning",
    input: { instruction: "wake up" },
  });
  await runtime.waitUntilIdle();
  assert.ok(dwar.reasoningCalls.length >= 1);
  const first = dwar.reasoningCalls[0];
  assert.ok(first);
  const blob = JSON.stringify(first.messages);
  assert.match(blob, /wake up/);
});

test("reasoning exit without send_message does not wake conversation", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const callerId = await insertAgent(handle.db, {
    name: "quiet-reasoner",
    systemPrompt: "think quietly",
  });
  const dwar = mockDwar({
    reason: async () => yieldTurn("r-yield"),
    converse: async () => endTurn(),
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar,
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    yaad: mockYaad(),
    config,
    log: silentLog,
  });
  runtime.transcript.append({
    fromAgentId: null,
    toAgentId: callerId,
    content: "earlier user note",
  });
  runtime.transcript.append({
    fromAgentId: callerId,
    toAgentId: null,
    content: "already replied",
  });
  await executeTool(runtime.toolContext(callerId, "conversation"), {
    type: "tool_use",
    id: "s-quiet",
    name: "steer_reasoning",
    input: { instruction: "think then stop" },
  });
  await runtime.waitUntilIdle();
  assert.ok(dwar.reasoningCalls.length >= 1);
  assert.equal(dwar.conversationCalls.length, 0);
});

test("send_message wakes conversation once; reasoning exit does not double-wake", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const callerId = await insertAgent(handle.db, {
    name: "handoff-reasoner",
    systemPrompt: "hand off",
  });
  let reasonTurn = 0;
  const dwar = mockDwar({
    reason: async () => {
      reasonTurn += 1;
      if (reasonTurn === 1) {
        return toolUse(
          SEND_MESSAGE,
          { to_agent_id: null, intent: "say hi" },
          "sm-1",
        );
      }
      return yieldTurn("r-yield");
    },
    converse: async () => yieldTurn("c-yield"),
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar,
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    yaad: mockYaad(),
    config,
    log: silentLog,
  });
  await executeTool(runtime.toolContext(callerId, "conversation"), {
    type: "tool_use",
    id: "s-handoff",
    name: "steer_reasoning",
    input: { instruction: "compose a hello" },
  });
  await runtime.waitUntilIdle();
  assert.ok(dwar.reasoningCalls.length >= 1);
  assert.equal(dwar.conversationCalls.length, 1);
  const converse = dwar.conversationCalls[0];
  assert.ok(converse);
  const blob = JSON.stringify(converse.messages);
  assert.match(blob, /say hi/);
  const last = converse.messages[converse.messages.length - 1];
  assert.ok(last);
  assert.equal(last.role, "user");
});

test("conversation tools are dispatch_message, steer_reasoning, list_agents, yield — never route_message", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: [],
  });
  const ctx = await assembleContext({
    db: handle.db,
    agentId: workerId,
    lane: "conversation",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
  });
  const names = ctx.tools.map((tool) => tool.name);
  assert.ok(names.includes(DISPATCH_MESSAGE));
  assert.ok(names.includes("steer_reasoning"));
  assert.ok(names.includes(LIST_AGENTS));
  assert.ok(names.includes("yield"));
  assert.equal(names.includes(SEND_MESSAGE), false);
  assert.equal(names.includes("route_message"), false);
});

test("spawn_agent requires system_prompt and grants nothing", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertManager(handle.db);
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const missing = await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "sp0",
    name: "dimaag_spawn_agent",
    input: { id: "no-prompt-child" },
  });
  assert.equal(missing.isError, true);

  const spawned = await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "sp1",
    name: "dimaag_spawn_agent",
    input: { id: "fresh-child", system_prompt: "do one job" },
  });
  assert.equal(spawned.isError, false);
  const childId = JSON.parse(spawned.content).agent_id as string;
  const childCtx = await assembleContext({
    db: handle.db,
    agentId: childId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
  });
  assert.deepEqual(
    childCtx.tools.map((tool) => tool.name),
    [SEND_MESSAGE, LIST_AGENTS, "yield"],
  );
});

test("grant_tool on a direct child succeeds and appears in assembleContext", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertManager(handle.db);
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const childId = await insertAgent(handle.db, {
    name: "grantee",
    systemPrompt: "child",
    parentAgentId: managerId,
  });
  const granted = await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "g1",
    name: "dimaag_grant_tool",
    input: {
      agent_id: childId,
      tool_name: "dimaag_modify_agent",
      usage: "tune your own prompt",
    },
  });
  assert.equal(granted.isError, false);
  const ctx = await assembleContext({
    db: handle.db,
    agentId: childId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
  });
  const names = ctx.tools.map((tool) => tool.name);
  assert.ok(names.includes("dimaag_modify_agent"));
  assert.ok(names.includes(SEND_MESSAGE));
});

test("grant_tool on a non-child fails", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertManager(handle.db);
  const strangerId = await insertAgent(handle.db, {
    name: "stranger-grant",
    systemPrompt: "stranger",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "g2",
    name: "dimaag_grant_tool",
    input: {
      agent_id: strangerId,
      tool_name: "dimaag_modify_agent",
      usage: "nope",
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /direct children/);
});

test("grant_tool and modify_agent reject a grandchild for a normal agent", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertManager(handle.db, {
    name: "grandparent",
    systemPrompt: "top",
  });
  const childId = await insertAgent(handle.db, {
    name: "child",
    systemPrompt: "mid",
    parentAgentId: parentId,
  });
  const grandchildId = await insertAgent(handle.db, {
    name: "grandchild",
    systemPrompt: "leaf",
    parentAgentId: childId,
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const grant = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "g-gc",
    name: "dimaag_grant_tool",
    input: {
      agent_id: grandchildId,
      tool_name: "yaad_recall",
      usage: "nope",
    },
  });
  assert.equal(grant.isError, true);
  assert.match(grant.content, /direct children/);

  const modify = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "m-gc",
    name: MODIFY_AGENT,
    input: { agent_id: grandchildId, active: false },
  });
  assert.equal(modify.isError, true);
  assert.match(modify.content, /direct children/);
});

test("as Dadi, grant_tool reaches a root and a nested agent under another parent", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const rootId = await insertAgent(handle.db, {
    name: "root-for-dadi",
    systemPrompt: "root",
  });
  const parentId = await insertAgent(handle.db, {
    name: "other-parent",
    systemPrompt: "parent",
  });
  const nestedId = await insertAgent(handle.db, {
    name: "nested-under-other",
    systemPrompt: "nested",
    parentAgentId: parentId,
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const dadi = runtime.toolContext(null, "reasoning");

  const rootGrant = await executeTool(dadi, {
    type: "tool_use",
    id: "dadi-root",
    name: "dimaag_grant_tool",
    input: {
      agent_id: rootId,
      tool_name: "yaad_recall",
      usage: "remember for the root",
    },
  });
  assert.equal(rootGrant.isError, false, rootGrant.content);

  const nestedGrant = await executeTool(dadi, {
    type: "tool_use",
    id: "dadi-nested",
    name: "dimaag_grant_tool",
    input: {
      agent_id: nestedId,
      tool_name: "yaad_query",
      usage: "query for the nested agent",
    },
  });
  assert.equal(nestedGrant.isError, false, nestedGrant.content);

  const grants = await handle.db.select().from(agentTools);
  const byAgent = new Map(grants.map((row) => [row.agentId, row.toolId]));
  assert.equal(byAgent.get(rootId), toolId("yaad_recall"));
  assert.equal(byAgent.get(nestedId), toolId("yaad_query"));
});

test("as Dadi, modify_agent can change any agent", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, {
    name: "parent-mod",
    systemPrompt: "parent",
  });
  const nestedId = await insertAgent(handle.db, {
    name: "nested-mod",
    systemPrompt: "old",
    parentAgentId: parentId,
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(null, "reasoning"), {
    type: "tool_use",
    id: "dadi-mod",
    name: MODIFY_AGENT,
    input: {
      agent_id: nestedId,
      system_prompt: "new",
      active: false,
    },
  });
  assert.equal(result.isError, false, result.content);
  const [row] = await handle.db.select().from(agents).where(eq(agents.id, nestedId));
  assert.equal(row?.id, "nested-mod");
  assert.equal(row?.systemPrompt, "new");
  assert.equal(row?.active, false);
});

const storedPrompt = "revise me in place\nkeep  the double space\tand \"quotes\" — café";

test("get_agent returns a direct child's stored prompt byte for byte", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertWorker(handle.db, {
    name: "prompt-parent",
    systemPrompt: "parent",
    tools: [GET_AGENT],
  });
  const childId = await insertAgent(handle.db, {
    name: "prompt-child",
    systemPrompt: storedPrompt,
    parentAgentId: parentId,
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "get-child",
    name: GET_AGENT,
    input: { agent_id: childId },
  });
  assert.equal(result.isError, false, result.content);
  const body = JSON.parse(result.content) as { system_prompt: string; parent_agent_id: string };
  assert.equal(body.system_prompt, storedPrompt);
  assert.equal(body.parent_agent_id, parentId);
  const [row] = await handle.db.select().from(agents).where(eq(agents.id, childId));
  assert.equal(body.system_prompt, row?.systemPrompt);
});

test("get_agent lets an agent read itself", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const selfId = await insertWorker(handle.db, {
    name: "self-reader",
    systemPrompt: storedPrompt,
    tools: [GET_AGENT],
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(selfId, "reasoning"), {
    type: "tool_use",
    id: "get-self",
    name: GET_AGENT,
    input: { agent_id: selfId },
  });
  assert.equal(result.isError, false, result.content);
  const body = JSON.parse(result.content) as {
    name: string;
    system_prompt: string;
    parent_agent_id: string | null;
    active: boolean;
  };
  assert.equal(body.name, "self-reader");
  assert.equal(body.system_prompt, storedPrompt);
  assert.equal(body.parent_agent_id, null);
  assert.equal(body.active, true);
});

test("get_agent refuses a grandchild and a sibling with the self-or-direct-child rule", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const grandparentId = await insertWorker(handle.db, {
    name: "grandparent",
    systemPrompt: "top",
    tools: [GET_AGENT],
  });
  const childId = await insertAgent(handle.db, {
    name: "mid",
    systemPrompt: "mid",
    parentAgentId: grandparentId,
  });
  const grandchildId = await insertAgent(handle.db, {
    name: "leaf",
    systemPrompt: "leaf prompt",
    parentAgentId: childId,
  });
  const siblingId = await insertWorker(handle.db, {
    name: "sibling",
    systemPrompt: "sibling",
    parentAgentId: grandparentId,
    tools: [GET_AGENT],
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });

  const grandchild = await executeTool(runtime.toolContext(grandparentId, "reasoning"), {
    type: "tool_use",
    id: "get-grandchild",
    name: GET_AGENT,
    input: { agent_id: grandchildId },
  });
  assert.equal(grandchild.isError, true);
  assert.match(grandchild.content, /self or direct children/);
  assert.doesNotMatch(grandchild.content, /not found/);

  const sibling = await executeTool(runtime.toolContext(siblingId, "reasoning"), {
    type: "tool_use",
    id: "get-sibling",
    name: GET_AGENT,
    input: { agent_id: childId },
  });
  assert.equal(sibling.isError, true);
  assert.match(sibling.content, /self or direct children/);
  assert.doesNotMatch(sibling.content, /not found/);
});

test("as Dadi, get_agent reads any agent", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, {
    name: "other-parent",
    systemPrompt: "parent",
  });
  const nestedId = await insertAgent(handle.db, {
    name: "nested-stranger",
    systemPrompt: storedPrompt,
    parentAgentId: parentId,
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(null, "reasoning", "dadi"), {
    type: "tool_use",
    id: "dadi-get",
    name: GET_AGENT,
    input: { agent_id: nestedId },
  });
  assert.equal(result.isError, false, result.content);
  assert.equal(JSON.parse(result.content).system_prompt, storedPrompt);
});

test("get_agent tool names match agent_tools for that agent", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertWorker(handle.db, {
    name: "tools-parent",
    systemPrompt: "parent",
    tools: [GET_AGENT],
  });
  const childId = await insertWorker(handle.db, {
    name: "tools-child",
    systemPrompt: "child",
    parentAgentId: parentId,
    tools: ["yaad_recall", "dimaag_schedule_message"],
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "get-tools",
    name: GET_AGENT,
    input: { agent_id: childId },
  });
  assert.equal(result.isError, false, result.content);
  const held = await handle.db
    .select({ name: tools.name })
    .from(agentTools)
    .innerJoin(tools, eq(agentTools.toolId, tools.id))
    .where(eq(agentTools.agentId, childId))
    .orderBy(asc(tools.name));
  assert.deepEqual(
    (JSON.parse(result.content) as { tools: string[] }).tools,
    held.map((row) => row.name),
  );
  assert.deepEqual((JSON.parse(result.content) as { tools: string[] }).tools, [
    "dimaag_schedule_message",
    "yaad_recall",
  ]);
});

test("get_agent then modify_agent with the same prompt leaves it identical", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertWorker(handle.db, {
    name: "round-parent",
    systemPrompt: "parent",
    tools: [GET_AGENT, MODIFY_AGENT],
  });
  const childId = await insertAgent(handle.db, {
    name: "round-child",
    systemPrompt: storedPrompt,
    parentAgentId: parentId,
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const ctx = runtime.toolContext(parentId, "reasoning");
  const before = await executeTool(ctx, {
    type: "tool_use",
    id: "round-read",
    name: GET_AGENT,
    input: { agent_id: childId },
  });
  assert.equal(before.isError, false, before.content);
  const prompt = (JSON.parse(before.content) as { system_prompt: string }).system_prompt;
  assert.equal(prompt, storedPrompt);

  const modified = await executeTool(ctx, {
    type: "tool_use",
    id: "round-write",
    name: MODIFY_AGENT,
    input: { agent_id: childId, system_prompt: prompt },
  });
  assert.equal(modified.isError, false, modified.content);

  const after = await executeTool(ctx, {
    type: "tool_use",
    id: "round-reread",
    name: GET_AGENT,
    input: { agent_id: childId },
  });
  assert.equal(after.isError, false, after.content);
  assert.equal((JSON.parse(after.content) as { system_prompt: string }).system_prompt, prompt);
  const [row] = await handle.db.select().from(agents).where(eq(agents.id, childId));
  assert.equal(row?.systemPrompt, storedPrompt);
});

test("as Dadi, schedule_message fails without writing a row", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const targetId = await insertAgent(handle.db, {
    name: "sched-target",
    systemPrompt: "target",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const before = await handle.db.select().from(scheduledMessages);
  const result = await executeTool(runtime.toolContext(null, "reasoning"), {
    type: "tool_use",
    id: "dadi-sched",
    name: "dimaag_schedule_message",
    input: {
      to_agent_id: targetId,
      content: "later",
      run_at: new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /agent identity/);
  const after = await handle.db.select().from(scheduledMessages);
  assert.equal(after.length, before.length);
});

test("as Dadi, send_message and dispatch_message fail and deliver nothing", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const targetId = await insertAgent(handle.db, {
    name: "msg-target",
    systemPrompt: "target",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const before = runtime.transcript.transcriptFor(targetId).length;

  const send = await executeTool(runtime.toolContext(null, "reasoning"), {
    type: "tool_use",
    id: "dadi-send",
    name: SEND_MESSAGE,
    input: { to_agent_id: targetId, intent: "say hi" },
  });
  assert.equal(send.isError, true);
  assert.match(send.content, /agent identity/);

  const dispatch = await executeTool(runtime.toolContext(null, "conversation"), {
    type: "tool_use",
    id: "dadi-dispatch",
    name: DISPATCH_MESSAGE,
    input: { to_agent_id: targetId, content: "hi" },
  });
  assert.equal(dispatch.isError, true);
  assert.match(dispatch.content, /agent identity/);

  assert.equal(runtime.transcript.transcriptFor(targetId).length, before);
});

test("grant_tool naming an unknown tool fails", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertManager(handle.db);
  const childId = await insertAgent(handle.db, {
    name: "unknown-tool-child",
    systemPrompt: "child",
    parentAgentId: managerId,
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "g3",
    name: "dimaag_grant_tool",
    input: {
      agent_id: childId,
      tool_name: "not_a_real_tool",
      usage: "nope",
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /no tool named not_a_real_tool/);
});

test("revoke_tool removes a grant and fails when the child does not hold it", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertManager(handle.db);
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const childId = await insertAgent(handle.db, {
    name: "revoke-child",
    systemPrompt: "child",
    parentAgentId: managerId,
  });
  await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "r0",
    name: "dimaag_grant_tool",
    input: {
      agent_id: childId,
      tool_name: "dimaag_modify_agent",
      usage: "temporary",
    },
  });
  const revoked = await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "r1",
    name: "dimaag_revoke_tool",
    input: { agent_id: childId, tool_name: "dimaag_modify_agent" },
  });
  assert.equal(revoked.isError, false);
  const ctx = await assembleContext({
    db: handle.db,
    agentId: childId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
  });
  assert.equal(
    ctx.tools.map((tool) => tool.name).includes("dimaag_modify_agent"),
    false,
  );
  const again = await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "r2",
    name: "dimaag_revoke_tool",
    input: { agent_id: childId, tool_name: "dimaag_modify_agent" },
  });
  assert.equal(again.isError, true);
  assert.match(again.content, /does not hold/);
});

test("an agent can grant a tool it does not itself hold", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, {
    name: "router",
    systemPrompt: "router",
  });
  const childId = await insertAgent(handle.db, {
    name: "worker",
    systemPrompt: "worker",
    parentAgentId: parentId,
  });
  await handle.db.insert(agentTools).values({
    agentId: parentId,
    toolId: toolId("dimaag_grant_tool"),
    usage: "delegate tools",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const parentCtx = await assembleContext({
    db: handle.db,
    agentId: parentId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
  });
  assert.equal(
    parentCtx.tools.map((tool) => tool.name).includes("dimaag_modify_agent"),
    false,
  );
  const granted = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "g4",
    name: "dimaag_grant_tool",
    input: {
      agent_id: childId,
      tool_name: "dimaag_modify_agent",
      usage: "you may modify yourself",
    },
  });
  assert.equal(granted.isError, false);
  const childCtx = await assembleContext({
    db: handle.db,
    agentId: childId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
  });
  assert.ok(childCtx.tools.map((tool) => tool.name).includes("dimaag_modify_agent"));
});

test("list_agents is in both lanes for an agent with no grants", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, {
    name: "no-grants",
    systemPrompt: "empty",
  });
  const reasoning = await assembleContext({
    db: handle.db,
    agentId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
  });
  const conversation = await assembleContext({
    db: handle.db,
    agentId,
    lane: "conversation",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
  });
  assert.deepEqual(reasoning.tools.map((tool) => tool.name), [
    SEND_MESSAGE,
    LIST_AGENTS,
    "yield",
  ]);
  assert.ok(conversation.tools.map((tool) => tool.name).includes(LIST_AGENTS));
});

test("list_agents is absent from GET /tools, the tools table, and grant_tool", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  assert.equal(findTool(LIST_AGENTS), undefined);
  assert.equal(
    allTools().some((tool) => tool.name === LIST_AGENTS),
    false,
  );
  const rows = await handle.db.select().from(tools).where(eq(tools.name, LIST_AGENTS));
  assert.equal(rows.length, 0);

  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
  });
  const res = await app.inject({ method: "GET", url: "/tools" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { tools: { name: string }[] };
  assert.equal(
    body.tools.some((tool) => tool.name === LIST_AGENTS),
    false,
  );
  await app.close();

  const managerId = await insertManager(handle.db);
  const childId = await insertAgent(handle.db, {
    name: "grant-list-child",
    systemPrompt: "child",
    parentAgentId: managerId,
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const granted = await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "g-list",
    name: "dimaag_grant_tool",
    input: {
      agent_id: childId,
      tool_name: LIST_AGENTS,
      usage: "should fail",
    },
  });
  assert.equal(granted.isError, true);
  assert.match(granted.content, /no tool named list_agents/);
});

test("list_agents exact id is case-sensitive and empty on miss", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const codingId = await insertAgent(handle.db, {
    name: "coding-manager",
    systemPrompt: "terminals",
  });
  const callerId = await insertAgent(handle.db, {
    name: "caller",
    systemPrompt: "look up",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const hit = await executeTool(runtime.toolContext(callerId, "reasoning"), {
    type: "tool_use",
    id: "la1",
    name: LIST_AGENTS,
    input: { id: "coding-manager" },
  });
  assert.equal(hit.isError, false);
  const hitBody = JSON.parse(hit.content) as {
    agents: { id: string; name: string; parent_agent_id: string | null; parent_name: string | null; active: boolean }[];
  };
  assert.equal(hitBody.agents.length, 1);
  assert.equal(hitBody.agents[0]?.id, codingId);
  assert.equal(hitBody.agents[0]?.name, "coding-manager");
  assert.equal(hitBody.agents[0]?.parent_agent_id, null);
  assert.equal(hitBody.agents[0]?.parent_name, null);
  assert.equal(hitBody.agents[0]?.active, true);

  const missCase = await executeTool(runtime.toolContext(callerId, "reasoning"), {
    type: "tool_use",
    id: "la2",
    name: LIST_AGENTS,
    input: { id: "coding-manger" },
  });
  assert.equal(missCase.isError, false);
  assert.deepEqual(JSON.parse(missCase.content).agents, []);

  const missName = await executeTool(runtime.toolContext(callerId, "reasoning"), {
    type: "tool_use",
    id: "la3",
    name: LIST_AGENTS,
    input: { id: "does-not-exist" },
  });
  assert.equal(missName.isError, false);
  assert.deepEqual(JSON.parse(missName.content).agents, []);
});

test("list_agents omits dormant agents unless include_inactive", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const activeId = await insertAgent(handle.db, {
    name: "active-root",
    systemPrompt: "active",
  });
  const dormantId = await insertAgent(handle.db, {
    name: "dormant-root",
    systemPrompt: "asleep",
  });
  await handle.db.update(agents).set({ active: false }).where(eq(agents.id, dormantId));
  const callerId = await insertAgent(handle.db, {
    name: "lister",
    systemPrompt: "list",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });

  const activeOnly = await executeTool(runtime.toolContext(callerId, "reasoning"), {
    type: "tool_use",
    id: "la4",
    name: LIST_AGENTS,
    input: {},
  });
  assert.equal(activeOnly.isError, false);
  const activeBody = JSON.parse(activeOnly.content) as {
    agents: { id: string; name: string; active: boolean }[];
  };
  const activeIds = new Set(activeBody.agents.map((row) => row.id));
  assert.ok(activeIds.has(activeId));
  assert.ok(activeIds.has(callerId));
  assert.equal(activeIds.has(dormantId), false);

  const withInactive = await executeTool(runtime.toolContext(callerId, "reasoning"), {
    type: "tool_use",
    id: "la5",
    name: LIST_AGENTS,
    input: { include_inactive: true },
  });
  assert.equal(withInactive.isError, false);
  const inactiveBody = JSON.parse(withInactive.content) as {
    agents: { id: string; name: string; active: boolean }[];
  };
  const dormant = inactiveBody.agents.find((row) => row.id === dormantId);
  assert.ok(dormant);
  assert.equal(dormant.active, false);
  assert.equal(dormant.name, "dormant-root");
});

test("list_agents resolves parent_name when the parent is dormant", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, {
    name: "dormant-parent",
    systemPrompt: "asleep",
  });
  await handle.db.update(agents).set({ active: false }).where(eq(agents.id, parentId));
  const childId = await insertAgent(handle.db, {
    name: "awake-child",
    systemPrompt: "nested",
    parentAgentId: parentId,
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const listed = await executeTool(runtime.toolContext(childId, "reasoning"), {
    type: "tool_use",
    id: "la7",
    name: LIST_AGENTS,
    input: { id: "awake-child" },
  });
  assert.equal(listed.isError, false);
  const body = JSON.parse(listed.content) as {
    agents: { id: string; parent_agent_id: string | null; parent_name: string | null }[];
  };
  assert.equal(body.agents.length, 1);
  assert.equal(body.agents[0]?.parent_agent_id, parentId);
  assert.equal(body.agents[0]?.parent_name, "dormant-parent");
});

test("list_agents visibility is global across parents", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const rootA = await insertAgent(handle.db, {
    name: "root-a",
    systemPrompt: "a",
  });
  const rootB = await insertAgent(handle.db, {
    name: "root-b",
    systemPrompt: "b",
  });
  const childOfB = await insertAgent(handle.db, {
    name: "child-of-b",
    systemPrompt: "nested",
    parentAgentId: rootB,
  });
  const nestedCaller = await insertAgent(handle.db, {
    name: "nested-caller",
    systemPrompt: "under a",
    parentAgentId: rootA,
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });

  const listed = await executeTool(runtime.toolContext(nestedCaller, "conversation"), {
    type: "tool_use",
    id: "la6",
    name: LIST_AGENTS,
    input: {},
  });
  assert.equal(listed.isError, false);
  const body = JSON.parse(listed.content) as {
    agents: {
      id: string;
      name: string;
      parent_agent_id: string | null;
      parent_name: string | null;
    }[];
  };
  const byId = new Map(body.agents.map((row) => [row.id, row]));
  assert.ok(byId.has(rootA));
  assert.ok(byId.has(rootB));
  assert.ok(byId.has(childOfB));
  assert.ok(byId.has(nestedCaller));
  assert.equal(byId.get(childOfB)?.parent_agent_id, rootB);
  assert.equal(byId.get(childOfB)?.parent_name, "root-b");
  assert.equal(byId.get(nestedCaller)?.parent_name, "root-a");
});

test("dimaag_get_logs defaults to caller and allows direct children only", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertWorker(handle.db, {
    name: "log-parent",
    systemPrompt: "parent",
    tools: ["dimaag_get_logs"],
  });
  const childId = await insertWorker(handle.db, {
    name: "log-child",
    systemPrompt: "child",
    parentAgentId: parentId,
    tools: ["dimaag_get_logs"],
  });
  const strangerId = await insertWorker(handle.db, {
    name: "log-stranger",
    systemPrompt: "stranger",
    tools: ["dimaag_get_logs"],
  });
  await writeAgentLog(handle.db, {
    agentId: parentId,
    lane: "reasoning",
    event: "thought",
    payload: { text: "parent thought" },
  });
  await writeAgentLog(handle.db, {
    agentId: childId,
    lane: "reasoning",
    event: "thought",
    payload: { text: "child thought" },
  });
  await writeAgentLog(handle.db, {
    agentId: strangerId,
    lane: "reasoning",
    event: "thought",
    payload: { text: "stranger thought" },
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });

  const self = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "gl1",
    name: "dimaag_get_logs",
    input: {},
  });
  assert.equal(self.isError, false, self.content);
  const selfBody = JSON.parse(self.content) as {
    logs: Array<{ agent_id: string; payload: { text: string } }>;
  };
  assert.equal(selfBody.logs.length, 1);
  assert.equal(selfBody.logs[0]?.agent_id, parentId);
  assert.equal(selfBody.logs[0]?.payload.text, "parent thought");

  const child = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "gl2",
    name: "dimaag_get_logs",
    input: { agent_id: childId },
  });
  assert.equal(child.isError, false, child.content);
  const childBody = JSON.parse(child.content) as {
    logs: Array<{ agent_id: string; payload: { text: string } }>;
  };
  assert.equal(childBody.logs.length, 1);
  assert.equal(childBody.logs[0]?.agent_id, childId);

  const denied = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "gl3",
    name: "dimaag_get_logs",
    input: { agent_id: strangerId },
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content, /direct children/);

  const asDadi = await executeTool(runtime.toolContext(null, "reasoning"), {
    type: "tool_use",
    id: "gl4",
    name: "dimaag_get_logs",
    input: {},
  });
  assert.equal(asDadi.isError, true);
  assert.match(asDadi.content, /agent identity/);
});

test("executeTool denies registry tools without grant or when inactive", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const ungranted = await insertWorker(handle.db, {
    name: "no-grant",
    systemPrompt: "none",
    tools: [],
  });
  const dormant = await insertWorker(handle.db, {
    name: "dormant-worker",
    systemPrompt: "asleep",
    tools: ["yaad_recall"],
  });
  await handle.db.update(agents).set({ active: false }).where(eq(agents.id, dormant));
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });

  const noGrant = await executeTool(runtime.toolContext(ungranted, "reasoning"), {
    type: "tool_use",
    id: "eg1",
    name: "yaad_recall",
    input: { query: "x" },
  });
  assert.equal(noGrant.isError, true);
  assert.match(noGrant.content, /does not hold yaad_recall/);

  const inactive = await executeTool(runtime.toolContext(dormant, "reasoning"), {
    type: "tool_use",
    id: "eg2",
    name: "yaad_recall",
    input: { query: "x" },
  });
  assert.equal(inactive.isError, true);
  assert.match(inactive.content, /inactive/);
});
