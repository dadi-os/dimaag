import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z
  .object({
    path: z.string().min(1),
    old_string: z.string().min(1),
    new_string: z.string(),
  })
  .strict();

/** Exact-string edit of a host file via Nas. Intended for workers. */
export const editFile = defineTool({
  name: "edit_file",
  description:
    "Replace exactly one occurrence of old_string with new_string in a host file. Path must be absolute. If old_string matches zero or many times the tool errors with the match count — widen or narrow old_string and retry. Never falls back to a fuzzy match.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "old_string", "new_string"],
    properties: {
      path: { type: "string", description: "Absolute host path" },
      old_string: { type: "string", description: "Exact text that must occur once" },
      new_string: { type: "string", description: "Replacement text" },
    },
  },
  async handler(ctx, parsed) {
    return nasToolCall(
      () =>
        ctx.nas.editFile({
          path: parsed.path,
          old_string: parsed.old_string,
          new_string: parsed.new_string,
        }),
      (response) => response,
      { path: parsed.path },
    );
  },
});
