import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { writeAgentLog } from "../src/db/logs.js";
import { createRuntime } from "../src/runtime/engine.js";
import { EventBus, type RuntimeEvent } from "../src/runtime/events.js";
import { executeTool } from "../src/runtime/tools.js";
import { DISPATCH_MESSAGE, ROOT_DADI_ID, SEND_MESSAGE, YIELD } from "../src/types/domain.js";
import {
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

test("EventBus.subscribe receives emitted events; unsubscribe stops delivery", () => {
  const bus = new EventBus();
  const seen: RuntimeEvent[] = [];
  const unsubscribe = bus.subscribe((event) => {
    seen.push(event);
  });
  bus.emit({
    type: "agent_modified",
    agent_id: ROOT_DADI_ID,
    active: true,
    at: new Date().toISOString(),
  });
  assert.equal(seen.length, 1);
  unsubscribe();
  bus.emit({
    type: "agent_modified",
    agent_id: ROOT_DADI_ID,
    active: false,
    at: new Date().toISOString(),
  });
  assert.equal(seen.length, 1);
});

test("a throwing listener does not block others or the emitter", () => {
  const bus = new EventBus();
  const seen: RuntimeEvent[] = [];
  bus.subscribe(() => {
    throw new Error("subscriber blew up");
  });
  bus.subscribe((event) => {
    seen.push(event);
  });
  assert.doesNotThrow(() => {
    bus.emit({
      type: "lane_started",
      agent_id: ROOT_DADI_ID,
      lane: "conversation",
      at: new Date().toISOString(),
    });
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.type, "lane_started");
});

test("POST /messages emits a message event", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    config,
    log: silentLog,
  });
  const seen: RuntimeEvent[] = [];
  runtime.events.subscribe((event) => {
    if (event.type === "message") {
      seen.push(event);
    }
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    runtime,
  });
  const res = await app.inject({
    method: "POST",
    url: "/messages",
    payload: { to_agent_id: ROOT_DADI_ID, content: "hello events" },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(seen.length, 1);
  const event = seen[0];
  assert.ok(event && event.type === "message");
  assert.equal(event.agent_id, ROOT_DADI_ID);
  assert.equal(event.from_agent_id, null);
  assert.equal(event.to_agent_id, ROOT_DADI_ID);
  assert.equal(event.content, "hello events");
  await runtime.waitUntilIdle();
  await app.close();
});

test("dispatch_message emits message with agent_id set to the recipient", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const targetId = await insertAgent(handle.db, {
    name: "dispatch-target",
    systemPrompt: "target",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    config,
    log: silentLog,
  });
  const seen: RuntimeEvent[] = [];
  runtime.events.subscribe((event) => {
    if (event.type === "message") {
      seen.push(event);
    }
  });
  const result = await executeTool(runtime.toolContext(ROOT_DADI_ID, "conversation"), {
    type: "tool_use",
    id: "d-evt",
    name: DISPATCH_MESSAGE,
    input: { to_agent_id: targetId, content: "ping" },
  });
  assert.equal(result.isError, false);
  assert.equal(seen.length, 1);
  const event = seen[0];
  assert.ok(event && event.type === "message");
  assert.equal(event.agent_id, targetId);
  assert.equal(event.from_agent_id, ROOT_DADI_ID);
  assert.equal(event.to_agent_id, targetId);
  await runtime.waitUntilIdle();
});

test("lane_finished is emitted even when the lane run throws", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const dwar = mockDwar({
    converse: async () => {
      throw new Error("dwar exploded");
    },
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar,
    yaad: mockYaad(),
    config,
    log: silentLog,
  });
  const finished: RuntimeEvent[] = [];
  runtime.events.subscribe((event) => {
    if (event.type === "lane_finished" && event.lane === "conversation") {
      finished.push(event);
    }
  });
  runtime.enqueueConversation(ROOT_DADI_ID);
  await runtime.waitUntilIdle();
  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.type, "lane_finished");
  if (finished[0]?.type === "lane_finished") {
    assert.equal(finished[0].agent_id, ROOT_DADI_ID);
    assert.equal(finished[0].lane, "conversation");
  }
});

