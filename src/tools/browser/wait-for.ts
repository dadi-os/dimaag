import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall } from "./call.js";

const input = z
  .object({
    browser_id: z.number().int().positive(),
    tab_id: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
    network_idle: z.boolean().optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (v) => v.text !== undefined || v.ref !== undefined || v.network_idle === true,
    { message: "at least one of text, ref, or network_idle is required" },
  );

/** Wait for a condition. Intended for workers. */
export const waitFor = defineTool({
  name: "wait_for",
  description:
    "Wait until visible text appears, a ref is visible, and/or the network is idle. At least one condition is required. Default timeout 10000ms.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["browser_id"],
    properties: {
      browser_id: { type: "number", description: "Browser id" },
      tab_id: { type: "string", description: "Optional CDP target id" },
      text: { type: "string", description: "Wait for this text to be visible" },
      ref: { type: "string", description: "Wait for this accessibility ref to be visible" },
      network_idle: { type: "boolean", description: "Wait for network idle" },
      timeout_ms: { type: "number", description: "Timeout in ms (default 10000)" },
    },
  },
  async handler(ctx, parsed) {
    return browserToolCall(
      () =>
        ctx.browsers.waitFor(parsed.browser_id, parsed.tab_id, {
          ...(parsed.text !== undefined ? { text: parsed.text } : {}),
          ...(parsed.ref !== undefined ? { ref: parsed.ref } : {}),
          ...(parsed.network_idle !== undefined ? { network_idle: parsed.network_idle } : {}),
          ...(parsed.timeout_ms !== undefined ? { timeout_ms: parsed.timeout_ms } : {}),
        }),
      () => ({ waited: true as const }),
      (response) => ({ browser_id: parsed.browser_id, tab_id: response.tab_id }),
    );
  },
});
