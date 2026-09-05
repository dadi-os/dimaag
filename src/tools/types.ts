import type { ZodType } from "zod";
import type { ToolContext, ToolExecResult } from "../runtime/tools.js";

/**
 * One tool, defined once. The zod schema is both the validation applied to model
 * input and the source of the JSON Schema the model sees — they cannot drift.
 */
export type ToolDefinition<T = unknown> = {
  name: string;
  description: string;
  input: ZodType<T>;
  /** JSON Schema shown to the model. Hand-written for now; see note below. */
  inputSchema: Record<string, unknown>;
  handler: (ctx: ToolContext, input: T) => Promise<ToolExecResult>;
};

export function defineTool<T>(definition: ToolDefinition<T>): ToolDefinition<T> {
  return definition;
}