test("GET /agents includes running and it flips true while a lane holds the lock", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    config,
    log: silentLog,
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    runtime,
  });

  const idle = await app.inject({ method: "GET", url: "/agents" });
  assert.equal(idle.statusCode, 200);
  const idleBody = idle.json() as {
    agents: Array<{ id: string; running: { reasoning: boolean; conversation: boolean } }>;
  };
  const idleAgent = idleBody.agents.find((agent) => agent.id === ROOT_DADI_ID);
  assert.ok(idleAgent);
  assert.deepEqual(idleAgent.running, { reasoning: false, conversation: false });

  const release = await runtime.locks.acquire(ROOT_DADI_ID, "conversation", 1000);
  const held = await app.inject({ method: "GET", url: "/agents" });
  assert.equal(held.statusCode, 200);
  const heldBody = held.json() as {
    agents: Array<{ id: string; running: { reasoning: boolean; conversation: boolean } }>;
  };
  const heldAgent = heldBody.agents.find((agent) => agent.id === ROOT_DADI_ID);
  assert.ok(heldAgent);
  assert.deepEqual(heldAgent.running, { reasoning: false, conversation: true });
  release();

  await app.close();
});

test("GET /agents/root returns the null-parent agent; 409 when more than one", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    config,
    log: silentLog,
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    runtime,
  });

  const ok = await app.inject({ method: "GET", url: "/agents/root" });
  assert.equal(ok.statusCode, 200);
  const body = ok.json() as {
    id: string;
    parent_agent_id: string | null;
    tools: unknown[];
    children: unknown[];
  };
  assert.equal(body.id, ROOT_DADI_ID);
  assert.equal(body.parent_agent_id, null);
  assert.ok(Array.isArray(body.tools));
  assert.ok(Array.isArray(body.children));

  await insertAgent(handle.db, {
    name: "second-root",
    systemPrompt: "corrupt",
    parentAgentId: null,
  });
  const conflict = await app.inject({ method: "GET", url: "/agents/root" });
  assert.equal(conflict.statusCode, 409);
  const err = conflict.json() as { error: { type: string; message: string } };
  assert.equal(err.error.type, "conflict");
  assert.match(err.error.message, /data corruption/i);

  await app.close();
});

test("GET /agents/:id includes granted tools with usage and excludes embedded tools", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    config,
    log: silentLog,
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    runtime,
  });
  const res = await app.inject({ method: "GET", url: `/agents/${ROOT_DADI_ID}` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    tools: Array<{ name: string; description: string; usage: string }>;
    running: { reasoning: boolean; conversation: boolean };
  };
  assert.ok(body.running);
  assert.ok(body.tools.length > 0);
  for (const tool of body.tools) {
    assert.ok(typeof tool.name === "string" && tool.name.length > 0);
    assert.ok(typeof tool.description === "string");
    assert.ok(typeof tool.usage === "string" && tool.usage.length > 0);
  }
  const names = body.tools.map((tool) => tool.name);
  assert.equal(names.includes(SEND_MESSAGE), false);
  assert.equal(names.includes(DISPATCH_MESSAGE), false);
  assert.equal(names.includes("steer_reasoning"), false);
  assert.equal(names.includes(YIELD), false);
  await app.close();
});

test("GET /logs returns across agents; event filters; limit above cap is 422", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const otherId = await insertAgent(handle.db, {
    name: "log-other",
    systemPrompt: "other",
  });
  await writeAgentLog(handle.db, {
    agentId: ROOT_DADI_ID,
    lane: "conversation",
    event: "message",
    payload: { note: "from-dadi" },
  });
  await writeAgentLog(handle.db, {
    agentId: otherId,
    lane: "reasoning",
    event: "thought",
    payload: { note: "from-other" },
  });
  await writeAgentLog(handle.db, {
    agentId: otherId,
    lane: "conversation",
    event: "message",
    payload: { note: "other-message" },
  });

  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    config,
    log: silentLog,
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    runtime,
  });

  const all = await app.inject({ method: "GET", url: "/logs" });
  assert.equal(all.statusCode, 200);
  const allBody = all.json() as { logs: Array<{ agent_id: string; event: string }> };
  const agentIds = new Set(allBody.logs.map((log) => log.agent_id));
  assert.ok(agentIds.has(ROOT_DADI_ID));
  assert.ok(agentIds.has(otherId));

  const filtered = await app.inject({ method: "GET", url: "/logs?event=message" });
  assert.equal(filtered.statusCode, 200);
  const filteredBody = filtered.json() as { logs: Array<{ event: string }> };
  assert.ok(filteredBody.logs.length >= 2);
  assert.ok(filteredBody.logs.every((log) => log.event === "message"));

  const capped = await app.inject({ method: "GET", url: "/logs?limit=201" });
  assert.equal(capped.statusCode, 422);

  await app.close();
});
