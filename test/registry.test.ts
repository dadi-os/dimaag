import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { migrate } from "../src/db/migrate.js";
import { agentTools, tools } from "../src/db/schema.js";
import { findEmbeddedTool, findTool } from "../src/tools/registry.js";
import { syncTools, toolId } from "../src/tools/sync.js";
import { insertAgent, openTestDb, testConfig } from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

before(async () => {
  await migrate(config);
});

after(async () => {
  await handle.close();
});

test("toolId is deterministic for the same name", () => {
  assert.equal(toolId("hath_spawn_agent"), toolId("hath_spawn_agent"));
  assert.equal(toolId("hath_modify_agent"), toolId("hath_modify_agent"));
});

test("toolId produces distinct ids for distinct names", () => {
  assert.notEqual(toolId("hath_spawn_agent"), toolId("hath_modify_agent"));
});

test("findTool returns undefined for a name not in the registry", () => {
  assert.equal(findTool("does_not_exist"), undefined);
});

test("findTool returns grantable tools; agent-management tools are embedded, not grantable", () => {
  assert.equal(findTool("hath_spawn_agent")?.name, "hath_spawn_agent");
  for (const name of ["grant_tool", "revoke_tool", "list_tools", "get_agent", "get_logs"]) {
    assert.equal(findTool(name), undefined, name);
    assert.equal(findEmbeddedTool(name)?.name, name);
  }
});

test("list_tools returns grantable registry entries and honors prefix", async () => {
  const tool = findEmbeddedTool("list_tools");
  assert.ok(tool);
  const ctx = {} as never;
  const all = await tool.handler(ctx, {});
  assert.equal(all.isError, false);
  const allBody = JSON.parse(all.content) as {
    tools: { name: string; description: string }[];
    count: number;
  };
  assert.ok(allBody.count >= 1);
  assert.ok(allBody.tools.some((row) => row.name === "hath_spawn_agent"));
  assert.ok(!allBody.tools.some((row) => row.name === "list_tools"));
  assert.ok(allBody.tools.every((row) => row.description.length > 0));

  const filtered = await tool.handler(ctx, { prefix: "hath_" });
  assert.equal(filtered.isError, false);
  const filteredBody = JSON.parse(filtered.content) as {
    tools: { name: string }[];
    count: number;
  };
  assert.ok(filteredBody.count >= 1);
  assert.ok(filteredBody.tools.every((row) => row.name.startsWith("hath_")));
  assert.ok(filteredBody.count < allBody.count);
});

test("syncTools prunes grants and tool rows not in the registry", async () => {
  await handle.sql`TRUNCATE scheduled_messages, agent_logs, agent_tools, tools, agents CASCADE`;

  const agentId = await insertAgent(handle.db, {
    name: "orphan-holder",
    systemPrompt: "prompt",
  });
  const orphanToolId = randomUUID();
  await handle.db.insert(tools).values({
    id: orphanToolId,
    name: "orphaned_tool",
    description: "not in registry",
    inputSchema: { type: "object", properties: {} },
  });
  await handle.db.insert(agentTools).values({
    agentId,
    toolId: orphanToolId,
    usage: "should be pruned",
  });

  await assert.doesNotReject(() => syncTools(handle.db));
  const leftoverGrants = await handle.db.select().from(agentTools);
  assert.equal(
    leftoverGrants.filter((row) => row.toolId === orphanToolId).length,
    0,
  );
  const leftoverTools = await handle.db.select().from(tools);
  assert.equal(
    leftoverTools.filter((row) => row.id === orphanToolId).length,
    0,
  );
});

test("syncTools with no grants resolves", async () => {
  await handle.sql`TRUNCATE scheduled_messages, agent_logs, agent_tools, tools, agents CASCADE`;
  await assert.doesNotReject(() => syncTools(handle.db));
});

test("syncTools remaps grants when a Chaavi tool is renamed", async () => {
  await handle.sql`TRUNCATE scheduled_messages, agent_logs, agent_tools, tools, agents CASCADE`;
  await syncTools(handle.db);

  const agentId = await insertAgent(handle.db, {
    name: "rename-holder",
    systemPrompt: "prompt",
  });
  const alreadyHasFill = await insertAgent(handle.db, {
    name: "already-fill",
    systemPrompt: "prompt",
  });
  await handle.db.insert(tools).values({
    id: toolId("chaavi_use_passkey"),
    name: "chaavi_use_passkey",
    description: "old passkey name",
    inputSchema: { type: "object", properties: {} },
  });
  await handle.db.insert(tools).values({
    id: toolId("chaavi_with_secret"),
    name: "chaavi_with_secret",
    description: "old secret name",
    inputSchema: { type: "object", properties: {} },
  });
  await handle.db.insert(agentTools).values([
    {
      agentId,
      toolId: toolId("chaavi_use_passkey"),
      usage: "load google passkey",
    },
    {
      agentId,
      toolId: toolId("chaavi_with_secret"),
      usage: "notary key in env",
    },
    {
      agentId: alreadyHasFill,
      toolId: toolId("chaavi_use_passkey"),
      usage: "old passkey grant",
    },
    {
      agentId: alreadyHasFill,
      toolId: toolId("chaavi_fill_passkey"),
      usage: "existing fill passkey grant",
    },
  ]);

  await assert.doesNotReject(() => syncTools(handle.db));

  const remapped = await handle.db.select().from(agentTools);
  const byAgent = new Map(remapped.map((row) => [`${row.agentId}:${row.toolId}`, row.usage]));
  assert.equal(byAgent.get(`${agentId}:${toolId("chaavi_fill_passkey")}`), "load google passkey");
  assert.equal(byAgent.get(`${agentId}:${toolId("chaavi_fill_secret")}`), "notary key in env");
  assert.equal(
    byAgent.get(`${alreadyHasFill}:${toolId("chaavi_fill_passkey")}`),
    "existing fill passkey grant",
  );
  assert.equal(
    remapped.filter((row) => row.toolId === toolId("chaavi_use_passkey")).length,
    0,
  );
  assert.equal(
    remapped.filter((row) => row.toolId === toolId("chaavi_with_secret")).length,
    0,
  );
  const leftoverTools = await handle.db.select().from(tools);
  assert.equal(
    leftoverTools.filter((row) => row.name === "chaavi_use_passkey").length,
    0,
  );
  assert.equal(
    leftoverTools.filter((row) => row.name === "chaavi_with_secret").length,
    0,
  );
});

