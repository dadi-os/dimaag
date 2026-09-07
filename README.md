# Dimaag

Agent runtime for Dadi. It owns agent identity, transcripts, the dual-lane loop, inter-agent messaging, and the audit log. Every model call goes to Dwar. Dimaag never talks to a provider.

Dimaag is unauthenticated. It lives on a private mesh and is never published to a host interface.

## Agents

Every agent is a row, including root Dadi. Dadi is seeded at migration with a well-known id (`00000000-0000-4000-8000-000000000001`) and the prompt in `prompts/dadi.md`. After that the row is ordinary and mutable. Clients discover root structurally via `GET /agents/root` (the sole agent with `parent_agent_id` null), not by hardcoding the seed id.

`parent_agent_id` is modification authority only. An agent may modify itself and its direct children, not the rest of its lineage. A worker spawned by a domain agent is that domain agent's problem.

There is no thread table. A "Dadi thread" is just a child of root Dadi.

## The user is null

There is no user table. A message from the human has `from_agent_id = null`. A message to the human has `to_agent_id = null`. Any agent can write to the user. The runtime keeps the live transcript in process; a 24-hour "ephemeral chat" filter is a client display choice, not a Dimaag rule.

## Dual lanes

Every agent has both lanes. There is no per-agent model route.

**Reasoning** is the executor. It runs a tool-calling scratchpad against the tools in `agent_tools`, plus the embedded `send_message` and `yield`. It calls Dwar `POST /v1/chat/reasoning`.

**Conversation** is the control surface. It talks to the user and to other agents, and it steers reasoning. It calls Dwar `POST /v1/chat/conversation` with the embedded tools `dispatch_message`, `steer_reasoning`, and `yield`. Those embedded tools are lane plumbing. They are not rows in `tools` and cannot be granted or revoked.

Dwar forces at least one tool call on every step when tools are present. Text in a model response is internal narration (thought), never speech. Speech is only `dispatch_message` (conversation) or `send_message` → conversation (reasoning). A lane turn ends only when the model calls `yield` — sending a message does not end the turn. Tool calls and their results are appended to the in-process scratchpad and sent back on the next Dwar call so the agent sees what it did.

The transcript lives in-process (`TranscriptStore`) and is identical for both lanes. `assembleContext` builds it once: every message the agent received, plus that agent's outgoing messages to the counterparty of the most recent inbound, ordered by `seq`. `dispatch_message` is the only writer; reasoning has no copy of it. If reasoning needs to talk, it calls `send_message`, which hands an intent to its own conversation lane. Conversation then composes and dispatches.

Conversation starts when:

1. A new inbound message arrives
2. A reasoning run finishes, for any reason
3. That agent's reasoning lane calls `send_message`

`steer_reasoning` appends to an in-memory queue and, if reasoning is idle, starts a run. Instructions that arrive during a run are drained together before the next Dwar call, never mid-call.

## Tools

The registry in `src/tools/` is the source of truth for every grantable tool — name, description, input schema, validation, and handler. The `tools` table is a projection of that registry, upserted by `syncTools` at migrate time so `agent_tools` has something to foreign-key against.

Agents see tools via `agent_tools` grants. `grant_tool` and `revoke_tool` are parent-to-direct-child only (same authority scope as `modify_agent`). Root Dadi's grants are seeded in code because Dadi has no parent. `spawn_agent` creates a child with no tools; granting is a separate call.

### Yaad (memory)

Dimaag reaches Yaad over HTTP as one more external service — the same relationship it has with Dwar. It calls `http://yaad.dadi` and knows nothing about Yaad's schema. Four tools:

| tool | Yaad route | when to use |
| --- | --- | --- |
| `recall` | `POST /recall` | semantic "what do I know about X" |
| `query` | `POST /query` | exact dates, names, kind/status filters |
| `get_node` | `GET /nodes/:id` | full node + edges after a lookup |
| `ingest` | `POST /ingest` | store a fact; Yaad extracts and reconciles |

