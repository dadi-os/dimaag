import { z } from "zod";
import { DimaagError } from "../../errors.js";
import { fail, ok } from "../shared.js";
import { defineTool } from "../types.js";

const input = z
  .object({
    item_id: z.string().min(1),
    browser_id: z.number().int().positive(),
    tab_id: z.string().min(1).optional(),
    username_ref: z.string().min(1).optional(),
    password_ref: z.string().min(1),
    submit: z.boolean().optional(),
  })
  .strict();

/**
 * Fill a Chaavi login into a Nas browser. The password never appears in tool content or audit.
 */
export const fillLogin = defineTool({
  name: "chaavi_fill_login",
  description:
    "Fill a login from Chaavi into a Nas browser. Do not use browser_type for passwords. username_ref is optional (skip if there is no username field). password_ref is required. submit presses Enter after the password. For passkeys use chaavi_fill_passkey. For a new account, chaavi_create_login first.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["item_id", "browser_id", "password_ref"],
    properties: {
      item_id: { type: "string", description: "Vault item id from chaavi_list_items or chaavi_create_login" },
      browser_id: { type: "number", description: "Nas browser id" },
      tab_id: { type: "string", description: "Optional CDP target id" },
      username_ref: {
        type: "string",
        description: "Accessibility ref of the username field; omit if none",
      },
      password_ref: { type: "string", description: "Accessibility ref of the password field" },
      submit: { type: "boolean", description: "Press Enter after typing the password" },
    },
  },
  async handler(ctx, parsed) {
    try {
      const login = await ctx.chaavi.getLogin(parsed.item_id);
      if (parsed.username_ref !== undefined) {
        await ctx.browsers.type(
          parsed.browser_id,
          parsed.tab_id,
          parsed.username_ref,
          login.username,
        );
      }
      await ctx.browsers.type(
        parsed.browser_id,
        parsed.tab_id,
        parsed.password_ref,
        login.password,
        parsed.submit,
      );
      return ok(
        {
          filled: true,
          item_id: parsed.item_id,
          username: login.username,
          browser_id: parsed.browser_id,
        },
        {
          item_id: parsed.item_id,
          browser_id: parsed.browser_id,
          ...(parsed.tab_id !== undefined ? { tab_id: parsed.tab_id } : {}),
        },
      );
    } catch (err) {
      if (err instanceof DimaagError) {
        return fail(`${err.type}: ${err.message}`);
      }
      throw err;
    }
  },
});
