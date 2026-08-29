CREATE TABLE "agent_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"lane" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_logs_lane_check" CHECK ("agent_logs"."lane" IN ('reasoning', 'conversation')),
	CONSTRAINT "agent_logs_event_check" CHECK ("agent_logs"."event" IN ('thought', 'tool_call', 'tool_result', 'message'))
);
--> statement-breakpoint
CREATE TABLE "agent_tools" (
	"agent_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"usage" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tools_agent_id_tool_id_pk" PRIMARY KEY("agent_id","tool_id")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"system_prompt" text NOT NULL,
	"parent_agent_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"to_agent_id" uuid,
	"from_agent_id" uuid,
	"content" text NOT NULL,
	"seq" bigserial NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_party_check" CHECK (NOT ("messages"."to_agent_id" IS NULL AND "messages"."from_agent_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"input_schema" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_logs" ADD CONSTRAINT "agent_logs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_parent_agent_id_agents_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_logs_agent_id_created_at_idx" ON "agent_logs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_name_idx" ON "agents" USING btree ("name");--> statement-breakpoint
CREATE INDEX "agents_parent_agent_id_idx" ON "agents" USING btree ("parent_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_seq_idx" ON "messages" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "messages_to_agent_id_seq_idx" ON "messages" USING btree ("to_agent_id","seq");--> statement-breakpoint
CREATE INDEX "messages_from_to_seq_idx" ON "messages" USING btree ("from_agent_id","to_agent_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "tools_name_idx" ON "tools" USING btree ("name");