import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall } from "./call.js";

const input = z
  .object({
    browser_id: z.number().int().positive(),
    tab_id: z.string().min(1).optional(),
    ref: z.string().min(1),
  })
  .strict();

/** Click by snapshot ref. Intended for workers. */
export const click = defineTool({
  name: "click",
  description:
    "Click the element with the given ref from the latest accessibility_tree. Fails with stale_ref if the ref is missing or ambiguous — take a fresh snapshot.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["browser_id", "ref"],
    properties: {
      browser_id: { type: "number", description: "Browser id" },
      tab_id: { type: "string", description: "Optional CDP target id" },
      ref: { type: "string", description: "Ref from accessibility_tree, e.g. e3" },
    },
  },
  async handler(ctx, parsed) {
    return browserToolCall(
      () => ctx.browsers.click(parsed.browser_id, parsed.tab_id, parsed.ref),
      () => ({ clicked: true as const, ref: parsed.ref }),
      (response) => ({ browser_id: parsed.browser_id, tab_id: response.tab_id }),
    );
  },
});
