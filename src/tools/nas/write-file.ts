import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z
  .object({
    path: z.string().min(1),
    content: z.string(),
  })
  .strict();

/** Write a host file via Nas. Intended for workers. */
export const writeFile = defineTool({
  name: "write_file",
  description:
    "Create or overwrite a text file on the host (absolute paths; Nas denies writes to OS/dadiOS runtime trees). Path must be absolute. Parent directories are created as needed.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content"],
    properties: {
      path: { type: "string", description: "Absolute host path" },
      content: { type: "string", description: "Full file contents to write" },
    },
  },
  async handler(ctx, parsed) {
    return nasToolCall(
      () => ctx.nas.writeFile({ path: parsed.path, content: parsed.content }),
      (response) => response,
      { path: parsed.path },
    );
  },
});
