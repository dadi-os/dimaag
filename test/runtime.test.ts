import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { DISPATCH_MESSAGE, MODIFY_AGENT, SEND_MESSAGE } from "../src/types/domain.js";
import { assembleContext } from "../src/runtime/context.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { agents, agentTools } from "../src/db/schema.js";
import { toolId } from "../src/tools/sync.js";
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
  const parentId = await insertAgent(handle.db, {
    name: "parent",
    systemPrompt: "parent prompt",
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
  const parentId = await insertAgent(handle.db, {
    name: "boss",
    systemPrompt: "boss prompt",
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

test("modify_agent renames self and a direct child", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, {
    name: "boss",
    systemPrompt: "boss prompt",
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
    input: { agent_id: parentId, name: "Boss Renamed" },
  });
  assert.equal(self.isError, false);
  const selfBody = JSON.parse(self.content);
  assert.equal(selfBody.old_name, "boss");
  assert.equal(selfBody.new_name, "Boss Renamed");
  assert.equal(self.audit.old_name, "boss");
  assert.equal(self.audit.new_name, "Boss Renamed");
  const [parent] = await handle.db.select().from(agents).where(eq(agents.id, parentId));
  assert.equal(parent?.name, "Boss Renamed");

  const child = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "rn-child",
    name: MODIFY_AGENT,
    input: { agent_id: childId, name: "Worker Renamed" },
  });
  assert.equal(child.isError, false);
  assert.equal(JSON.parse(child.content).new_name, "Worker Renamed");
  const [row] = await handle.db.select().from(agents).where(eq(agents.id, childId));
  assert.equal(row?.name, "Worker Renamed");
});

test("modify_agent rename of a stranger is rejected", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, {
    name: "parent",
    systemPrompt: "parent",
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
    input: { agent_id: strangerId, name: "Hijacked" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /direct children/);
  const [row] = await handle.db.select().from(agents).where(eq(agents.id, strangerId));
  assert.equal(row?.name, "stranger");
});

test("modify_agent rename collision is a tool error and leaves the row unchanged", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const selfId = await insertAgent(handle.db, {
    name: "alpha",
    systemPrompt: "alpha",
  });
  await insertAgent(handle.db, {
    name: "taken",
    systemPrompt: "taken",
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
    id: "rn-collision",
    name: MODIFY_AGENT,
    input: { agent_id: selfId, name: "taken" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /an agent named taken already exists/);
  const [row] = await handle.db.select().from(agents).where(eq(agents.id, selfId));
  assert.equal(row?.name, "alpha");
});

test("modify_agent accepts name alone", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const selfId = await insertAgent(handle.db, {
    name: "solo",
    systemPrompt: "keep me",
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
    input: { agent_id: selfId, name: "Solo Renamed" },
  });
  assert.equal(result.isError, false);
  const body = JSON.parse(result.content);
  assert.equal(body.new_name, "Solo Renamed");
  assert.equal(body.new_system_prompt, "keep me");
  assert.equal(body.active, true);
});

test("reasoning context has send_message and no dispatch_message", async () => {
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
  });
  const names = ctx.tools.map((tool) => tool.name);
  assert.ok(names.includes(SEND_MESSAGE));
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

test("conversation tools are dispatch_message, steer_reasoning, yield — never route_message", async () => {
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
  });
  const names = ctx.tools.map((tool) => tool.name);
  assert.ok(names.includes(DISPATCH_MESSAGE));
  assert.ok(names.includes("steer_reasoning"));
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
    input: { name: "no-prompt-child" },
  });
  assert.equal(missing.isError, true);

  const spawned = await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "sp1",
    name: "dimaag_spawn_agent",
    input: { name: "fresh-child", system_prompt: "do one job" },
  });
  assert.equal(spawned.isError, false);
  const childId = JSON.parse(spawned.content).agent_id as string;
  const childCtx = await assembleContext({
    db: handle.db,
    agentId: childId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
  });
  assert.deepEqual(
    childCtx.tools.map((tool) => tool.name),
    [SEND_MESSAGE, "yield"],
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
  });
  assert.ok(childCtx.tools.map((tool) => tool.name).includes("dimaag_modify_agent"));
});
