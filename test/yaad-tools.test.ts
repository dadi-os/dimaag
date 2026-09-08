import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { ROOT_DADI_ID, SEND_MESSAGE } from "../src/types/domain.js";
import { assembleContext } from "../src/runtime/context.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import { migrate } from "../src/db/migrate.js";
import { allTools, findTool } from "../src/tools/registry.js";
import { syncTools, toolId } from "../src/tools/sync.js";
import { agentTools } from "../src/db/schema.js";
import { DimaagError } from "../src/errors.js";
import {
  endTurn,
  mockDwar,
  mockYaad,
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

const YAAD_TOOLS = ["recall", "query", "get_node", "ingest"] as const;
const PLATFORM_TOOLS = ["spawn_agent", "modify_agent", "grant_tool", "revoke_tool"] as const;

test("syncTools registers Yaad tools and root Dadi grants resolve", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  for (const name of YAAD_TOOLS) {
    assert.equal(findTool(name)?.name, name);
  }
  assert.equal(allTools().length, 8);
  await assert.doesNotReject(() => syncTools(handle.db));
  const grants = await handle.db.select().from(agentTools);
  const grantToolIds = new Set(grants.map((row) => row.toolId));
  for (const name of [...PLATFORM_TOOLS, ...YAAD_TOOLS]) {
    assert.ok(grantToolIds.has(toolId(name)), `missing grant for ${name}`);
  }
});

test("assembleContext for root Dadi includes Yaad tools, platform tools, and send_message", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const ctx = await assembleContext({
    db: handle.db,
    agentId: ROOT_DADI_ID,
    lane: "reasoning",
    transcript: new TranscriptStore(),
  });
  const names = new Set(ctx.tools.map((tool) => tool.name));
  for (const name of [...PLATFORM_TOOLS, ...YAAD_TOOLS, SEND_MESSAGE, "yield"]) {
    assert.ok(names.has(name), `missing tool ${name}`);
  }
  assert.equal(names.size, 10);
});

test("recall tool shapes the response and preserves sufficient", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const nodeId = randomUUID();
  const yaad = mockYaad({
    recall: () => ({
      nodes: [
        {
          id: nodeId,
          kind: "memory",
          title: "Vedant lunch",
          body: null,
          occurred_at: "2026-09-05T12:00:00.000Z",
          expires_at: null,
          detail: null,
          score: 0.91,
          hops: 0,
          scores: { semantic: 0.9 },
        },
      ],
      edges: [{ src_id: nodeId, dst_id: randomUUID(), type: "ABOUT", id: randomUUID() }],
      sufficient: true,
      coverage: 0.8,
      anchors: [nodeId],
      hops_taken: 2,
    }),
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad,
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "r1",
    name: "recall",
    input: { query: "Vedant lunch" },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(yaad.recallCalls, [{ query: "Vedant lunch" }]);
  const body = JSON.parse(result.content);
  assert.equal(body.sufficient, true);
  assert.equal(body.coverage, 0.8);
  assert.equal(body.nodes[0].id, nodeId);
  assert.equal(body.nodes[0].score, undefined);
  assert.equal(body.nodes[0].hops, undefined);
  assert.equal(body.anchors, undefined);
  assert.equal(body.hops_taken, undefined);
  assert.deepEqual(body.edges, [
    { src_id: body.edges[0].src_id, dst_id: body.edges[0].dst_id, type: "ABOUT" },
  ]);
});

test("query tool passes filters through", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const yaad = mockYaad({
    query: () => ({ nodes: [{ id: randomUUID(), kind: "plan", title: "flight" }], limit: 10, offset: 0 }),
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad,
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "q1",
    name: "query",
    input: {
      kind: "plan",
      occurred_from: "2026-09-14T00:00:00.000Z",
      occurred_to: "2026-09-14T23:59:59.000Z",
    },
  });
  assert.equal(result.isError, false);
  assert.equal(yaad.queryCalls.length, 1);
  assert.equal(yaad.queryCalls[0]?.kind, "plan");
  const body = JSON.parse(result.content);
  assert.equal(body.limit, 10);
  assert.equal(body.offset, 0);
  assert.equal(body.nodes.length, 1);
});

test("get_node tool returns the Yaad node response", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const id = randomUUID();
  const yaad = mockYaad({
    getNode: () => ({
      id,
      kind: "place",
      title: "Peanut Barrel",
      body: null,
      occurred_at: null,
      expires_at: null,
      access_count: 0,
      last_accessed_at: null,
      source: "ingest",
      created_at: "2026-09-05T12:00:00.000Z",
      updated_at: "2026-09-05T12:00:00.000Z",
      detail: { address: "Grand River", latitude: null, longitude: null },
      edges: { outgoing: [], incoming: [{ src_id: randomUUID(), dst_id: id, type: "AT_LOCATION" }] },
    }),
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad,
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "g1",
    name: "get_node",
    input: { id },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(yaad.getNodeCalls, [id]);
  const body = JSON.parse(result.content);
  assert.equal(body.id, id);
  assert.equal(body.detail.address, "Grand River");
  assert.ok(body.edges.incoming.length === 1);
});

test("ingest stamps occurred_at and source; rejects occurred_at in tool input", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const before = Date.now();
  const yaad = mockYaad({
    ingest: () => ({
      counts: { create_node: 1, update_node: 0, close_node: 0, create_edge: 0, close_edge: 0, noop: 0 },
      operations: [{ op: "create_node", id: randomUUID() }],
      temp_ids: { p1: randomUUID() },
    }),
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad,
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "i1",
    name: "ingest",
    input: { text: "Vedant likes orange juice" },
  });
  assert.equal(result.isError, false);
  assert.equal(yaad.ingestCalls.length, 1);
  const call = yaad.ingestCalls[0]!;
  assert.equal(call.source, "agent");
  assert.equal(call.text, "Vedant likes orange juice");
  const stamped = Date.parse(call.occurred_at);
  assert.ok(stamped >= before - 1000);
  assert.ok(stamped <= Date.now() + 1000);
  const body = JSON.parse(result.content);
  assert.ok(body.counts);
  assert.ok(body.operations);
  assert.equal(body.temp_ids, undefined);

  const rejected = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "i2",
    name: "ingest",
    input: {
      text: "should fail",
      occurred_at: "2020-01-01T00:00:00.000Z",
    },
  });
  assert.equal(rejected.isError, true);
  assert.equal(yaad.ingestCalls.length, 1);
});

test("Yaad 4xx maps to isError without throwing", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const yaad = mockYaad({
    query: () => {
      throw new DimaagError(422, "yaad", "at least one filter is required");
    },
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad,
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "q2",
    name: "query",
    input: { kind: "plan" },
  });
  assert.equal(result.isError, true);
  assert.equal(result.content, "at least one filter is required");
});

test("Yaad unreachable maps to isError and the lane continues", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  let reasonCalls = 0;
  const dwar = mockDwar({
    reason: async () => {
      reasonCalls += 1;
      if (reasonCalls === 1) {
        return toolUse("recall", { query: "anything" }, "fail-call");
      }
      return endTurn("recovered");
    },
    converse: async () => endTurn(),
  });
  const yaad = mockYaad({
    recall: () => {
      throw new DimaagError(502, "upstream_unreachable", "Yaad is unreachable");
    },
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar,
    yaad,
    config,
    log: silentLog,
  });
  runtime.enqueueReasoning(ROOT_DADI_ID);
  await runtime.waitUntilIdle();
  assert.ok(reasonCalls >= 2, "lane should continue after a failed tool call");
  assert.equal(yaad.recallCalls.length, 1);
});
