import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DISPATCH_MESSAGE, MODIFY_AGENT, ROOT_DADI_ID, SEND_MESSAGE } from "../src/types/domain.js";
import { assembleContext } from "../src/runtime/context.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import {
  endTurn,
  insertAgent,
  mockDwar,
  openTestDb,
  resetRuntime,
  silentLog,
  testConfig,
  toolUse,
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
  const runtime = createRuntime({ db: handle.db, dwar, config, log: silentLog });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar,
    runtime,
  });
  const body = {
    to_agent_id: ROOT_DADI_ID,
    content: "hello",
  };
  const [a, b] = await Promise.all([
    app.inject({ method: "POST", url: "/v1/messages", payload: { ...body, content: "one" } }),
    app.inject({ method: "POST", url: "/v1/messages", payload: { ...body, content: "two" } }),
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
    maxTranscriptMessages: 100,
  });
  const names = ctx.tools.map((tool) => tool.name);
  assert.ok(names.includes(SEND_MESSAGE));
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
    config,
    log: silentLog,
  });
  const before = await handle.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM messages`;
  const result = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "d1",
    name: DISPATCH_MESSAGE,
    input: { to_agent_id: targetId, content: "sneak" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /unknown reasoning tool/);
  const after = await handle.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM messages`;
  assert.equal(before[0]?.n, after[0]?.n);
});

test("a steer with reasoning idle starts a Dwar reasoning call", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const dwar = mockDwar({
    reason: async () => endTurn("steered"),
    converse: async () => endTurn(),
  });
  const runtime = createRuntime({ db: handle.db, dwar, config, log: silentLog });
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
    maxTranscriptMessages: 100,
  });
  const names = ctx.tools.map((tool) => tool.name);
  assert.ok(names.includes(DISPATCH_MESSAGE));
  assert.equal(names.includes(SEND_MESSAGE), false);
});

test("reasoning loop writes iteration_cap_exhausted when it hits the cap", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const capped = {
    ...config,
    runtime: { ...config.runtime, max_scratchpad_iterations: 1 },
  };
  const dwar = mockDwar({
    reason: async () => toolUse(SEND_MESSAGE, { to_agent_id: null, intent: "keep going" }),
    converse: async () => endTurn(),
  });
  const runtime = createRuntime({ db: handle.db, dwar, config: capped, log: silentLog });
  await executeTool(runtime.toolContext(ROOT_DADI_ID, "conversation"), {
    type: "tool_use",
    id: "cap-1",
    name: "steer_reasoning",
    input: { instruction: "spin" },
  });
  await runtime.waitUntilIdle();
  const rows = await handle.sql<{ event: string }[]>`
    SELECT event FROM agent_logs WHERE event = 'iteration_cap_exhausted'
  `;
  assert.equal(rows.length, 1);
});
