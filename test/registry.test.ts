import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { migrate } from "../src/db/migrate.js";
import { agentTools, tools } from "../src/db/schema.js";
import { findTool } from "../src/tools/registry.js";
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
  assert.equal(toolId("dimaag_spawn_agent"), toolId("dimaag_spawn_agent"));
  assert.equal(toolId("dimaag_modify_agent"), toolId("dimaag_modify_agent"));
});

test("toolId produces distinct ids for distinct names", () => {
  assert.notEqual(toolId("dimaag_spawn_agent"), toolId("dimaag_modify_agent"));
});

test("findTool returns undefined for a name not in the registry", () => {
  assert.equal(findTool("does_not_exist"), undefined);
});

test("findTool returns registered tools", () => {
  assert.equal(findTool("dimaag_spawn_agent")?.name, "dimaag_spawn_agent");
  assert.equal(findTool("dimaag_grant_tool")?.name, "dimaag_grant_tool");
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

test("migrate does not backfill grants onto existing roots", async () => {
  await handle.sql`TRUNCATE scheduled_messages, agent_logs, agent_tools, tools, agents CASCADE`;
  await syncTools(handle.db);

  const agentId = await insertAgent(handle.db, {
    name: "narrow-root",
    systemPrompt: "deliberate grants only",
  });
  const granted = ["yaad_recall", "yaad_query"] as const;
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
