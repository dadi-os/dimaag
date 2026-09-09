import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall } from "./call.js";

const input = z
  .object({
    browser_id: z.number().int().positive(),
    url: z.string().min(1).optional(),
  })
  .strict();

/** Open a new tab. Intended for workers. */
export const newTab = defineTool({
  name: "new_tab",
  description: "Open a new tab in the browser. Optional url navigates immediately. Returns tab_id (CDP target id).",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["browser_id"],
    properties: {
      browser_id: { type: "number", description: "Browser id" },
      url: { type: "string", description: "Optional URL to load in the new tab" },
    },
  },
  async handler(ctx, parsed) {
    return browserToolCall(
      () => ctx.browsers.newTab(parsed.browser_id, parsed.url),
      (response) => response,
      (response) => ({ browser_id: parsed.browser_id, tab_id: response.tab_id }),
    );
  },
});
