import { DimaagError } from "../../errors.js";
import type { ToolExecResult } from "../shared.js";
import { fail, ok } from "../shared.js";

/**
 * Run a Chaavi client call; map every Chaavi failure to a tool error so the lane stays alive.
 * Include the error type in the content so vault_unconfigured vs unreachable stay distinguishable.
 */
export async function chaaviToolCall<T>(
  fn: () => Promise<T>,
  shape: (data: T) => unknown,
): Promise<ToolExecResult> {
  try {
    const data = await fn();
    return ok(shape(data));
  } catch (err) {
    if (err instanceof DimaagError) {
      return fail(`${err.type}: ${err.message}`);
    }
    throw err;
  }
}
