import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall } from "./call.js";

const input = z
  .object({
    browser_id: z.number().int().positive(),
    tab_id: z.string().min(1).optional(),
    ref: z.string().min(1),
    value: z.string().min(1),
  })
  .strict();

/** Select an option by ref. Intended for workers. */
export const selectOption = defineTool({
  name: "select",
  description:
    "Choose an option on a <select> by option value or label. Ref must come from the latest accessibility_tree.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["browser_id", "ref", "value"],
    properties: {
      browser_id: { type: "number", description: "Browser id" },
      tab_id: { type: "string", description: "Optional CDP target id" },
      ref: { type: "string", description: "Ref of a select element" },
      value: { type: "string", description: "Option value or visible label" },
    },
  },
  async handler(ctx, parsed) {
    return browserToolCall(
      () => ctx.browsers.select(parsed.browser_id, parsed.tab_id, parsed.ref, parsed.value),
      () => ({ selected: true as const, ref: parsed.ref, value: parsed.value }),
      (response) => ({ browser_id: parsed.browser_id, tab_id: response.tab_id }),
    );
  },
});
