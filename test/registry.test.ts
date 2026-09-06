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
  assert.equal(toolId("spawn_agent"), toolId("spawn_agent"));
  assert.equal(toolId("modify_agent"), toolId("modify_agent"));
});

test("toolId produces distinct ids for distinct names", () => {
  assert.notEqual(toolId("spawn_agent"), toolId("modify_agent"));
});

test("findTool returns undefined for a name not in the registry", () => {
  assert.equal(findTool("does_not_exist"), undefined);
});

test("findTool returns registered tools", () => {
  assert.equal(findTool("spawn_agent")?.name, "spawn_agent");
  assert.equal(findTool("grant_tool")?.name, "grant_tool");
});

test("syncTools throws when an agent_tools grant points at a tool not in the registry", async () => {
  await handle.sql`TRUNCATE agent_logs, agent_tools, tools, agents CASCADE`;

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
    usage: "should trip sync",
  });

  await assert.rejects(
    () => syncTools(handle.db),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(
        err.message,
        new RegExp(`agent ${agentId} -> tool ${orphanToolId}`),
      );
      return true;
    },
  );
});

test("syncTools with no grants resolves", async () => {
  await handle.sql`TRUNCATE agent_logs, agent_tools, tools, agents CASCADE`;
  await assert.doesNotReject(() => syncTools(handle.db));
});
