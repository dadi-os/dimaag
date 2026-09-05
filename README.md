# Dimaag

Agent runtime for Dadi. It owns agent identity, transcripts, the dual-lane loop, inter-agent messaging, and the audit log. Every model call goes to Dwar. Dimaag never talks to a provider.

Dimaag is unauthenticated. It lives on a private mesh and is never published to a host interface.

## Agents

Every agent is a row, including root Dadi. Dadi is seeded at migration with a well-known id (`00000000-0000-4000-8000-000000000001`) and the prompt in `prompts/dadi.md`. After that the row is ordinary and mutable.

`parent_agent_id` is modification authority only. An agent may modify itself and its direct children, not the rest of its lineage. A worker spawned by a domain agent is that domain agent's problem.

There is no thread table. A "Dadi thread" is just a child of root Dadi.

## The user is null

There is no user table. A message from the human has `from_agent_id = null`. A message to the human has `to_agent_id = null`. Any agent can write to the user. The runtime keeps the live transcript in process; a 24-hour "ephemeral chat" filter is a client display choice, not a Dimaag rule.

## Dual lanes

Every agent has both lanes. There is no per-agent model route.

**Reasoning** is the executor. It runs a tool-calling scratchpad against the tools in `agent_tools`, plus the embedded `send_message`. It calls Dwar `POST /v1/chat/reasoning`.

**Conversation** is the control surface. It talks to the user and to other agents, and it steers reasoning. It calls Dwar `POST /v1/chat/conversation` with the embedded tools `dispatch_message` and `steer_reasoning`. Those three embedded tools are lane plumbing. They are not rows in `tools` and cannot be granted or revoked.

The transcript lives in-process (`TranscriptStore`) and is identical for both lanes. `assembleContext` builds it once: every message the agent received, plus that agent's outgoing messages to the counterparty of the most recent inbound, ordered by `seq`. `dispatch_message` is the only writer; reasoning has no copy of it. If reasoning needs to talk, it calls `send_message`, which hands an intent to its own conversation lane. Conversation then composes and dispatches.

Conversation starts when:

1. A new inbound message arrives
2. A reasoning run finishes, for any reason
3. That agent's reasoning lane calls `send_message`

`steer_reasoning` appends to an in-memory queue and, if reasoning is idle, starts a run. Instructions that arrive during a run are drained together before the next Dwar call, never mid-call.

## Persistence

`agents` and `agent_logs` survive a process restart. Everything about a live conversation does not: the transcript (`TranscriptStore`), both lanes' scratchpads, lane locks, the steer queue, and the intent queue. They die with the process, same as each other.

Each agent has two independent in-memory locks, one per lane. A request for a busy lane waits in a small queue and runs when the lock is released, or fails when `runtime.lane_queue_timeout_ms` elapses.

This only works with a single Dimaag process. Do not run replicas that share the database and expect lanes to serialize.

There is no `current_status` column. Conversation learns what reasoning is doing by steering it.

## Routes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | `{ "status": "ok" }` |
| `POST` | `/messages` | `{ to_agent_id, content }` from the user (`from_agent_id` is null). Appends to the in-process transcript, starts the target's conversation lane, returns immediately. |
| `GET` | `/agents` | All agents |
| `GET` | `/agents/:id` | Agent plus direct children |
| `GET` | `/agents/:id/logs` | `?event&limit` audit trail. Not used for context assembly. Message history is `?event=message`. |

Unknown request fields are a 422.

## Config vs env

`config.toml` is checked in. Lane queue timeout, Dwar timeout/retry.

Everything else — database address, Dwar address, host/port, log level — is set directly in `docker-compose.yml`. There is no `.env` file.

## Run

Everything runs through Compose.

```sh
docker compose up --build
```

Builds the `dev` target (devDependencies, source bind-mounted, `tsx watch`), publishes on `http://localhost:8091`. `GET http://localhost:8091/health` should return `{"status":"ok"}`.

Dwar needs to be reachable at `http://host.docker.internal:8080` — run it on your host per its own README, or point `DWAR_BASE_URL` in `docker-compose.yml` elsewhere.

```sh
curl -s http://localhost:8091/messages \
  -H 'content-type: application/json' \
  -d '{"to_agent_id":"00000000-0000-4000-8000-000000000001","content":"hello"}'
```

Migrations (this also seeds root Dadi and the platform tool registry — see `src/db/seed.ts`):

```sh
docker compose run --rm api npm run db:migrate
```

Tests:

```sh
docker compose run --rm api npm test
```

Production shape (no bind mount, no published port):

```sh
docker compose -f docker-compose.yml up --build
```
