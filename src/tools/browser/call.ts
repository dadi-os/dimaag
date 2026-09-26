import { DimaagError } from "../../errors.js";
import type { ToolExecResult } from "../shared.js";
import { ok } from "../shared.js";

/**
 * Map DimaagError (Nas, Dwar, driver) to a typed tool failure; keep the lane alive.
 * A `shape` that returns a string is sent as-is, so page text reaches the model
 * without a layer of JSON escaping; anything else is JSON-encoded.
 */
export async function browserToolCall<T>(
  fn: () => Promise<T>,
  shape: (data: T) => unknown,
  audit: Record<string, unknown> | ((data: T) => Record<string, unknown>) = {},
): Promise<ToolExecResult> {
  try {
    const data = await fn();
    const fields = typeof audit === "function" ? audit(data) : audit;
    const shaped = shape(data);
    return typeof shaped === "string"
      ? { content: shaped, isError: false, audit: fields }
      : ok(shaped, fields);
  } catch (err) {
    const fields = typeof audit === "function" ? {} : audit;
    if (err instanceof DimaagError) {
      return { content: `${err.type}: ${err.message}`, isError: true, audit: fields };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: message, isError: true, audit: fields };
  }
}
