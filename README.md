# Dimaag

Agent runtime for Dadi. It owns agent identity, transcripts, the dual-lane loop, inter-agent messaging, and the audit log. Every model call goes to Dwar. Dimaag never talks to a provider.

Dimaag is unauthenticated. It lives on a private mesh and is never published to a host interface.

## Agents

Every agent is a row, including root Dadi. Dadi is seeded at migration with a well-known id (`00000000-0000-4000-8000-000000000001`) and the prompt in `prompts/dadi.md`. After that the row is ordinary and mutable.

`parent_agent_id` is modification authority only. An agent may modify itself and its direct children, not the rest of its lineage. A worker spawned by a domain agent is that domain agent's problem.

There is no thread table. A "Dadi thread" is just a child of root Dadi.

## The user is null

There is no user table. A message from the human has `from_agent_id = null`. A message to the human has `to_agent_id = null`. Any agent can write to the user. The runtime persists everything; a 24-hour "ephemeral chat" filter is a client display choice, not a Dimaag rule.

## Dual lanes

Every agent has both lanes. There is no per-agent model route.

**Reasoning** is the executor. It runs a tool-calling scratchpad against the tools in `agent_tools`, plus the embedded `send_message`. It calls Dwar `POST /v1/chat/reasoning`.

**Conversation** is the control surface. It talks to the user and to other agents, and it steers reasoning. It calls Dwar `POST /v1/chat/conversation` with the embedded tools `dispatch_message` and `steer_reasoning`. Those three embedded tools are lane plumbing. They are not rows in `tools` and cannot be granted or revoked.

The transcript is identical for both lanes. `assembleContext` builds it once: every message the agent received, plus that agent's outgoing messages to the counterparty of the most recent inbound, ordered by `seq`. Reasoning's scratchpad is in-memory and never written to `messages`.

`dispatch_message` is the only writer to `messages` that addresses someone else. Reasoning has no copy of it. If reasoning needs to talk, it calls `send_message`, which hands an intent to its own conversation lane. Conversation then composes and dispatches.

Conversation starts when:

1. A new inbound message arrives
2. A reasoning run finishes, for any reason
3. That agent's reasoning lane calls `send_message`

`steer_reasoning` appends to an in-memory queue and, if reasoning is idle, starts a run. Instructions that arrive during a run are drained together before the next Dwar call, never mid-call.

## Locks (single process)

Each agent has two independent in-memory locks, one per lane. A request for a busy lane waits in a small queue and runs when the lock is released, or fails when `runtime.lane_queue_timeout_ms` elapses.

This only works with a single Dimaag process. Do not run replicas that share the database and expect lanes to serialize. The locks, the scratchpad, and the steer queue all die with the process.

There is no `current_status` column. Conversation learns what reasoning is doing by steering it.

## Routes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | `{ "status": "ok" }` |
| `POST` | `/v1/messages` | `{ to_agent_id, content }` from the user (`from_agent_id` is null). Persists, starts the target's conversation lane, returns immediately. |
| `GET` | `/v1/messages` | `?agent_id&since&limit` transcript between that agent and the user. `since` is a `seq` cursor, exclusive. |
| `GET` | `/v1/agents` | All agents |
| `GET` | `/v1/agents/:id` | Agent plus direct children |
| `GET` | `/v1/agents/:id/logs` | `?event&limit` audit trail. Not used for context assembly. |

Unknown request fields are a 422.

## Config vs env

`config.toml` is checked in. Iteration caps, lane queue timeout, Dwar timeout/retry, transcript window.

`.env` is environment and deployment only:

```
DATABASE_URL
DWAR_BASE_URL
HOST
PORT
LOG_LEVEL
```

Copy `.env.example` to `.env`. The process will not start if any of those are missing or if `config.toml` is malformed.

## Run locally

Postgres from compose, Dimaag on the host so you can curl it. Compose does not publish Dimaag's port. Postgres is on host 5433 so it does not collide with Yaad on 5432.

```sh
cp .env.example .env
docker compose up -d postgres
npm install
npx drizzle-kit generate   # only when the schema changes
npm run build
npm test
npm start
```

`GET http://127.0.0.1:8091/health` should return `{"status":"ok"}`. Point `DWAR_BASE_URL` at a running Dwar.

```sh
curl -s http://127.0.0.1:8091/v1/messages \
  -H 'content-type: application/json' \
  -d '{"to_agent_id":"00000000-0000-4000-8000-000000000001","content":"hello"}'
```

To run Dimaag inside compose as well:

```sh
docker compose up --build
```

Dimaag then listens on `8080` on the compose network only. Reach it from another service on that network, or with `docker compose exec dimaag`. There is no host port mapping.
