CREATE TABLE "scheduled_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"from_agent_id" uuid NOT NULL,
	"to_agent_id" uuid NOT NULL,
	"content" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"interval_minutes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_messages_interval_minutes_check" CHECK ("scheduled_messages"."interval_minutes" IS NULL OR "scheduled_messages"."interval_minutes" >= 1),
	CONSTRAINT "scheduled_messages_from_to_check" CHECK ("scheduled_messages"."from_agent_id" <> "scheduled_messages"."to_agent_id")
);
--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_messages_run_at_idx" ON "scheduled_messages" USING btree ("run_at");