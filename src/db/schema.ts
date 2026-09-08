/** Drizzle table definitions for agents, logs, tools, and grants. */

import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    parentAgentId: uuid("parent_agent_id").references((): AnyPgColumn => agents.id),
    active: boolean("active").notNull().default(true),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agents_name_idx").on(table.name),
    index("agents_parent_agent_id_idx").on(table.parentAgentId),
  ],
);

export const agentLogs = pgTable(
  "agent_logs",
  {
    id: uuid("id").primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    lane: text("lane").notNull(),
    event: text("event").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("agent_logs_agent_id_created_at_idx").on(table.agentId, table.createdAt),
    check("agent_logs_lane_check", sql`${table.lane} IN ('reasoning', 'conversation')`),
    check(
      "agent_logs_event_check",
      sql`${table.event} IN ('thought', 'tool_call', 'tool_result', 'message')`,
    ),
  ],
);

export const tools = pgTable(
  "tools",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("tools_name_idx").on(table.name)],
);

/** Per-agent tool grant with a usage hint shown alongside the tool description. */
export const agentTools = pgTable(
  "agent_tools",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    toolId: uuid("tool_id")
      .notNull()
      .references(() => tools.id),
    usage: text("usage").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.toolId] })],
);

export type AgentRow = typeof agents.$inferSelect;
export type AgentLogRow = typeof agentLogs.$inferSelect;
export type ToolRow = typeof tools.$inferSelect;
export type AgentToolRow = typeof agentTools.$inferSelect;
