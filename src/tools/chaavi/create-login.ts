import { z } from "zod";
import { chaaviToolCall } from "./call.js";
import { defineTool } from "../types.js";

const input = z
  .object({
    name: z.string().min(1).max(200),
    username: z.string().min(1).max(320),
    uri: z.string().min(1).max(2000).optional(),
    length: z.number().int().min(12).max(64).optional(),
    special: z.boolean().optional(),
  })
  .strict();

/**
 * Create a Chaavi login with a generated password. The password never appears in tool content.
 */
export const createLogin = defineTool({
  name: "chaavi_create_login",
  description:
    "Create a Chaavi login with a generated password that never appears in the result. Use for new site accounts (job applications, signups). Then chaavi_fill_login to type username and password into the form. Do not invent or browser_type passwords. length defaults to 20 (12–64); special defaults true. uri is the site URL.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "username"],
    properties: {
      name: { type: "string", description: "Vault item name, e.g. the company or site" },
      username: { type: "string", description: "Username or email for the account" },
      uri: { type: "string", description: "Site URL to attach to the login" },
      length: {
        type: "number",
        description: "Generated password length, 12–64 (default 20)",
      },
      special: {
        type: "boolean",
        description: "Include !@#$%^&* in the generated password (default true)",
      },
    },
  },
  async handler(ctx, parsed) {
    const input = {
      name: parsed.name,
      username: parsed.username,
      ...(parsed.uri !== undefined ? { uri: parsed.uri } : {}),
      ...(parsed.length !== undefined ? { length: parsed.length } : {}),
      ...(parsed.special !== undefined ? { special: parsed.special } : {}),
    };
    return chaaviToolCall(
      () => ctx.chaavi.createLogin(input),
      (item) => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        username: item.username,
        uris: item.uris,
        hasPasskey: item.hasPasskey,
      }),
    );
  },
});
