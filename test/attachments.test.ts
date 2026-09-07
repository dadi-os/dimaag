import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { patchMessageContent } from "../src/runtime/attachments.js";
import { mockDwar } from "./helpers.js";

test("patchMessageContent describes images and stubs other files", async () => {
  const dwar = mockDwar({
    describeImage: () => ({
      description: "A red mug on a wooden table.",
      usage: { input_tokens: 10, output_tokens: 8 },
    }),
  });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ).toString("base64");

  const content = await patchMessageContent(dwar, "what is this?", [
    { media_type: "image/png", data: png, filename: "mug.png" },
    {
      media_type: "application/pdf",
      data: Buffer.from("%PDF-1.4").toString("base64"),
      filename: "notes.pdf",
    },
  ]);

  assert.equal(dwar.describeCalls.length, 1);
  assert.match(content, /^what is this\?/);
  assert.match(content, /\[Image \(mug\.png\)\]\nA red mug on a wooden table\./);
  assert.match(content, /\[Attached file: notes\.pdf \(application\/pdf\)/);
});

test("patchMessageContent allows image-only messages", async () => {
  const dwar = mockDwar({});
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ).toString("base64");
  const content = await patchMessageContent(dwar, "  ", [
    { media_type: "image/jpeg", data: png },
  ]);
  assert.match(content, /^\[Image\]\nmock image description$/);
});
