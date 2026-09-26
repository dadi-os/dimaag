import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DimaagError } from "../../errors.js";
import { fail, ok } from "../shared.js";
import { defineTool } from "../types.js";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const input = z
  .object({
    item_id: z.string().min(1),
    terminal_id: z.string().min(1),
    command: z.string().min(1),
    env_name: z.string().min(1).regex(ENV_NAME),
    timeout_seconds: z.number().int().positive().max(3600).optional(),
    max_bytes: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Fill a Chaavi secret into a host terminal command environment.
 * The secret is staged to a temp file, loaded into env_name, then deleted; it never appears in tool content.
 */
export const fillSecret = defineTool({
  name: "chaavi_fill_secret",
  description:
    "Fill a Chaavi secret into env_name and run a host terminal command. Never prints the secret. Use for notarization keys, API tokens, and similar. Not for site logins (use chaavi_fill_login).",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["item_id", "terminal_id", "command", "env_name"],
    properties: {
      item_id: { type: "string", description: "Vault item id from chaavi_list_items" },
      terminal_id: { type: "string", description: "Terminal id handed off by the manager" },
      command: { type: "string", description: "Shell command to run with the secret in env" },
      env_name: {
        type: "string",
        pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
        description: "Shell environment variable name that receives the secret",
      },
      timeout_seconds: {
        type: "number",
        description: "Seconds to wait before returning timed_out (default 120, max 3600)",
      },
      max_bytes: {
        type: "number",
        description: "Max output bytes; excess is head+tail truncated (default 32768)",
      },
    },
  },
  async handler(ctx, parsed) {
    let stagedPath: string | undefined;
    try {
      const secret = await ctx.chaavi.getSecret(parsed.item_id);
      const path = `/tmp/dadi-chaavi-${randomUUID()}`;
      await ctx.nas.writeFile({ path, content: secret.value });
      stagedPath = path;
      const quoted = shellQuote(path);
      const wrapped = `export ${parsed.env_name}=$(cat ${quoted}); rm -f ${quoted}; ${parsed.command}`;
      const body = {
        command: wrapped,
        ...(parsed.timeout_seconds !== undefined
          ? { timeout_seconds: parsed.timeout_seconds }
          : {}),
        ...(parsed.max_bytes !== undefined ? { max_bytes: parsed.max_bytes } : {}),
      };
      const response = await ctx.nas.exec(parsed.terminal_id, body);
      stagedPath = undefined;
      const output =
        secret.value.length > 0
          ? response.output.replaceAll(secret.value, "***")
          : response.output;
      return ok({
        exit_code: response.exit_code,
        output,
        truncated: response.truncated,
        timed_out: response.timed_out,
        item_id: parsed.item_id,
        env_name: parsed.env_name,
      });
    } catch (err) {
      let leftover = "";
      if (stagedPath !== undefined) {
        try {
          await ctx.nas.exec(parsed.terminal_id, {
            command: `rm -f ${shellQuote(stagedPath)}`,
          });
          stagedPath = undefined;
        } catch (cleanupErr) {
          const reason = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
          leftover = ` secret staging file may remain at ${stagedPath} (cleanup failed: ${reason}); retry after terminal idle`;
        }
      }
      if (err instanceof DimaagError) {
        return fail(`${err.type}: ${err.message}${leftover}`);
      }
      throw err;
    }
  },
});

/**
 * shellQuote wraps s in POSIX single quotes, turning each `'` into `'\''`.
 */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
