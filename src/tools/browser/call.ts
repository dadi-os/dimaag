import { DimaagError } from "../../errors.js";
import type { ToolExecResult } from "../shared.js";
import { ok } from "../shared.js";

/** Map DimaagError (Nas, Dwar, driver) to a typed tool failure; keep the lane alive. */
export async function browserToolCall<T>(
  fn: () => Promise<T>,
  shape: (data: T) => unknown,
  audit: Record<string, unknown> | ((data: T) => Record<string, unknown>) = {},
): Promise<ToolExecResult> {
  try {
    const data = await fn();
    const fields = typeof audit === "function" ? audit(data) : audit;
    return ok(shape(data), fields);
  } catch (err) {
    if (err instanceof DimaagError) {
      const fields = typeof audit === "function" ? {} : audit;
      return { content: `${err.type}: ${err.message}`, isError: true, audit: fields };
    }
    throw err;
  }
}
