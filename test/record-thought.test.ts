import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { assembleContext } from "../src/runtime/context.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { migrate } from "../src/db/migrate.js";
import { messages } from "../src/db/schema.js";
import { RECORD_THOUGHT } from "../src/types/domain.js";
import {
  insertAgent,
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

function makeRuntime() {
  return createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
}

test("record_thought writes a self-message delivered to no one", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { name: "note-taker", systemPrompt: "do the job" });
  const runtime = makeRuntime();
  const result = await executeTool(runtime.toolContext(agentId, "reasoning"), {
    type: "tool_use",
    id: "rt1",
    name: RECORD_THOUGHT,
    input: { text: "D2L course list is on the Progress Summary page, not My Courses." },
  });
  assert.equal(result.isError, false, result.content);
  assert.equal(JSON.parse(result.content).recorded, true);

  const rows = await handle.db.select().from(messages).where(eq(messages.fromAgentId, agentId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.toAgentId, agentId);
  assert.match(rows[0]?.content ?? "", /Progress Summary/);
});

test("a recorded thought reappears as the agent's own [Thought] in context", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { name: "note-taker-2", systemPrompt: "do the job" });
  const runtime = makeRuntime();
  await executeTool(runtime.toolContext(agentId, "reasoning"), {
    type: "tool_use",
    id: "rt2",
    name: RECORD_THOUGHT,
    input: { text: "Login needs the SSO button, not the form." },
  });

  const ctx = await assembleContext({
    db: handle.db,
    agentId,
    lane: "reasoning",
    transcript: runtime.transcript,
    transcriptWindowMessages: 40,
  });
  const thought = ctx.messages.find(
    (m) => typeof m.content === "string" && m.content.includes("SSO button"),
  );
  assert.ok(thought, "recorded thought should appear in assembled context");
  assert.equal(thought.role, "assistant");
  assert.match(thought.content as string, /\[Thought\]/);
});

test("record_thought rejects empty text", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { name: "note-taker-3", systemPrompt: "do the job" });
  const runtime = makeRuntime();
  const result = await executeTool(runtime.toolContext(agentId, "reasoning"), {
    type: "tool_use",
    id: "rt3",
    name: RECORD_THOUGHT,
    input: { text: "" },
  });
  assert.equal(result.isError, true);
});
