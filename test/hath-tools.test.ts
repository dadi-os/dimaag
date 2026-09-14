import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ROOT_DADI_ID } from "../src/types/domain.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { migrate } from "../src/db/migrate.js";
import { allTools, findTool } from "../src/tools/registry.js";
import { syncTools, toolId } from "../src/tools/sync.js";
import { agentTools } from "../src/db/schema.js";
import {
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

const HATH_TOOLS = [
  "nas_list_clients",
  "hath_get_info",
  "hath_get_battery",
  "hath_get_location",
  "hath_get_network",
  "hath_read_clipboard",
  "hath_write_clipboard",
  "hath_send_file",
] as const;

test("syncTools registers Hath tools and root Dadi holds them", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  for (const name of HATH_TOOLS) {
    assert.equal(findTool(name)?.name, name);
  }
  assert.equal(allTools().length, 58);
  await assert.doesNotReject(() => syncTools(handle.db));
  const grants = await handle.db.select().from(agentTools);
  const grantToolIds = new Set(grants.map((row) => row.toolId));
  for (const name of HATH_TOOLS) {
    assert.ok(grantToolIds.has(toolId(name)), `missing root grant for ${name}`);
  }
});

test("nas_list_clients returns Nas mesh clients", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const nas = mockNas();
  nas.listClients = async () => ({
    clients: [
      {
        node_name: "ankur-phone",
        online: true,
        last_seen: "2026-01-02T03:04:05Z",
        ip_addresses: ["100.64.0.5"],
      },
    ],
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas,
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "lc1",
    name: "nas_list_clients",
    input: {},
  });
  assert.equal(result.isError, false);
  const body = JSON.parse(result.content);
  assert.equal(body.clients[0].node_name, "ankur-phone");
});

test("hath_get_battery waits for client result over the command bus", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas: mockNas(),
    config,
    log: silentLog,
  });

  const unsubscribe = runtime.events.subscribe((event) => {
    if (event.type !== "hath_command") {
      return;
    }
    assert.equal(event.node_name, "ankur-phone");
    assert.equal(event.tool, "hath_get_battery");
    const accepted = runtime.hath.complete(event.command_id, {
      ok: true,
      result: { percent: 81, charging: true },
    });
    assert.equal(accepted, true);
  });

  try {
    const result = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
      type: "tool_use",
      id: "bat1",
      name: "hath_get_battery",
      input: { node_name: "ankur-phone" },
    });
    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(result.content), { percent: 81, charging: true });
    assert.equal(result.audit.node_name, "ankur-phone");
  } finally {
    unsubscribe();
  }
});

test("hath_write_clipboard forwards text args and surfaces client errors", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas: mockNas(),
    config,
    log: silentLog,
  });

  const unsubscribe = runtime.events.subscribe((event) => {
    if (event.type !== "hath_command") {
      return;
    }
    assert.equal(event.tool, "hath_write_clipboard");
    assert.deepEqual(event.args, { text: "hello" });
    runtime.hath.complete(event.command_id, {
      ok: false,
      error: { type: "permission_denied", message: "clipboard blocked" },
    });
  });

  try {
    const result = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
      type: "tool_use",
      id: "clip1",
      name: "hath_write_clipboard",
      input: { node_name: "ankur-laptop", text: "hello" },
    });
    assert.equal(result.isError, true);
    assert.equal(result.content, "permission_denied: clipboard blocked");
  } finally {
    unsubscribe();
  }
});
