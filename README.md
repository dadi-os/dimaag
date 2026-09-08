# Dimaag

Agent runtime for dadi. It owns agent identity, transcripts, the dual-lane loop, inter-agent messaging, and the audit log. Every model call goes to Dwar. Dimaag never talks to a provider. Unauthenticated; private mesh only.

## Dependencies

- Postgres (`DATABASE_URL`)
- Dwar at `http://dwar.dadi` for chat and image describe
- Yaad at `http://yaad.dadi` for memory tools
- Nas for mesh DNS, compose/prod networking, and the shared logging contract

## Layout

```
dimaag/
  src/
    app.ts, config.ts, logging.ts, errors.ts, constants.ts
    db/           Drizzle, migrate, seed, agent logs
    dwar/         Dwar axios client
    yaad/         Yaad axios client
    runtime/      dual-lane engine, transcript, events, locks
    tools/        grantable tool registry (dimaag + yaad)
    routers/      HTTP routes + schemas
    types/        domain types
  test/
  drizzle/
  prompts/
  config.toml
```

## Config vs env

`config.toml` (checked in): lane queue timeout, Dwar/Yaad timeout and retry.

Topology is hardcoded in `src/constants.ts`.

`DATABASE_URL` is required at startup (no empty default). Nas injects it in compose and on the appliance (`postgres://dimaag:dimaag@dimaag-postgres:5432/dimaag`). There is no Dimaag `.env` — Postgres is not Preferences-editable.

## Local run

```sh
cd ../nas
docker compose up dimaag dimaag-postgres
docker compose run --rm dimaag npm run db:migrate
docker compose run --rm dimaag npm test
```

Migrations seed root Dadi and sync the tool registry.

## CI / CD

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` → `ci` | PR + push to `main` | Postgres service, migrate, `npm test`, build images |
| `ci.yml` → `publish` | `main` after `ci` | Push `ghcr.io/<owner>/dimaag:{latest,sha}` |

## Logging / error codes

Logs follow the nas JSON contract (`service=dimaag`, request summary, `code` on errors). Default Fastify access logging is off.

HTTP errors: `{ "error": { "type": "<code>", "message": "..." } }`. Shared codes include `invalid_request`, `not_found`, `upstream_unreachable`, `internal_error`. Domain codes include `dwar`, `yaad`, `conflict`. See nas README for the shared catalog.

## Agents

Every agent is a row, including root Dadi (seeded at migration). Clients discover root via `GET /agents/root`. `parent_agent_id` is modification authority only. There is no thread table — a "Dadi thread" is a child of root.

## The user is null

No user table. Human messages use `from_agent_id = null` / `to_agent_id = null`.

## Dual lanes

Every agent has both lanes. **Reasoning** is the executor (tool-calling against `agent_tools` plus embedded `send_message` / `yield`). **Conversation** is the control surface (`dispatch_message`, `steer_reasoning`, `yield`; root also gets `route_message`). Speech is only via those message tools — model text is thought, never speech. A turn ends only on `yield`.

Transcript is in-process and shared. Conversation starts on inbound message, reasoning finish, or `send_message`. `steer_reasoning` queues instructions for the next reasoning step.

## Tools

`src/tools/` is the source of truth; `tools` table is a projection synced at migrate. Grants are parent-to-direct-child only.

### Yaad (memory)

| tool | Yaad route | when to use |
| --- | --- | --- |
| `recall` | `POST /recall` | semantic "what do I know about X" |
| `query` | `POST /query` | exact dates, names, filters |
| `get_node` | `GET /nodes/:id` | full node + edges |
| `ingest` | `POST /ingest` | store a fact |

`occurred_at` on ingest is stamped by Dimaag from the clock.

## Persistence

`agents` and `agent_logs` survive restart. Live transcript, scratchpads, locks, steer/intent queues, and the event stream do not. Single-process only — do not run replicas sharing the DB and expecting lane serialization.

## Routes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | `{ "status": "ok" }` |
| `POST` | `/messages` | user → agent; images described via Dwar |
| `GET` | `/events` | SSE live events; no replay |
| `GET` | `/agents` | all agents + `running` |
| `GET` | `/agents/root` | sole root agent |
| `GET` | `/agents/:id` | agent, children, grants |
| `GET` | `/agents/:id/logs` | per-agent audit trail |
| `GET` | `/logs` | cross-agent audit trail |

Unknown request fields are a 422. No CORS — clients use Tauri HTTP (or equivalent) outside the browser sandbox.
