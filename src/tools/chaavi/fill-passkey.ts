import { z } from "zod";
import { DimaagError } from "../../errors.js";
import { fail, ok } from "../shared.js";
import { defineTool } from "../types.js";

const input = z
  .object({
    item_id: z.string().min(1),
    browser_id: z.number().int().positive(),
    tab_id: z.string().min(1).optional(),
  })
  .strict();

/**
 * Fill a Chaavi passkey into a Nas browser virtual authenticator.
 * The private key never appears in tool content or audit.
 */
export const fillPasskey = defineTool({
  name: "chaavi_fill_passkey",
  description:
    "Fill a Chaavi passkey into a Nas browser so the next WebAuthn request on that tab can sign in. Only a request the site starts after this call can use it, so call it before the step that makes the site ask for the passkey: before clicking the site's passkey button, and on Google before submitting the email. If the site is already asking (a passkey, phone or QR prompt is showing), call it, then use the site's \"Try again\" or reload the sign-in step so it asks again. Each call replaces the tab's previous passkey. The key never appears in the result. Use when chaavi_list_items shows hasPasskey. Do not use chaavi_fill_login for passkeys.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["item_id", "browser_id"],
    properties: {
      item_id: { type: "string", description: "Vault item id from chaavi_list_items" },
      browser_id: { type: "number", description: "Nas browser id" },
      tab_id: { type: "string", description: "Optional CDP target id" },
    },
  },
  async handler(ctx, parsed) {
    try {
      const passkey = await ctx.chaavi.getPasskey(parsed.item_id);
      const injected = await ctx.browsers.addPasskey(parsed.browser_id, parsed.tab_id, passkey);
      return ok(
        {
          filled: true,
          item_id: parsed.item_id,
          rp_id: passkey.rpId,
          browser_id: parsed.browser_id,
          tab_id: injected.tab_id,
        },
        {
          item_id: parsed.item_id,
          rp_id: passkey.rpId,
          browser_id: parsed.browser_id,
          tab_id: injected.tab_id,
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
