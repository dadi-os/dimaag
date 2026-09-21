import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { migrate } from "../src/db/migrate.js";
import { allTools, findTool } from "../src/tools/registry.js";
import { syncTools } from "../src/tools/sync.js";
import {
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

const BROWSER_TOOLS = [
  "browser_spawn",
  "browser_list",
  "browser_close",
  "browser_list_tabs",
  "browser_new_tab",
  "browser_close_tab",
  "browser_navigate",
  "browser_accessibility_tree",
  "browser_click",
  "browser_type",
  "browser_select",
  "browser_wait_for",
  "browser_screenshot",
  "browser_extract_text",
] as const;

test("browser tools are registered", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  for (const name of BROWSER_TOOLS) {
    assert.equal(findTool(name)?.name, name);
  }
  assert.equal(allTools().length, 64);
  await assert.doesNotReject(() => syncTools(handle.db));
});

test("spawn_browser and list_browsers call Nas", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: ["browser_spawn", "browser_list"],
  });
  const browserBodies: Array<{ id?: number } | undefined> = [];
  const nas = mockNas({
    createBrowser: (body) => {
      browserBodies.push(body);
      const id = body?.id ?? 10;
      return {
        id,
        display: `:${id}`,
        cdp_url: `ws://nas.dadi/browsers/${id}/devtools/browser/abc`,
      };
    },
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
    chaavi: mockChaavi(),
    nas,
    config,
    log: silentLog,
  });
  const spawned = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "sb1",
    name: "browser_spawn",
    input: {},
  });
  assert.equal(spawned.isError, false, spawned.content);
  assert.equal(nas.createBrowserCalls, 1);
  const respawned = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "sb2",
    name: "browser_spawn",
    input: { browser_id: 12 },
  });
  assert.equal(respawned.isError, false, respawned.content);
  assert.equal(nas.createBrowserCalls, 2);
  assert.deepEqual(browserBodies, [{}, { id: 12 }]);
  const body = JSON.parse(spawned.content);
  assert.equal(body.browser_id, 10);
  assert.match(body.cdp_url, /browsers\/10/);

  const listed = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "lb1",
    name: "browser_list",
    input: {},
  });
  assert.equal(listed.isError, false);
  assert.equal(nas.listBrowsersCalls, 1);
  assert.equal(JSON.parse(listed.content).browsers[0].browser_id, 10);
});

test("close_browser calls Nas and drops the local connection entry", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: ["browser_close"],
  });
  const nas = mockNas({});
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas,
    config,
    log: silentLog,
  });
  runtime.browsers.remember(10, "ws://example/devtools/browser/x");
  const closed = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "cb1",
    name: "browser_close",
    input: { browser_id: 10 },
  });
  assert.equal(closed.isError, false, closed.content);
  assert.deepEqual(nas.closeBrowserCalls, [10]);
});
