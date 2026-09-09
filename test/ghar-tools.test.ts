import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { ROOT_DADI_ID } from "../src/types/domain.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { migrate } from "../src/db/migrate.js";
import { allTools, findTool } from "../src/tools/registry.js";
import { syncTools, toolId } from "../src/tools/sync.js";
import { agentTools } from "../src/db/schema.js";
import { DimaagError } from "../src/errors.js";
import {
  insertAgent,
  mockDwar,
  mockGhar,
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

const GHAR_TOOLS = ["list_devices", "get_state", "control_device", "get_device_events"] as const;

test("syncTools registers Ghar tools and root Dadi holds them", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  for (const name of GHAR_TOOLS) {
    assert.equal(findTool(name)?.name, name);
  }
  assert.equal(allTools().length, 12);
  await assert.doesNotReject(() => syncTools(handle.db));
  const grants = await handle.db.select().from(agentTools);
  const grantToolIds = new Set(grants.map((row) => row.toolId));
  for (const name of GHAR_TOOLS) {
    assert.ok(grantToolIds.has(toolId(name)), `missing root grant for ${name}`);
  }
});

test("list_devices passes filters through to the Ghar client", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const deviceId = randomUUID();
  const ghar = mockGhar({
    listDevices: () => ({
      devices: [
        {
          id: deviceId,
          node_id: "1",
          endpoint: 1,
          name: "Hall bulb",
          room: { id: randomUUID(), name: "hall" },
          tags: [{ id: randomUUID(), name: "lighting" }],
          capabilities: [{ capability: "dimmable", config: {} }],
          online: true,
          last_seen_at: "2026-09-08T12:00:00.000Z",
          vendor_name: null,
          product_name: null,
          state: { brightness: { value: 40, changed_at: "2026-09-08T12:00:00.000Z" } },
        },
      ],
    }),
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar,
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "ld1",
    name: "list_devices",
    input: { room: "hall", tag: "lighting", capability: "dimmable" },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(ghar.listDevicesCalls, [
    { room: "hall", tag: "lighting", capability: "dimmable" },
  ]);
  const body = JSON.parse(result.content);
  assert.equal(body.devices[0].id, deviceId);
  assert.equal(body.devices[0].capabilities[0].capability, "dimmable");
});

test("control_device attributes cause to the calling agent, not root", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const childId = await insertAgent(handle.db, {
    name: "house-thread",
    systemPrompt: "control lights",
    parentAgentId: ROOT_DADI_ID,
  });
  await handle.db.insert(agentTools).values({
    agentId: childId,
    toolId: toolId("control_device"),
    usage: "control lights for this thread",
  });
  const deviceId = randomUUID();
  const ghar = mockGhar({});
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar,
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(childId, "reasoning"), {
    type: "tool_use",
    id: "cd1",
    name: "control_device",
    input: {
      device_id: deviceId,
      capability: "dimmable",
      params: { level: 40 },
    },
  });
  assert.equal(result.isError, false);
  assert.equal(ghar.commandCalls.length, 1);
  const call = ghar.commandCalls[0]!;
  assert.equal(call.deviceId, deviceId);
  assert.equal(call.body.capability, "dimmable");
  assert.deepEqual(call.body.params, { level: 40 });
  assert.equal(call.body.cause, "agent");
  assert.equal(call.body.cause_ref, childId);
  assert.notEqual(call.body.cause_ref, ROOT_DADI_ID);
});

test("Ghar unreachable fails with ghar code, not an empty success", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const ghar = mockGhar({
    listDevices: () => {
      throw new DimaagError(502, "ghar", "Ghar is unreachable");
    },
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar,
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "ld2",
    name: "list_devices",
    input: {},
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /^ghar:/);
  assert.match(result.content, /unreachable/i);
  const body = (() => {
    try {
      return JSON.parse(result.content);
    } catch {
      return null;
    }
  })();
  assert.equal(body, null);
});

test("capability_unsupported and device_unreachable stay distinguishable", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const deviceId = randomUUID();
  let mode: "capability" | "unreachable" = "capability";
  const ghar = mockGhar({
    command: () => {
      if (mode === "capability") {
        throw new DimaagError(
          422,
          "capability_unsupported",
          "device does not support capability dimmable",
        );
      }
      throw new DimaagError(504, "device_unreachable", "command timed out after 5000ms");
    },
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar,
    config,
    log: silentLog,
  });
  const unsupported = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "cd2",
    name: "control_device",
    input: { device_id: deviceId, capability: "dimmable", params: { level: 10 } },
  });
  assert.equal(unsupported.isError, true);
  assert.match(unsupported.content, /^capability_unsupported:/);

  mode = "unreachable";
  const unreachable = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "cd3",
    name: "control_device",
    input: { device_id: deviceId, capability: "dimmable", params: { level: 10 } },
  });
  assert.equal(unreachable.isError, true);
  assert.match(unreachable.content, /^device_unreachable:/);
  assert.notEqual(unsupported.content, unreachable.content);
});

test("get_device_events passes filters through and bounds the default limit", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const deviceId = randomUUID();
  const ghar = mockGhar({
    listEvents: () => ({
      events: [
        {
          id: "12",
          device_id: deviceId,
          attribute_key: "on",
          old_value: false,
          new_value: true,
          cause: "external",
          cause_ref: null,
          created_at: "2026-09-08T12:00:00.000Z",
        },
      ],
    }),
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar,
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "ev1",
    name: "get_device_events",
    input: {
      device_id: deviceId,
      room: "hall",
      tag: "lighting",
      key: "on",
      cause: "external",
      since: "10",
    },
  });
  assert.equal(result.isError, false);
  assert.equal(ghar.listEventsCalls.length, 1);
  assert.deepEqual(ghar.listEventsCalls[0], {
    device_id: deviceId,
    room: "hall",
    tag: "lighting",
    key: "on",
    cause: "external",
    since: "10",
    limit: 50,
  });
  const body = JSON.parse(result.content);
  assert.equal(body.events[0].cause, "external");
});

test("get_state returns only requested devices with changed_at", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const a = randomUUID();
  const b = randomUUID();
  const ghar = mockGhar({
    getState: () => ({
      devices: {
        [a]: { occupancy: { value: false, changed_at: "2026-09-08T11:00:00.000Z" } },
        [b]: { on: { value: true, changed_at: "2026-09-08T11:30:00.000Z" } },
      },
    }),
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar,
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "gs1",
    name: "get_state",
    input: { device_ids: [a] },
  });
  assert.equal(result.isError, false);
  assert.equal(ghar.getStateCalls, 1);
  const body = JSON.parse(result.content);
  assert.equal(Object.keys(body.devices).length, 1);
  assert.equal(body.devices[a].occupancy.value, false);
  assert.equal(body.devices[a].occupancy.changed_at, "2026-09-08T11:00:00.000Z");
  assert.equal(body.devices[b], undefined);
});
