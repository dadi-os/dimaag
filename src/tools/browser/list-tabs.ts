import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall } from "./call.js";

const input = z
  .object({
    browser_id: z.number().int().positive(),
  })
  .strict();

/** List tabs in a browser. Intended for workers. */
export const listTabs = defineTool({
  name: "list_tabs",
  description:
    "List open tabs for a browser. tab_id is the CDP target id. focused marks the tab used when tab_id is omitted on other tools.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["browser_id"],
    properties: {
      browser_id: { type: "number", description: "Browser id" },
    },
  },
  async handler(ctx, parsed) {
    return browserToolCall(
      () => ctx.browsers.listTabs(parsed.browser_id),
      (tabs) => ({ tabs }),
      { browser_id: parsed.browser_id },
    );
  },
});
