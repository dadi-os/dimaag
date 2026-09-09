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

const BROWSER_TOOLS = [
  "spawn_browser",
  "list_browsers",
  "close_browser",
  "list_tabs",
  "new_tab",
  "close_tab",
  "navigate",
  "accessibility_tree",
  "click",
  "type",
  "select",
  "wait_for",
  "screenshot",
  "extract_text",
] as const;

test("syncTools registers browser tools and root Dadi holds them", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  for (const name of BROWSER_TOOLS) {
    assert.equal(findTool(name)?.name, name);
  }
  assert.equal(allTools().length, 40);
  await assert.doesNotReject(() => syncTools(handle.db));
  const grants = await handle.db.select().from(agentTools);
  const grantToolIds = new Set(grants.map((row) => row.toolId));
  for (const name of BROWSER_TOOLS) {
    assert.ok(grantToolIds.has(toolId(name)), `missing root grant for ${name}`);
  }
});

test("spawn_browser and list_browsers call Nas", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const nas = mockNas({
    createBrowser: () => ({
      id: 10,
      display: ":10",
      cdp_url: "ws://nas.dadi/browsers/10/devtools/browser/abc",
    }),
    listBrowsers: () => [
      {
        id: 10,
        display: ":10",
        cdp_url: "ws://nas.dadi/browsers/10/devtools/browser/abc",
        healthy: true,
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
  const spawned = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "sb1",
    name: "spawn_browser",
    input: {},
  });
  assert.equal(spawned.isError, false, spawned.content);
  assert.equal(nas.createBrowserCalls, 1);
  const body = JSON.parse(spawned.content);
  assert.equal(body.browser_id, 10);
  assert.match(body.cdp_url, /browsers\/10/);

  const listed = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "lb1",
    name: "list_browsers",
    input: {},
  });
  assert.equal(listed.isError, false);
  assert.equal(nas.listBrowsersCalls, 1);
  assert.equal(JSON.parse(listed.content).browsers[0].browser_id, 10);
});

test("close_browser calls Nas and drops the local connection entry", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const nas = mockNas({});
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas,
    config,
    log: silentLog,
  });
  runtime.browsers.remember(10, "ws://example/devtools/browser/x");
  const closed = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
    type: "tool_use",
    id: "cb1",
    name: "close_browser",
    input: { browser_id: 10 },
  });
  assert.equal(closed.isError, false, closed.content);
  assert.deepEqual(nas.closeBrowserCalls, [10]);
});
