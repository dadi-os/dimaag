import assert from "node:assert/strict";
import { after, before, test } from "node:test";
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
  insertAgent,
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

const NAS_TOOLS = [
  "spawn_terminal",
  "list_terminals",
  "close_terminal",
  "execute_shell",
  "read_terminal",
  "send_keys",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
] as const;

test("syncTools registers Nas tools and root Dadi holds them", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  for (const name of NAS_TOOLS) {
    assert.equal(findTool(name)?.name, name);
  }
  assert.equal(allTools().length, 40);
  await assert.doesNotReject(() => syncTools(handle.db));
  const grants = await handle.db.select().from(agentTools);
  const grantToolIds = new Set(grants.map((row) => row.toolId));
  for (const name of NAS_TOOLS) {
    assert.ok(grantToolIds.has(toolId(name)), `missing root grant for ${name}`);
  }
});

test("execute_shell passes through exit code, output, and timed_out", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const nas = mockNas({
    exec: () => ({
      exit_code: 7,
      output: "boom\n",
      truncated: false,
      timed_out: true,
    }),
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
    id: "ex1",
    name: "execute_shell",
    input: { terminal_id: "t1", command: "sleep 5", timeout_seconds: 1 },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(nas.execCalls, [
    { id: "t1", body: { command: "sleep 5", timeout_seconds: 1 } },
  ]);
  const body = JSON.parse(result.content);
  assert.equal(body.exit_code, 7);
  assert.equal(body.output, "boom\n");
  assert.equal(body.timed_out, true);
  assert.equal(result.audit.terminal_id, "t1");
});

test("Nas 404 becomes not_found tool error without killing the lane", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const nas = mockNas({
    exec: () => {
      throw new DimaagError(404, "not_found", "not_found");
    },
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
    id: "ex2",
    name: "execute_shell",
    input: { terminal_id: "t99", command: "echo hi" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /^not_found:/);
  assert.equal(result.audit.terminal_id, "t99");
});

test("Nas 409 on execute_shell becomes busy tool error", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const nas = mockNas({
    exec: () => {
      throw new DimaagError(409, "busy", "terminal is busy");
    },
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
    id: "ex3",
    name: "execute_shell",
    input: { terminal_id: "t1", command: "echo hi" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /^busy:/);
});

test("edit_file 409 surfaces the match count", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const nas = mockNas({
    editFile: () => {
      throw new DimaagError(409, "conflict", "matches: 3");
    },
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
    id: "ed1",
    name: "edit_file",
    input: {
      path: "/var/lib/dadi/a.txt",
      old_string: "foo",
      new_string: "bar",
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /matches: 3/);
  assert.equal(result.audit.path, "/var/lib/dadi/a.txt");
});

test("worker granted execute_shell and read_file sees those plus send_message and yield", async () => {
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
  const childId = await insertAgent(handle.db, {
    name: "coder",
    systemPrompt: "use terminal t1",
    parentAgentId: ROOT_DADI_ID,
  });
  for (const toolName of ["execute_shell", "read_file"] as const) {
    const granted = await executeTool(runtime.toolContext(ROOT_DADI_ID, "reasoning"), {
      type: "tool_use",
      id: `g-${toolName}`,
      name: "grant_tool",
      input: {
        agent_id: childId,
        tool_name: toolName,
        usage: `use ${toolName}`,
      },
    });
    assert.equal(granted.isError, false, granted.content);
  }
  const ctx = await assembleContext({
    db: handle.db,
    agentId: childId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
  });
  assert.deepEqual(
    ctx.tools.map((tool) => tool.name).sort(),
    ["execute_shell", "read_file", SEND_MESSAGE, "yield"].sort(),
  );
});
