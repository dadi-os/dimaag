/**
 * Live Nas round-trip. Skipped unless NAS_URL is set
 * (e.g. NAS_URL=http://127.0.0.1:8092 npm test -- test/nas-integration.test.ts).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import axios from "axios";
import { testConfig } from "./helpers.js";

const nasUrl = process.env.NAS_URL;

test("integration: spawn terminal, echo, edit file, close", async (t) => {
  if (!nasUrl) {
    t.skip("NAS_URL not set");
    return;
  }

  const config = testConfig();
  const http = axios.create({
    baseURL: nasUrl,
    timeout: Math.max(config.nas.timeout_ms, 130_000),
    headers: { "content-type": "application/json" },
  });

  const created = await http.post("/terminals", {});
  assert.equal(created.status, 200);
  const terminalId = created.data.id as string;
  assert.ok(typeof terminalId === "string" && /^t[1-9][0-9]*$/.test(terminalId));
  const cwd = created.data.cwd as string;

  try {
    const exec = await http.post(`/terminals/${terminalId}/exec`, {
      command: "echo hi",
      timeout_seconds: 30,
    });
    assert.equal(exec.status, 200);
    assert.equal(exec.data.timed_out, false);
    assert.equal(exec.data.exit_code, 0);
    assert.match(String(exec.data.output), /hi/);

    const filePath = `${cwd}/dimaag-nas-integration.txt`;
    await http.post("/fs/write", { path: filePath, content: "alpha\n" });
    const edited = await http.post("/fs/edit", {
      path: filePath,
      old_string: "alpha",
      new_string: "beta",
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.replaced, true);
    const read = await http.post("/fs/read", { path: filePath });
    assert.match(String(read.data.content), /beta/);
  } finally {
    await http.delete(`/terminals/${terminalId}`);
  }
});
