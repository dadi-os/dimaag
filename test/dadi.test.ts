import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { agents, agentTools } from "../src/db/schema.js";
import { createRuntime } from "../src/runtime/engine.js";
import type { RuntimeEvent } from "../src/runtime/events.js";
import { toolId } from "../src/tools/sync.js";
import {
  endTurn,
  insertWorker,
  mockChaavi,
  mockDwar,
  mockGhar,
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

/** Build an isolated Fastify app plus runtime against the shared test db. */
async function appWith(dwar = mockDwar({})) {
  const runtime = createRuntime({
    db: handle.db,
    dwar,
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar,
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    runtime,
  });
  return { app, runtime, dwar };
}

test("POST /dadi spawn routes to a new top-level worker", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const { app, runtime, dwar } = await appWith();
  const seen: RuntimeEvent[] = [];
  runtime.events.subscribe((event) => {
    seen.push(event);
  });

  const res = await app.inject({
    method: "POST",
    url: "/dadi",
    payload: { content: "book the flight" },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as {
    action: string;
    thread_id: string;
    created: boolean;
    content: string;
  };
  assert.equal(body.action, "routed");
  assert.equal(body.created, true);
  assert.equal(body.content, "book the flight");

  const [agent] = await handle.db.select().from(agents).where(eq(agents.id, body.thread_id));
  assert.ok(agent);
  assert.equal(agent.parentAgentId, null);
  assert.equal(agent.name, "thread");
  assert.equal(agent.systemPrompt, "do the job");

  const grants = await handle.db
    .select()
    .from(agentTools)
    .where(eq(agentTools.agentId, body.thread_id));
  const grantIds = new Set(grants.map((row) => row.toolId));
  assert.ok(grantIds.has(toolId("yaad_recall")));
  assert.ok(grantIds.has(toolId("dimaag_schedule_message")));
  assert.equal(grantIds.has(toolId("dimaag_spawn_agent")), false);

  const delivered = runtime.transcript.transcriptFor(body.thread_id);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.fromAgentId, null);
  assert.equal(delivered[0]?.content, "book the flight");

  assert.ok(seen.some((event) => event.type === "dadi_started"));
  assert.ok(seen.some((event) => event.type === "dadi_finished"));
  assert.match(dwar.completeCalls[0]?.system ?? "", /You are Dadi, the router/);
  assert.match(dwar.completeCalls[0]?.system ?? "", /Call `decide` once/);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /dadi reuse delivers to an existing top-level thread", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "existing",
    systemPrompt: "already here",
  });
  const dwar = mockDwar({
    complete: () => ({
      content: [
        {
          type: "tool_use",
          id: "decide-1",
          name: "decide",
          input: { action: "reuse", thread_id: workerId },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });
  const { app, runtime } = await appWith(dwar);

  const res = await app.inject({
    method: "POST",
    url: "/dadi",
    payload: { content: "continue the job" },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { action: string; thread_id: string; created: boolean };
  assert.equal(body.action, "routed");
  assert.equal(body.created, false);
  assert.equal(body.thread_id, workerId);

  const delivered = runtime.transcript.transcriptFor(workerId);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.fromAgentId, null);
  assert.equal(delivered[0]?.content, "continue the job");

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /dadi modify deactivates an agent without delivering a message", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "to-retire",
    systemPrompt: "old job",
  });
  const dwar = mockDwar({
    complete: () => ({
      content: [
        {
          type: "tool_use",
          id: "decide-1",
          name: "decide",
          input: { action: "modify", thread_id: workerId, active: false },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });
  const { app, runtime } = await appWith(dwar);
  const messages: RuntimeEvent[] = [];
  runtime.events.subscribe((event) => {
    if (event.type === "message") {
      messages.push(event);
    }
  });

  const res = await app.inject({
    method: "POST",
    url: "/dadi",
    payload: { content: "retire that thread" },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as {
    action: string;
    agent_id: string;
    active: boolean;
    system_prompt: string;
  };
  assert.equal(body.action, "modified");
  assert.equal(body.agent_id, workerId);
  assert.equal(body.active, false);
  assert.equal(body.system_prompt, "old job");

  const [agent] = await handle.db.select().from(agents).where(eq(agents.id, workerId));
  assert.ok(agent);
  assert.equal(agent.active, false);
  assert.equal(runtime.transcript.transcriptFor(workerId).length, 0);
  assert.equal(messages.length, 0);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /dadi without a decide tool_use is 502 dwar", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const dwar = mockDwar({
    complete: () => endTurn("I will just talk"),
  });
  const { app, runtime } = await appWith(dwar);

  const res = await app.inject({
    method: "POST",
    url: "/dadi",
    payload: { content: "hello" },
  });
  assert.equal(res.statusCode, 502);
  const body = res.json() as { error: { type: string; message: string } };
  assert.equal(body.error.type, "dwar");
  assert.match(body.error.message, /did not call decide/);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /dadi with invalid decide input is 502 dwar", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const dwar = mockDwar({
    complete: () => ({
      content: [
        {
          type: "tool_use",
          id: "decide-1",
          name: "decide",
          input: { action: "reuse" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });
  const { app, runtime } = await appWith(dwar);

  const res = await app.inject({
    method: "POST",
    url: "/dadi",
    payload: { content: "hello" },
  });
  assert.equal(res.statusCode, 502);
  const body = res.json() as { error: { type: string; message: string } };
  assert.equal(body.error.type, "dwar");
  assert.match(body.error.message, /decide input is invalid/);
  assert.match(body.error.message, /thread_id/);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /dadi reuse of a nested agent is 422", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertWorker(handle.db, {
    name: "parent",
    systemPrompt: "owns children",
  });
  const childId = await insertWorker(handle.db, {
    name: "child",
    systemPrompt: "nested",
    parentAgentId: parentId,
  });
  const dwar = mockDwar({
    complete: () => ({
      content: [
        {
          type: "tool_use",
          id: "decide-1",
          name: "decide",
          input: { action: "reuse", thread_id: childId },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });
  const { app, runtime } = await appWith(dwar);

  const res = await app.inject({
    method: "POST",
    url: "/dadi",
    payload: { content: "reuse nested" },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json() as { error: { type: string; message: string } };
  assert.equal(body.error.type, "invalid_request");
  assert.match(body.error.message, /top-level/);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /dadi spawn name conflict is 409", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertWorker(handle.db, {
    name: "taken",
    systemPrompt: "already",
  });
  const dwar = mockDwar({
    complete: () => ({
      content: [
        {
          type: "tool_use",
          id: "decide-1",
          name: "decide",
          input: {
            action: "spawn",
            name: "taken",
            system_prompt: "duplicate",
          },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });
  const { app, runtime } = await appWith(dwar);

  const res = await app.inject({
    method: "POST",
    url: "/dadi",
    payload: { content: "spawn taken" },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json() as { error: { type: string; message: string } };
  assert.equal(body.error.type, "conflict");
  assert.match(body.error.message, /taken/);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /tools/:name/execute without as_agent_id is 422", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const { app, runtime } = await appWith();

  const res = await app.inject({
    method: "POST",
    url: "/tools/yaad_recall/execute",
    payload: { query: "anything" },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json() as { error: { type: string; message: string } };
  assert.equal(body.error.type, "invalid_request");
  assert.match(body.error.message, /as_agent_id/);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /tools/:name/execute with as_agent_id runs a worker tool", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
  });
  const yaad = mockYaad({
    recall: () => ({
      nodes: [],
      edges: [],
      sufficient: false,
      coverage: 0,
    }),
  });
  const dwar = mockDwar({});
  const runtime = createRuntime({
    db: handle.db,
    dwar,
    yaad,
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar,
    yaad,
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    runtime,
  });

  const res = await app.inject({
    method: "POST",
    url: "/tools/yaad_recall/execute",
    payload: { as_agent_id: workerId, query: "Vedant lunch" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; is_error: boolean; content: string };
  assert.equal(body.ok, true);
  assert.equal(body.is_error, false);
  assert.deepEqual(yaad.recallCalls, [{ query: "Vedant lunch" }]);

  await runtime.waitUntilIdle();
  await app.close();
});

test("GET /agents/root is invalid_request", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const { app, runtime } = await appWith();

  const res = await app.inject({ method: "GET", url: "/agents/root" });
  assert.equal(res.statusCode, 422);
  const body = res.json() as { error: { type: string } };
  assert.equal(body.error.type, "invalid_request");

  await runtime.waitUntilIdle();
  await app.close();
});
