import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolDebounce } from "../src/runtime/tool-debounce.js";

const cfg = { base_ms: 1200, max_ms: 15000 };

test("no prior failure means no delay", () => {
  const debounce = new ToolDebounce(cfg);
  assert.equal(debounce.delayBeforeNext("worker"), 0);
});

test("a success keeps the agent at zero delay", () => {
  const debounce = new ToolDebounce(cfg);
  debounce.record("worker", false);
  assert.equal(debounce.delayBeforeNext("worker"), 0);
});

test("one failure owes the base delay", () => {
  const debounce = new ToolDebounce(cfg);
  debounce.record("worker", true);
  assert.equal(debounce.delayBeforeNext("worker"), 1200);
});

test("consecutive failures double the delay", () => {
  const debounce = new ToolDebounce(cfg);
  debounce.record("worker", true);
  debounce.record("worker", true);
  assert.equal(debounce.delayBeforeNext("worker"), 2400);
  debounce.record("worker", true);
  assert.equal(debounce.delayBeforeNext("worker"), 4800);
});

test("delay is capped at max_ms", () => {
  const debounce = new ToolDebounce(cfg);
  for (let i = 0; i < 20; i++) {
    debounce.record("worker", true);
  }
  assert.equal(debounce.delayBeforeNext("worker"), 15000);
});

test("a success after failures clears the streak", () => {
  const debounce = new ToolDebounce(cfg);
  debounce.record("worker", true);
  debounce.record("worker", true);
  debounce.record("worker", false);
  assert.equal(debounce.delayBeforeNext("worker"), 0);
});

test("failure streaks are tracked per agent", () => {
  const debounce = new ToolDebounce(cfg);
  debounce.record("a", true);
  assert.equal(debounce.delayBeforeNext("a"), 1200);
  assert.equal(debounce.delayBeforeNext("b"), 0);
});
