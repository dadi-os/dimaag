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
  assert.equal(agent.id, "thread");
  assert.equal(agent.systemPrompt, "do the job");

  const grants = await handle.db
    .select()
    .from(agentTools)
    .where(eq(agentTools.agentId, body.thread_id));
  assert.equal(grants.length, 0);

  const delivered = runtime.transcript.transcriptFor(body.thread_id);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.fromAgentId, null);
  assert.equal(delivered[0]?.content, "book the flight");

  assert.ok(seen.some((event) => event.type === "dadi_started"));
  assert.ok(seen.some((event) => event.type === "dadi_finished"));
  assert.match(dwar.completeCalls[0]?.system ?? "", /You are Dadi, the router/);
  assert.match(dwar.completeCalls[0]?.system ?? "", /call `decide` once/i);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /dadi reuse delivers to an existing top-level thread", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "existing",
    systemPrompt: "already here",
    tools: [],
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
  const seen: RuntimeEvent[] = [];
  runtime.events.subscribe((event) => {
    seen.push(event);
  });

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
  assert.equal(
    seen.some((event) => event.type === "agent_modified"),
    false,
    "active reuse must not emit agent_modified",
  );

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /dadi roster marks a dormant root as dormant", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const dormantId = await insertWorker(handle.db, {
    name: "finance-specialist",
    systemPrompt: "own the money",
    tools: [],
  });
  await handle.db.update(agents).set({ active: false }).where(eq(agents.id, dormantId));
  const dwar = mockDwar({
    complete: () => ({
      content: [
        {
          type: "tool_use",
          id: "decide-1",
          name: "decide",
          input: { action: "reuse", thread_id: dormantId },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });
  const { app, runtime, dwar: captured } = await appWith(dwar);

  const res = await app.inject({
    method: "POST",
    url: "/dadi",
    payload: { content: "budget question" },
  });
  assert.equal(res.statusCode, 201);
  const system = captured.completeCalls[0]?.system ?? "";
  assert.match(system, new RegExp(`- ${dormantId} \\[dormant\\]`));
  assert.match(system, /own the money/);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /dadi reuse of a dormant root wakes it, emits agent_modified, and delivers", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "finance-specialist",
    systemPrompt: "own the money",
    tools: [],
  });
  await handle.db.update(agents).set({ active: false }).where(eq(agents.id, workerId));
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
  const seen: RuntimeEvent[] = [];
  runtime.events.subscribe((event) => {
    seen.push(event);
  });

  const res = await app.inject({
    method: "POST",
    url: "/dadi",
    payload: { content: "how is the budget" },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { action: string; thread_id: string; created: boolean };
  assert.equal(body.action, "routed");
  assert.equal(body.created, false);
  assert.equal(body.thread_id, workerId);

  const [agent] = await handle.db.select().from(agents).where(eq(agents.id, workerId));
  assert.equal(agent?.active, true);

  const modified = seen.filter((event) => event.type === "agent_modified");
  assert.equal(modified.length, 1);
  assert.ok(modified[0] && modified[0].type === "agent_modified");
  assert.equal(modified[0].agent_id, workerId);
  assert.equal(modified[0].active, true);
  assert.equal(modified[0].name, "finance-specialist");

  const delivered = runtime.transcript.transcriptFor(workerId);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.content, "how is the budget");

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /dadi modify deactivates an agent without delivering a message", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "to-retire",
    systemPrompt: "old job",
    tools: [],
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
    tools: [],
  });
  const childId = await insertWorker(handle.db, {
    name: "child",
    systemPrompt: "nested",
    parentAgentId: parentId,
    tools: [],
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

test("POST /dadi reuse of a dormant nested agent is still 422", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertWorker(handle.db, {
    name: "parent",
    systemPrompt: "owns children",
    tools: [],
  });
  const childId = await insertWorker(handle.db, {
    name: "child",
    systemPrompt: "nested",
    parentAgentId: parentId,
    tools: [],
  });
  await handle.db.update(agents).set({ active: false }).where(eq(agents.id, childId));
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
    payload: { content: "reuse dormant nested" },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json() as { error: { type: string; message: string } };
  assert.equal(body.error.type, "invalid_request");
  assert.match(body.error.message, /top-level/);
  const [child] = await handle.db.select().from(agents).where(eq(agents.id, childId));
  assert.equal(child?.active, false);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /dadi spawn id conflict is 409", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertWorker(handle.db, {
    name: "taken",
    systemPrompt: "already",
    tools: [],
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
            id: "taken",
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
  assert.match(body.error.message, /taken|already exists/);

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
    tools: ["yaad_recall"],
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

test("POST /tools/:name/execute as dadi spawn_agent creates a root", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const { app, runtime } = await appWith();

  const res = await app.inject({
    method: "POST",
    url: "/tools/dimaag_spawn_agent/execute",
    payload: {
      as_agent_id: "dadi",
      id: "finance-specialist",
      system_prompt: "own the money",
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; is_error: boolean; content: string };
  assert.equal(body.ok, true);
  assert.equal(body.is_error, false);
  const content = JSON.parse(body.content) as { agent_id: string };
  assert.equal(content.agent_id, "finance-specialist");

  const [agent] = await handle.db.select().from(agents).where(eq(agents.id, content.agent_id));
  assert.ok(agent);
  assert.equal(agent.parentAgentId, null);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /tools/:name/execute as dadi rejects worker tools", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const { app, runtime } = await appWith();

  const res = await app.inject({
    method: "POST",
    url: "/tools/yaad_recall/execute",
    payload: { as_agent_id: "dadi", query: "anything" },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json() as { error: { type: string; message: string } };
  assert.equal(body.error.type, "invalid_request");
  assert.match(body.error.message, /router authority/);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /tools/:name/execute as user runs a worker tool without a grant", async () => {
  await resetRuntime(handle.sql, handle.db, config);
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
    payload: { as_agent_id: "user", query: "Vedant lunch" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; is_error: boolean; content: string };
  assert.equal(body.ok, true);
  assert.equal(body.is_error, false);
  assert.deepEqual(yaad.recallCalls, [{ query: "Vedant lunch" }]);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /tools/:name/execute with a missing agent id is 404", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const { app, runtime } = await appWith();
  const missing = "missing-agent-that-does-not-exist";

  const res = await app.inject({
    method: "POST",
    url: "/tools/yaad_recall/execute",
    payload: { as_agent_id: missing, query: "anything" },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json() as { error: { type: string; message: string } };
  assert.equal(body.error.type, "not_found");
  assert.match(body.error.message, /not found/);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /tools/:name/execute without grant is 403", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "ungranted",
    systemPrompt: "no tools",
    tools: [],
  });
  const { app, runtime } = await appWith();

  const res = await app.inject({
    method: "POST",
    url: "/tools/yaad_recall/execute",
    payload: { as_agent_id: workerId, query: "anything" },
  });
  assert.equal(res.statusCode, 403);
  const body = res.json() as { error: { type: string; message: string } };
  assert.equal(body.error.type, "forbidden");
  assert.match(body.error.message, /does not hold yaad_recall/);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /tools/:name/execute as inactive agent is 403", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "dormant",
    systemPrompt: "asleep",
    tools: ["yaad_recall"],
  });
  await handle.db.update(agents).set({ active: false }).where(eq(agents.id, workerId));
  const { app, runtime } = await appWith();

  const res = await app.inject({
    method: "POST",
    url: "/tools/yaad_recall/execute",
    payload: { as_agent_id: workerId, query: "anything" },
  });
  assert.equal(res.statusCode, 403);
  const body = res.json() as { error: { type: string; message: string } };
  assert.equal(body.error.type, "forbidden");
  assert.match(body.error.message, /inactive/);

  await runtime.waitUntilIdle();
  await app.close();
});

test("GET /agents/:id rejects non-kebab ids", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const { app, runtime } = await appWith();

  const res = await app.inject({ method: "GET", url: "/agents/Not-Valid" });
  assert.equal(res.statusCode, 422);
  const body = res.json() as { error: { type: string } };
  assert.equal(body.error.type, "invalid_request");

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /dadi spawn with grants creates exactly those agent_tools rows", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const dwar = mockDwar({
    complete: () => ({
      content: [
        {
          type: "tool_use",
          id: "decide-1",
          name: "decide",
          input: {
            action: "spawn",
            id: "finance-specialist",
            system_prompt: "own the money",
            grants: [
              { tool_name: "yaad_recall", usage: "remember money facts" },
              { tool_name: "yaad_query", usage: "exact money lookups" },
            ],
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
    payload: { content: "track spending" },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { thread_id: string; created: boolean };
  assert.equal(body.created, true);

  const grants = await handle.db
    .select()
    .from(agentTools)
    .where(eq(agentTools.agentId, body.thread_id));
  assert.equal(grants.length, 2);
  const byTool = new Map(grants.map((row) => [row.toolId, row.usage]));
  assert.equal(byTool.get(toolId("yaad_recall")), "remember money facts");
  assert.equal(byTool.get(toolId("yaad_query")), "exact money lookups");

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /dadi spawn with an unknown grant creates no agent", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const before = await handle.db.select().from(agents);
  const dwar = mockDwar({
    complete: () => ({
      content: [
        {
          type: "tool_use",
          id: "decide-1",
          name: "decide",
          input: {
            action: "spawn",
            id: "broken",
            system_prompt: "should not land",
            grants: [{ tool_name: "not_a_real_tool", usage: "nope" }],
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
    payload: { content: "spawn broken" },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json() as { error: { type: string; message: string } };
  assert.equal(body.error.type, "invalid_request");
  assert.match(body.error.message, /not_a_real_tool/);

  const after = await handle.db.select().from(agents);
  assert.equal(after.length, before.length);
  assert.equal(after.some((row) => row.id === "broken"), false);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /dadi spawn with duplicate grants creates no agent", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const before = await handle.db.select().from(agents);
  const dwar = mockDwar({
    complete: () => ({
      content: [
        {
          type: "tool_use",
          id: "decide-1",
          name: "decide",
          input: {
            action: "spawn",
            id: "duped",
            system_prompt: "should not land",
            grants: [
              { tool_name: "yaad_recall", usage: "one" },
              { tool_name: "yaad_recall", usage: "two" },
            ],
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
    payload: { content: "spawn duped" },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json() as { error: { type: string; message: string } };
  assert.equal(body.error.type, "invalid_request");
  assert.match(body.error.message, /duplicate grant/);
  const after = await handle.db.select().from(agents);
  assert.equal(after.length, before.length);
  assert.equal(after.some((row) => row.id === "duped"), false);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /dadi spawn with no grants creates an agent holding nothing", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const dwar = mockDwar({
    complete: () => ({
      content: [
        {
          type: "tool_use",
          id: "decide-1",
          name: "decide",
          input: {
            action: "spawn",
            id: "empty-hands",
            system_prompt: "talk only",
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
    payload: { content: "just chat" },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { thread_id: string };
  const grants = await handle.db
    .select()
    .from(agentTools)
    .where(eq(agentTools.agentId, body.thread_id));
  assert.equal(grants.length, 0);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /dadi modify prompt emits agent_modified", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "old-name",
    systemPrompt: "old prompt",
    tools: [],
  });
  const dwar = mockDwar({
    complete: () => ({
      content: [
        {
          type: "tool_use",
          id: "decide-1",
          name: "decide",
          input: { action: "modify", thread_id: workerId, system_prompt: "new prompt" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });
  const { app, runtime } = await appWith(dwar);
  const seen: RuntimeEvent[] = [];
  runtime.events.subscribe((event) => {
    seen.push(event);
  });

  const res = await app.inject({
    method: "POST",
    url: "/dadi",
    payload: { content: "update that thread" },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { action: string; name: string; system_prompt: string };
  assert.equal(body.action, "modified");
  assert.equal(body.name, "old-name");
  assert.equal(body.system_prompt, "new prompt");

  const modified = seen.filter((event) => event.type === "agent_modified");
  assert.equal(modified.length, 1);
  assert.equal(modified[0].name, "old-name");
  assert.equal(modified[0].agent_id, workerId);

  const [agent] = await handle.db.select().from(agents).where(eq(agents.id, workerId));
  assert.equal(agent?.systemPrompt, "new prompt");
  assert.equal(agent?.id, "old-name");

  await runtime.waitUntilIdle();
  await app.close();
});

