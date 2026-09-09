import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall } from "./call.js";

const input = z
  .object({
    browser_id: z.number().int().positive(),
    tab_id: z.string().min(1).optional(),
    url: z.string().min(1),
    wait_until: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
  })
  .strict();

/** Navigate a tab. Intended for workers. */
export const navigate = defineTool({
  name: "navigate",
  description:
    "Navigate the focused tab (or tab_id) to a URL. Returns the final url and title. Prefer accessibility_tree after navigation to act by ref.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["browser_id", "url"],
    properties: {
      browser_id: { type: "number", description: "Browser id" },
      tab_id: { type: "string", description: "Optional CDP target id; defaults to focused tab" },
      url: { type: "string", description: "URL to load" },
      wait_until: {
        type: "string",
        enum: ["load", "domcontentloaded", "networkidle"],
        description: "Playwright waitUntil (default load)",
      },
    },
  },
  async handler(ctx, parsed) {
    return browserToolCall(
      () =>
        ctx.browsers.navigate(
          parsed.browser_id,
          parsed.tab_id,
          parsed.url,
          parsed.wait_until ?? "load",
        ),
      (response) => ({ url: response.url, title: response.title }),
      (response) => ({ browser_id: parsed.browser_id, tab_id: response.tab_id }),
    );
  },
});
