-- Convert agent primary keys from uuid to immutable kebab-case text.
-- Prerequisite: agents.name already holds the desired kebab id (unique).

ALTER TABLE "agent_logs" DROP CONSTRAINT IF EXISTS "agent_logs_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_tools" DROP CONSTRAINT IF EXISTS "agent_tools_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "scheduled_messages" DROP CONSTRAINT IF EXISTS "scheduled_messages_from_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "scheduled_messages" DROP CONSTRAINT IF EXISTS "scheduled_messages_to_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_from_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_to_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_parent_agent_id_agents_id_fk";
--> statement-breakpoint

ALTER TABLE "agents" ADD COLUMN "id_new" text;
--> statement-breakpoint
UPDATE "agents" SET "id_new" = "name";
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "id_new" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "agent_logs" ADD COLUMN "agent_id_new" text;
--> statement-breakpoint
UPDATE "agent_logs" AS l SET "agent_id_new" = a."id_new" FROM "agents" a WHERE a."id" = l."agent_id";
--> statement-breakpoint
ALTER TABLE "agent_logs" ALTER COLUMN "agent_id_new" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "agent_tools" ADD COLUMN "agent_id_new" text;
--> statement-breakpoint
UPDATE "agent_tools" AS t SET "agent_id_new" = a."id_new" FROM "agents" a WHERE a."id" = t."agent_id";
--> statement-breakpoint
ALTER TABLE "agent_tools" ALTER COLUMN "agent_id_new" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "scheduled_messages" ADD COLUMN "from_agent_id_new" text;
--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD COLUMN "to_agent_id_new" text;
--> statement-breakpoint
UPDATE "scheduled_messages" AS s SET
  "from_agent_id_new" = f."id_new",
  "to_agent_id_new" = t."id_new"
FROM "agents" f, "agents" t
WHERE f."id" = s."from_agent_id" AND t."id" = s."to_agent_id";
--> statement-breakpoint
ALTER TABLE "scheduled_messages" ALTER COLUMN "from_agent_id_new" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "scheduled_messages" ALTER COLUMN "to_agent_id_new" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "messages" ADD COLUMN "from_agent_id_new" text;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "to_agent_id_new" text;
--> statement-breakpoint
UPDATE "messages" AS m SET "from_agent_id_new" = a."id_new"
FROM "agents" a WHERE m."from_agent_id" IS NOT NULL AND a."id" = m."from_agent_id";
--> statement-breakpoint
UPDATE "messages" AS m SET "to_agent_id_new" = a."id_new"
FROM "agents" a WHERE m."to_agent_id" IS NOT NULL AND a."id" = m."to_agent_id";
--> statement-breakpoint

ALTER TABLE "agents" ADD COLUMN "parent_agent_id_new" text;
--> statement-breakpoint
UPDATE "agents" AS c SET "parent_agent_id_new" = p."id_new"
FROM "agents" p WHERE c."parent_agent_id" IS NOT NULL AND p."id" = c."parent_agent_id";
--> statement-breakpoint

UPDATE "agent_logs" AS l
SET "payload" = jsonb_set("payload", '{from_agent_id}', to_jsonb(a."id_new"), true)
FROM "agents" a
WHERE l."event" = 'message'
  AND l."payload"->>'from_agent_id' IS NOT NULL
  AND l."payload"->>'from_agent_id' <> ''
  AND a."id"::text = l."payload"->>'from_agent_id';
--> statement-breakpoint
UPDATE "agent_logs" AS l
SET "payload" = jsonb_set("payload", '{to_agent_id}', to_jsonb(a."id_new"), true)
FROM "agents" a
WHERE l."event" = 'message'
  AND l."payload"->>'to_agent_id' IS NOT NULL
  AND l."payload"->>'to_agent_id' <> ''
  AND a."id"::text = l."payload"->>'to_agent_id';
--> statement-breakpoint

ALTER TABLE "agent_logs" DROP COLUMN "agent_id";
--> statement-breakpoint
ALTER TABLE "agent_logs" RENAME COLUMN "agent_id_new" TO "agent_id";
--> statement-breakpoint

ALTER TABLE "agent_tools" DROP CONSTRAINT "agent_tools_agent_id_tool_id_pk";
--> statement-breakpoint
ALTER TABLE "agent_tools" DROP COLUMN "agent_id";
--> statement-breakpoint
ALTER TABLE "agent_tools" RENAME COLUMN "agent_id_new" TO "agent_id";
--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_agent_id_tool_id_pk" PRIMARY KEY ("agent_id", "tool_id");
--> statement-breakpoint

ALTER TABLE "scheduled_messages" DROP COLUMN "from_agent_id";
--> statement-breakpoint
ALTER TABLE "scheduled_messages" DROP COLUMN "to_agent_id";
--> statement-breakpoint
ALTER TABLE "scheduled_messages" RENAME COLUMN "from_agent_id_new" TO "from_agent_id";
--> statement-breakpoint
ALTER TABLE "scheduled_messages" RENAME COLUMN "to_agent_id_new" TO "to_agent_id";
--> statement-breakpoint

ALTER TABLE "messages" DROP COLUMN "from_agent_id";
--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "to_agent_id";
--> statement-breakpoint
ALTER TABLE "messages" RENAME COLUMN "from_agent_id_new" TO "from_agent_id";
--> statement-breakpoint
ALTER TABLE "messages" RENAME COLUMN "to_agent_id_new" TO "to_agent_id";
--> statement-breakpoint

ALTER TABLE "agents" DROP CONSTRAINT "agents_pkey";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "id";
--> statement-breakpoint
ALTER TABLE "agents" RENAME COLUMN "id_new" TO "id";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "parent_agent_id";
--> statement-breakpoint
ALTER TABLE "agents" RENAME COLUMN "parent_agent_id_new" TO "parent_agent_id";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "name";
--> statement-breakpoint
DROP INDEX IF EXISTS "agents_name_idx";
--> statement-breakpoint
ALTER TABLE "agents" ADD PRIMARY KEY ("id");
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_id_kebab_check" CHECK ("id" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$');
--> statement-breakpoint

ALTER TABLE "agents" ADD CONSTRAINT "agents_parent_agent_id_agents_id_fk"
  FOREIGN KEY ("parent_agent_id") REFERENCES "agents"("id");
--> statement-breakpoint
ALTER TABLE "agent_logs" ADD CONSTRAINT "agent_logs_agent_id_agents_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id");
--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_agent_id_agents_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id");
--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_from_agent_id_agents_id_fk"
  FOREIGN KEY ("from_agent_id") REFERENCES "agents"("id");
--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_to_agent_id_agents_id_fk"
  FOREIGN KEY ("to_agent_id") REFERENCES "agents"("id");
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_from_agent_id_agents_id_fk"
  FOREIGN KEY ("from_agent_id") REFERENCES "agents"("id");
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_to_agent_id_agents_id_fk"
  FOREIGN KEY ("to_agent_id") REFERENCES "agents"("id");
--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_from_to_check"
  CHECK ("from_agent_id" <> "to_agent_id");
