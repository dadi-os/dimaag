import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DISPATCH_MESSAGE, MODIFY_AGENT, ROOT_DADI_ID, SEND_MESSAGE } from "../src/types/domain.js";
import { assembleContext } from "../src/runtime/context.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { agentTools } from "../src/db/schema.js";
import { toolId } from "../src/tools/sync.js";
import {
  endTurn,
  insertAgent,
  mockDwar,
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
  const runtime = createRuntime({ db: handle.db, dwar, yaad: mockYaad(), config, log: silentLog });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar,
    yaad: mockYaad(),
    runtime,
  });
  const body = {
    to_agent_id: ROOT_DADI_ID,
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

test("reasoning context has send_message and no dispatch_message", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const ctx = await assembleContext({
    db: handle.db,
    agentId: ROOT_DADI_ID,
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
  const targetId = await insertAgent(handle.db, {
    name: "mailbox",
    systemPrompt: "mailbox",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    config,
    log: silentLog,
  });
  const before = runtime.transcript.transcriptFor(targetId).length;
  const result = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
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
  const dwar = mockDwar({
    reason: async () => endTurn("steered"),
    converse: async () => endTurn(),
  });
  const runtime = createRuntime({ db: handle.db, dwar, yaad: mockYaad(), config, log: silentLog });
  await executeTool(runtime.toolContext(ROOT_DADI_ID, "conversation"), {
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

test("conversation context has dispatch_message and not send_message", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const ctx = await assembleContext({
    db: handle.db,
    agentId: ROOT_DADI_ID,
    lane: "conversation",
    transcript: new TranscriptStore(),
  });
  const names = ctx.tools.map((tool) => tool.name);
  assert.ok(names.includes(DISPATCH_MESSAGE));
  assert.ok(names.includes("yield"));
  assert.equal(names.includes(SEND_MESSAGE), false);
});

test("spawn_agent requires system_prompt and grants nothing", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    config,
    log: silentLog,
  });
  const missing = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "sp0",
    name: "spawn_agent",
    input: { name: "no-prompt-child" },
  });
  assert.equal(missing.isError, true);

  const spawned = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "sp1",
    name: "spawn_agent",
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
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    config,
    log: silentLog,
  });
  const childId = await insertAgent(handle.db, {
    name: "grantee",
    systemPrompt: "child",
    parentAgentId: ROOT_DADI_ID,
  });
  const granted = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "g1",
    name: "grant_tool",
    input: {
      agent_id: childId,
      tool_name: "modify_agent",
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
  assert.ok(names.includes("modify_agent"));
  assert.ok(names.includes(SEND_MESSAGE));
});

test("grant_tool on a non-child fails", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const strangerId = await insertAgent(handle.db, {
    name: "stranger-grant",
    systemPrompt: "stranger",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "g2",
    name: "grant_tool",
    input: {
      agent_id: strangerId,
      tool_name: "modify_agent",
      usage: "nope",
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /direct children/);
});

test("grant_tool naming an unknown tool fails", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const childId = await insertAgent(handle.db, {
    name: "unknown-tool-child",
    systemPrompt: "child",
    parentAgentId: ROOT_DADI_ID,
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "g3",
    name: "grant_tool",
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
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    config,
    log: silentLog,
  });
  const childId = await insertAgent(handle.db, {
    name: "revoke-child",
    systemPrompt: "child",
    parentAgentId: ROOT_DADI_ID,
  });
  await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "r0",
    name: "grant_tool",
    input: {
      agent_id: childId,
      tool_name: "modify_agent",
      usage: "temporary",
    },
  });
  const revoked = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "r1",
    name: "revoke_tool",
    input: { agent_id: childId, tool_name: "modify_agent" },
  });
  assert.equal(revoked.isError, false);
  const ctx = await assembleContext({
    db: handle.db,
    agentId: childId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
  });
  assert.equal(
    ctx.tools.map((tool) => tool.name).includes("modify_agent"),
    false,
  );
  const again = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "r2",
    name: "revoke_tool",
    input: { agent_id: childId, tool_name: "modify_agent" },
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
  // Parent holds only grant_tool — not modify_agent — then grants modify_agent to the child.
  await handle.db.insert(agentTools).values({
    agentId: parentId,
    toolId: toolId("grant_tool"),
    usage: "delegate tools",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
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
    parentCtx.tools.map((tool) => tool.name).includes("modify_agent"),
    false,
  );
  const granted = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "g4",
    name: "grant_tool",
    input: {
      agent_id: childId,
      tool_name: "modify_agent",
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
  assert.ok(childCtx.tools.map((tool) => tool.name).includes("modify_agent"));
});
