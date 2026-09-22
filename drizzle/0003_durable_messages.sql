CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
	"from_agent_id" uuid,
	"to_agent_id" uuid,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_party_check" CHECK ("from_agent_id" IS NOT NULL OR "to_agent_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "messages_seq_idx" ON "messages" USING btree ("seq");
--> statement-breakpoint
CREATE INDEX "messages_to_agent_id_seq_idx" ON "messages" USING btree ("to_agent_id","seq");
--> statement-breakpoint
CREATE INDEX "messages_from_agent_id_seq_idx" ON "messages" USING btree ("from_agent_id","seq");
--> statement-breakpoint
CREATE INDEX "messages_created_at_idx" ON "messages" USING btree ("created_at");
--> statement-breakpoint
INSERT INTO "messages" ("id", "from_agent_id", "to_agent_id", "content", "created_at")
SELECT
  gen_random_uuid(),
  CASE
    WHEN payload->>'from_agent_id' IS NULL OR payload->>'from_agent_id' = '' THEN NULL
    ELSE (payload->>'from_agent_id')::uuid
  END,
  CASE
    WHEN payload->>'to_agent_id' IS NULL OR payload->>'to_agent_id' = '' THEN NULL
    ELSE (payload->>'to_agent_id')::uuid
  END,
  payload->>'content',
  "created_at"
FROM "agent_logs"
WHERE "event" = 'message'
  AND coalesce(payload->>'content', '') <> ''
  AND (
    (payload->>'from_agent_id' IS NOT NULL AND payload->>'from_agent_id' <> '')
    OR (payload->>'to_agent_id' IS NOT NULL AND payload->>'to_agent_id' <> '')
  )
  AND (
    payload->>'from_agent_id' IS NULL
    OR payload->>'from_agent_id' = ''
    OR EXISTS (SELECT 1 FROM "agents" a WHERE a."id" = (payload->>'from_agent_id')::uuid)
  )
  AND (
    payload->>'to_agent_id' IS NULL
    OR payload->>'to_agent_id' = ''
    OR EXISTS (SELECT 1 FROM "agents" a WHERE a."id" = (payload->>'to_agent_id')::uuid)
  )
ORDER BY "created_at" ASC, "id" ASC;