test("syncTools carries grants across the dimaag → hath and hath_* → device_* renames", async () => {
  await handle.sql`TRUNCATE scheduled_messages, agent_logs, agent_tools, tools, agents CASCADE`;
  await syncTools(handle.db);

  const agentId = await insertAgent(handle.db, {
    name: "rename-carrier",
    systemPrompt: "prompt",
  });
  for (const name of ["hath_get_location", "dimaag_spawn_agent"]) {
    await handle.db.insert(tools).values({
      id: toolId(name),
      name,
      description: `old ${name}`,
      inputSchema: { type: "object", properties: {} },
    });
  }
  await handle.db.insert(agentTools).values([
    { agentId, toolId: toolId("hath_get_location"), usage: "where is Ankur" },
    { agentId, toolId: toolId("dimaag_spawn_agent"), usage: "build my team" },
  ]);

  await assert.doesNotReject(() => syncTools(handle.db));

  const grants = await handle.db.select().from(agentTools);
  const byTool = new Map(grants.map((row) => [row.toolId, row.usage]));
  assert.equal(byTool.get(toolId("device_get_location")), "where is Ankur");
  assert.equal(byTool.get(toolId("hath_spawn_agent")), "build my team");
  assert.equal(byTool.has(toolId("hath_get_location")), false);
  assert.equal(byTool.has(toolId("dimaag_spawn_agent")), false);
  const names = (await handle.db.select().from(tools)).map((row) => row.name);
  assert.equal(names.includes("hath_get_location"), false);
  assert.equal(names.includes("dimaag_spawn_agent"), false);
});

test("syncTools carries grants across the dimaag → hath and hath_* → device_* renames", async () => {
  await handle.sql`TRUNCATE scheduled_messages, agent_logs, agent_tools, tools, agents CASCADE`;
  await syncTools(handle.db);

  const agentId = await insertAgent(handle.db, {
    name: "rename-carrier",
    systemPrompt: "prompt",
  });
  for (const name of ["hath_get_location", "dimaag_spawn_agent"]) {
    await handle.db.insert(tools).values({
      id: toolId(name),
      name,
      description: `old ${name}`,
      inputSchema: { type: "object", properties: {} },
    });
  }
  await handle.db.insert(agentTools).values([
    { agentId, toolId: toolId("hath_get_location"), usage: "where is Ankur" },
    { agentId, toolId: toolId("dimaag_spawn_agent"), usage: "build my team" },
  ]);

  await assert.doesNotReject(() => syncTools(handle.db));

  const grants = await handle.db.select().from(agentTools);
  const byTool = new Map(grants.map((row) => [row.toolId, row.usage]));
  assert.equal(byTool.get(toolId("device_get_location")), "where is Ankur");
  assert.equal(byTool.get(toolId("hath_spawn_agent")), "build my team");
  assert.equal(byTool.has(toolId("hath_get_location")), false);
  assert.equal(byTool.has(toolId("dimaag_spawn_agent")), false);
  const names = (await handle.db.select().from(tools)).map((row) => row.name);
  assert.equal(names.includes("hath_get_location"), false);
  assert.equal(names.includes("dimaag_spawn_agent"), false);
});

test("migrate does not backfill grants onto existing roots", async () => {
  await handle.sql`TRUNCATE scheduled_messages, agent_logs, agent_tools, tools, agents CASCADE`;
  await syncTools(handle.db);

  const agentId = await insertAgent(handle.db, {
    name: "narrow-root",
    systemPrompt: "deliberate grants only",
  });
  const granted = ["yaad_search_history", "yaad_get_node_history"] as const;
  for (const name of granted) {
    await handle.db.insert(agentTools).values({
      agentId,
      toolId: toolId(name),
      usage: `use ${name}`,
    });
  }

  await migrate(config);
  await migrate(config);

  const rows = await handle.db.select().from(agentTools);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.agentId === agentId));
  const ids = new Set(rows.map((row) => row.toolId));
  assert.deepEqual(ids, new Set(granted.map((name) => toolId(name))));
  for (const row of rows) {
    const name = granted.find((tool) => toolId(tool) === row.toolId);
    assert.ok(name);
    assert.equal(row.usage, `use ${name}`);
  }
});
