import assert from "node:assert/strict";
import { test } from "node:test";
import { HostSessions } from "../src/runtime/sessions.js";

test("HostSessions attaches worker tools and ignores spawn/list", () => {
  const sessions = new HostSessions();
  sessions.observe("a1", "browser_spawn", {}, false);
  sessions.observe("a1", "browser_list", {}, false);
  sessions.observe("a1", "terminal_spawn", {}, false);
  assert.deepEqual(sessions.forAgent("a1"), { browsers: [], terminals: [] });

  sessions.observe("a1", "browser_navigate", { browser_id: 10, url: "https://x" }, false);
  sessions.observe("a1", "chaavi_fill_passkey", { browser_id: 12, item_id: "pk" }, false);
  sessions.observe("a1", "browser_click", { browser_id: 11, ref: "e1" }, true);
  sessions.observe("a1", "browser_navigate", { browser_id: 10, url: "https://y" }, false);
  assert.deepEqual(sessions.forAgent("a1").browsers, [12, 11, 10]);

  sessions.observe("a1", "terminal_execute_shell", { terminal_id: "t1", command: "ls" }, false);
  sessions.observe("a1", "terminal_read", { terminal_id: "t1" }, false);
  sessions.observe("a1", "terminal_execute_shell", { terminal_id: "t2", command: "pwd" }, false);
  sessions.observe(
    "a1",
    "chaavi_fill_secret",
    { terminal_id: "t3", command: "notary sign" },
    false,
  );
  assert.deepEqual(sessions.forAgent("a1").terminals, [
    { id: "t1", last_command: "ls" },
    { id: "t2", last_command: "pwd" },
    { id: "t3", last_command: "notary sign" },
  ]);

  sessions.observe("a2", "browser_close", { browser_id: 10 }, false);
  assert.deepEqual(sessions.forAgent("a1").browsers, [12, 11]);
  sessions.observe("a2", "terminal_close", { terminal_id: "t1" }, true);
  assert.deepEqual(sessions.forAgent("a1").terminals, [
    { id: "t2", last_command: "pwd" },
    { id: "t3", last_command: "notary sign" },
  ]);
  sessions.observe("a1", "browser_navigate", { browser_id: 11, url: "https://z" }, false);
  sessions.observe("a2", "browser_close", { browser_id: 11 }, true);
  assert.deepEqual(sessions.forAgent("a1").browsers, [12]);
});