Root Dadi is seeded with all four. `occurred_at` on ingest is stamped by Dimaag from the clock — agents do not supply it.

## Persistence

`agents` and `agent_logs` survive a process restart. Everything about a live conversation does not: the transcript (`TranscriptStore`), both lanes' scratchpads, lane locks, the steer queue, the intent queue, and the event stream. Event subscribers are dropped on restart and no events are replayed. They die with the process, same as each other.

Each agent has two independent in-memory locks, one per lane. A request for a busy lane waits in a small queue and runs when the lock is released, or fails when `runtime.lane_queue_timeout_ms` elapses. `GET /agents` exposes that lock ownership as `running` — it is always false immediately after a restart, regardless of what was happening before.

This only works with a single Dimaag process. Do not run replicas that share the database and expect lanes to serialize. The in-memory event bus makes the same assumption: no pub/sub, no cross-instance fanout.

There is no `current_status` column. Conversation learns what reasoning is doing by steering it.

`agent_logs` has no severity concept — only `thought` / `tool_call` / `tool_result` / `message`. A failed tool call is a `tool_result` whose payload has `is_error: true`. Clients that want an error count must filter on that field.

## Routes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | `{ "status": "ok" }` |
| `POST` | `/messages` | `{ to_agent_id, content }` from the user (`from_agent_id` is null). Appends to the in-process transcript, starts the target's conversation lane, returns immediately. |
| `GET` | `/events` | Server-sent events for live `message`, `lane_started` / `lane_finished`, `agent_spawned`, and `agent_modified`. No replay; reconnect and re-fetch `GET /agents`. |
| `GET` | `/agents` | All agents, including `running` (in-memory lane lock ownership). |
| `GET` | `/agents/root` | The sole agent with `parent_agent_id` null. Same shape as `/agents/:id`. 404 if none; 409 if more than one (data corruption). |
| `GET` | `/agents/:id` | Agent plus direct children (each with `running`) and granted tools (`name`, `description`, `usage`). Embedded lane tools are not listed. |
| `GET` | `/agents/:id/logs` | `?event&limit` audit trail for one agent. Not used for context assembly. Message history is `?event=message`. |
| `GET` | `/logs` | Cross-agent audit trail. Same `?event&limit` as the per-agent route; `limit` capped at 200. |

Unknown request fields are a 422.

Dimaag sends no CORS headers. Clients should make requests outside the browser sandbox (Tauri's HTTP plugin does this). Dimaag is unauthenticated; opening it to browser origins is not appropriate.

## Config vs env

`config.toml` is checked in — lane queue timeout, Dwar timeout/retry, Yaad timeout/retry.

Topology is hardcoded in `src/constants.ts` (including log level). Dwar is at `http://dwar.dadi` and Yaad at `http://yaad.dadi`, resolved by Nas's reverse proxy in both dev and prod.

`DATABASE_URL` (and `POSTGRES_PASSWORD` for the database container) live in `.env`. Copy `.env.example` to `.env`. Nas reads that file for both Dimaag and `dimaag-postgres`.

## Development

Dimaag runs as part of the dadiOS stack. Bring it up through Nas:

```sh
cd ../nas
docker compose up dimaag dimaag-postgres
docker compose run --rm dimaag npm run db:migrate
```

Source is bind-mounted, so edits here restart the service in place. Start the rest of the stack (`docker compose up`) when Dimaag needs Dwar or Yaad.

Migrations also seed root Dadi and sync the tool registry (`src/db/migrate.ts` / `src/db/seed.ts`).

Tests run the same way:

```sh
docker compose run --rm dimaag npm test
```

```sh
curl -s http://localhost:8091/messages \
  -H 'content-type: application/json' \
  -d '{"to_agent_id":"00000000-0000-4000-8000-000000000001","content":"hello"}'
```
