import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall } from "./call.js";

const input = z
  .object({
    browser_id: z.number().int().positive(),
    tab_id: z.string().min(1).optional(),
    ref: z.string().min(1),
    text: z.string(),
    submit: z.boolean().optional(),
  })
  .strict();

/** Type into a field by ref. Intended for workers. */
export const typeText = defineTool({
  name: "type",
  description:
    "Clear the field at ref, then type text. Set submit true to press Enter afterward. Refs come from accessibility_tree and go stale after the next snapshot.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["browser_id", "ref", "text"],
    properties: {
      browser_id: { type: "number", description: "Browser id" },
      tab_id: { type: "string", description: "Optional CDP target id" },
      ref: { type: "string", description: "Ref of an input/textarea" },
      text: { type: "string", description: "Text to type" },
      submit: { type: "boolean", description: "Press Enter after typing" },
    },
  },
  async handler(ctx, parsed) {
    return browserToolCall(
      () =>
        ctx.browsers.type(
          parsed.browser_id,
          parsed.tab_id,
          parsed.ref,
          parsed.text,
          parsed.submit,
        ),
      () => ({ typed: true as const, ref: parsed.ref }),
      (response) => ({ browser_id: parsed.browser_id, tab_id: response.tab_id }),
    );
  },
});
