/** Drizzle table definitions for agents, logs, tools, grants, messages, and schedules. */

import {
  bigint,
  boolean,
  check,
  index,
  integer,
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
    /** Immutable kebab-case id; also the human-readable address (`browser-manager`). */
    id: text("id").primaryKey(),
    systemPrompt: text("system_prompt").notNull(),
    parentAgentId: text("parent_agent_id").references((): AnyPgColumn => agents.id),
    active: boolean("active").notNull().default(true),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("agents_parent_agent_id_idx").on(table.parentAgentId),
    check(
      "agents_id_kebab_check",
      sql`${table.id} ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'`,
    ),
  ],
);

export const agentLogs = pgTable(
  "agent_logs",
  {
    id: uuid("id").primaryKey(),
    agentId: text("agent_id")
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
    agentId: text("agent_id")
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

/**
 * Durable chat / lane transcript. Survives restart. Null party = human.
 * `seq` is stable across process restarts (identity column).
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    fromAgentId: text("from_agent_id").references(() => agents.id),
    toAgentId: text("to_agent_id").references(() => agents.id),
    content: text("content").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("messages_seq_idx").on(table.seq),
    index("messages_to_agent_id_seq_idx").on(table.toAgentId, table.seq),
    index("messages_from_agent_id_seq_idx").on(table.fromAgentId, table.seq),
    index("messages_created_at_idx").on(table.createdAt),
    check(
      "messages_party_check",
      sql`${table.fromAgentId} IS NOT NULL OR ${table.toAgentId} IS NOT NULL`,
    ),
  ],
);

/**
 * Deferred dispatch_message that survives restart. Presence of the row is the
 * state — no status/active/last_fired columns.
 *
 * - `run_at` is the next fire time (ticker cursor), never a "created for" time.
 * - `interval_minutes` null = one-shot (delete on fire); non-null = recurring
 *   (`run_at` advances by the interval after each fire).
 * - `from_agent_id` is always set; scheduled messages are never from the human.
 */
export const scheduledMessages = pgTable(
  "scheduled_messages",
  {
    id: uuid("id").primaryKey(),
    fromAgentId: text("from_agent_id")
      .notNull()
      .references(() => agents.id),
    toAgentId: text("to_agent_id")
      .notNull()
      .references(() => agents.id),
    content: text("content").notNull(),
    runAt: timestamptz("run_at").notNull(),
    intervalMinutes: integer("interval_minutes"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("scheduled_messages_run_at_idx").on(table.runAt),
    check(
      "scheduled_messages_interval_minutes_check",
      sql`${table.intervalMinutes} IS NULL OR ${table.intervalMinutes} >= 1`,
    ),
    check(
      "scheduled_messages_from_to_check",
      sql`${table.fromAgentId} <> ${table.toAgentId}`,
    ),
  ],
);

export type AgentRow = typeof agents.$inferSelect;
export type AgentLogRow = typeof agentLogs.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type ToolRow = typeof tools.$inferSelect;
export type AgentToolRow = typeof agentTools.$inferSelect;
export type ScheduledMessageRow = typeof scheduledMessages.$inferSelect;
