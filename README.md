# Dimaag

Agent runtime for dadi. It owns agent identity, transcripts, the dual-lane loop, inter-agent messaging, and the audit log. Every model call goes to Dwar. Dimaag never talks to a provider. Unauthenticated; private mesh only.

## Dependencies

- Postgres (`DATABASE_URL`)
- Dwar at `http://dwar.dadi` for chat and image describe
- Yaad at `http://yaad.dadi` for memory tools
- Ghar at `http://ghar.dadi` for home device tools
- Chaavi at `http://chaavi.dadi` for vault tools (`chaavi_*`); secrets are never returned to the model
- Nas at `http://nas.dadi` for host terminals, project filesystem, and headed Chromium browsers (also mesh DNS / logging)
- `playwright-core` (no browser download — Chromium comes from Nas over CDP)

## Layout

```
dimaag/
  src/
    app.ts, config.ts, logging.ts, errors.ts, constants.ts
    db/           Drizzle, migrate, agent logs
    dwar/         Dwar axios client
    yaad/         Yaad axios client
    ghar/         Ghar axios client
    chaavi/       Chaavi axios client (vault metadata + inject)
    nas/          Nas axios client (terminals + filesystem + browsers)
    browser/      Playwright CDP driver for Nas Chromium
    runtime/      dual-lane engine, transcript, events, locks
    tools/        grantable tool registry (dimaag + yaad + ghar + chaavi + nas + browser)
    routers/      HTTP routes + schemas
    types/        domain types
  test/
  drizzle/
  prompts/
  config.toml
```

## Config vs env

`config.toml` (checked in): lane queue timeout, Dwar/Yaad/Ghar/Chaavi/Nas timeout and retry, browser action/navigation/snapshot limits.

Topology is hardcoded in `src/constants.ts`.

`DATABASE_URL` is required at startup (no empty default). Nas injects it in compose and on the appliance (`postgres://dimaag:dimaag@dimaag-postgres:5432/dimaag`). There is no Dimaag `.env` — Postgres is not Preferences-editable.

## Local run

```sh
cd ../nas
docker compose up dimaag dimaag-postgres
docker compose run --rm dimaag npm run db:migrate
docker compose run --rm dimaag npm test
```

Migrations run schema SQL and sync the tool registry. They do not grant tools. Dadi is `POST /dadi`, not an agents row.

## CI / CD

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` → `ci` | PR + push to `main` | Postgres service, migrate, `npm test`, build images |
| `ci.yml` → `publish` | `main` after `ci` | Push `ghcr.io/<owner>/dimaag:{latest,sha}` |

## Logging / error codes

Logs follow the nas JSON contract (`service=dimaag`, request summary, `code` on errors). Default Fastify access logging is off.

HTTP errors: `{ "error": { "type": "<code>", "message": "..." } }`. Shared codes include `invalid_request`, `not_found`, `upstream_unreachable`, `internal_error`. Domain codes include `dwar`, `yaad`, `ghar`, `chaavi`, `vault_unconfigured`, `vault_unreachable`, `nas`, `conflict`, `stale_ref`. See nas README for the shared catalog (`busy`, `forbidden`, `binary_file`, …).

## Agents

Every `agents` row is an agent. Dadi is not a row — it is `POST /dadi`. Top-level threads have `parent_agent_id` null (god-owned). Nested workers point at a real parent. `GET /agents` includes ephemeral `running` (lane locks) and `sessions` (Nas browsers and terminals the agent recently drove). Spawn/list do not attach; worker tools that take `browser_id` or `terminal_id` do. Both maps die with the process.

## Dadi

`POST /dadi` is the router. Policy lives in `prompts/dadi.md`. Dimaag sends that prompt (plus the top-level roster, active and dormant) as `system` to Dwar `POST /chat/complete` — a promptless inference call — with one `decide` tool (`reuse` | `spawn` | `modify`). Code applies the decision. Spawn creates a top-level agent with only the tools in `decide.grants` (omitted or empty = none). Reuse of a dormant root wakes it and delivers. Modify can change any agent's `name`, `system_prompt`, and/or `active`. Routed utterances are delivered once onto the thread as `from_agent_id` null. Dadi does not speak and does not hold worker tools.

SSE: `dadi_started` / `dadi_finished` / `dadi_failed`. After a route, the thread's `lane_*` and `message` events take over.

## The user is null

No user table. Human messages use `from_agent_id = null` / `to_agent_id = null`.

## Dual lanes

Every agent has both lanes. **Reasoning** is the executor (tool-calling against `agent_tools` plus embedded `send_message` / `list_agents` / `yield`). **Conversation** is the control surface (`dispatch_message`, `steer_reasoning`, `list_agents`, `yield`). Speech is only via those message tools — model text is thought, never speech. A turn ends only on `yield`. `list_agents` is how agents resolve names to ids; it is not grantable.

Transcript is in-process and shared. Conversation starts on inbound message, reasoning finish, or `send_message`. `steer_reasoning` queues instructions for the next reasoning step.

## Tools

`src/tools/` is the source of truth; `tools` table is a projection synced at migrate. Grants are parent-to-direct-child only.

### Yaad (memory)

| tool | Yaad route | when to use |
| --- | --- | --- |
| `yaad_recall` | `POST /recall` | semantic "what do I know about X" |
| `yaad_query` | `POST /query` | exact dates, names, filters |
| `yaad_get_node` | `GET /nodes/:id` | full node + edges |
| `yaad_ingest` | `POST /ingest` | store a fact |
| `yaad_get_node_history` | `GET /nodes/:id/history` | correction log for one node |
| `yaad_search_history` | `POST /history/search` | semantic search over corrections |

`occurred_at` on ingest is stamped by Dimaag from the clock.

### Chaavi (vault)

Grantable inject tools. Metadata may reach the model; passwords and secret values never do.

| tool | Chaavi route | when to use |
| --- | --- | --- |
| `chaavi_list_items` | `GET /v1/items` | find a vault item id by name or site uri (no secrets) |
| `chaavi_fill_login` | `POST /v1/items/:id/login` | type a login into a Nas browser; never `browser_type` a password |
| `chaavi_with_secret` | `POST /v1/items/:id/secret` | run a host command with the secret in `env_name`; output is redacted |

### Terminal (shell + files)

Thin clients over Nas. Shell is the run-a-command mechanism; file tools are the file-manipulation mechanism — no file IO through the shell by design. Terminal ids are handed off by the spawning agent (prompt or message); Dimaag does not enforce ownership.

| tool | holder | Nas route |
| --- | --- | --- |
| `terminal_spawn` | manager | `POST /terminals` |
| `terminal_list` | manager | `GET /terminals` |
| `terminal_close` | manager | `DELETE /terminals/{id}` |
| `terminal_execute_shell` | worker | `POST /terminals/{id}/exec` |
| `terminal_read` | worker | `GET /terminals/{id}/capture` |
| `terminal_send_keys` | worker | `POST /terminals/{id}/keys` |
| `terminal_read_file` | worker | `POST /fs/read` |
| `terminal_write_file` | worker | `POST /fs/write` |
| `terminal_edit_file` | worker | `POST /fs/edit` |
| `terminal_glob` | worker | `POST /fs/glob` |
| `terminal_grep` | worker | `POST /fs/grep` |

`terminal_execute_shell` HTTP timeout is `timeout_seconds + 10` so the client never gives up before Nas reports a shell timeout. On timeout the command keeps running — use `terminal_read` / `terminal_send_keys` (e.g. `C-c`) to follow up.

File tools take absolute host paths. Nas **denies writes** to OS and dadiOS runtime trees (`/usr`, `/etc`, `$DADI_STATE_DIR/modules`, …); reads are allowed. There is no project sandbox folder. Default terminal/glob/grep cwd is the Nas state dir (dadi home).

### Browser

Each worker drives one Nas Chromium over CDP (`playwright-core` `connectOverCDP`). Act on accessibility refs, not coordinates. `tab_id` is the CDP target id; omit it to use the focused/attached page. Refs from `browser_accessibility_tree` (`e1`, `e2`, …) are valid only until the next snapshot. Screenshots go through Dwar `/image/describe` — pixels never enter the transcript; the raw image is kept in tool `audit` only.

| tool | holder | notes |
| --- | --- | --- |
| `browser_spawn` | manager | Nas `POST /browsers` → `{ browser_id, cdp_url }` |
| `browser_list` | manager | Nas `GET /browsers` |
| `browser_close` | manager | Nas `DELETE` + drop in-process CDP connection |
| `browser_list_tabs` / `browser_new_tab` / `browser_close_tab` | worker | CDP target ids |
| `browser_navigate` | worker | returns `{ url, title }` |
| `browser_accessibility_tree` | worker | bounded tree + refs; truncated flag |
| `browser_click` / `browser_type` / `browser_select` | worker | by ref; `stale_ref` if missing/ambiguous |
| `browser_wait_for` | worker | text, ref, and/or network_idle |
| `browser_screenshot` | worker | `page` (Playwright) or `display` (Nas monitor) → Dwar describe |
| `browser_extract_text` | worker | visible body text, bounded |


### Nas (control plane)

Host ops via Nas HTTP. System logs are Loki (`nas_get_logs`); agent cognition is `dimaag_get_logs`.

| tool | Nas route |
| --- | --- |
| `nas_get_status` | `GET /status` |
| `nas_get_logs` | `GET /logs` |
| `nas_restart_module` | `POST /modules/{name}/restart` |
| `nas_pull_updates` | `POST /pull_updates` |
| `nas_stack_up` | `POST /stack/up` |
| `nas_stack_down` | `POST /stack/down` |
| `nas_provision` | `POST /provision` |
| `nas_list_clients` | `GET /clients` |

### Hath (remote clients)

Reverse RPC over SSE `hath_command` + `POST /hath/commands/:id/result`. Discover `node_name` with `nas_list_clients` first.

| tool | notes |
| --- | --- |
| `hath_get_info` | platform, OS/app version, timezone |
| `hath_get_battery` | percent + charging |
| `hath_get_location` | lat/lng/accuracy |
| `hath_get_network` | mesh + connection type |
| `hath_read_clipboard` / `hath_write_clipboard` | clipboard text |
| `hath_send_file` | write into OS Downloads; returns path |

### Dimaag (meta)

| tool | notes |
| --- | --- |
| `dimaag_spawn_agent` / `dimaag_modify_agent` / `dimaag_grant_tool` / `dimaag_revoke_tool` | agent tree |
| `dimaag_schedule_message` / `dimaag_list_schedules` / `dimaag_cancel_schedule` | durable schedules |
| `dimaag_get_logs` | agent audit (`thought` / `tool_call` / `tool_result` / `message`) for self or a direct child |

## CLI

The host `dadi` CLI lives in Nas (`service/cmd/dadi`, `/usr/bin/dadi` on the appliance). It invokes this registry over HTTP (`GET /tools`, `POST /tools/:name/execute`). Requires `DIMAAG_URL` (no default) and exactly one caller identity on execute: `--as-agent-id <uuid>`, `--as-dadi`, or `--as-user`. Agent callers must be active and hold a grant for the tool. `as_agent_id: "dadi"` is limited to router authority tools (`dimaag_spawn_agent`, `dimaag_grant_tool`, `dimaag_revoke_tool`, `dimaag_modify_agent`). `as_agent_id: "user"` skips grant and active checks for any tool (human / ops).

## Persistence

`agents`, `agent_logs`, and `scheduled_messages` survive restart. Live transcript, scratchpads, locks, steer/intent queues, host `sessions`, and the event stream do not. Single-process only — do not run replicas sharing the DB and expecting lane serialization.

Schedule tools (`dimaag_schedule_message`, `dimaag_list_schedules`, `dimaag_cancel_schedule`) persist one-shot and recurring deliveries; the in-process scheduler ticks from `[schedule].tick_seconds` in `config.toml` (wall clock uses `TIMEZONE` in `constants.ts`).

## Routes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | `{ "status": "ok" }` |
| `POST` | `/dadi` | router: classify once, then spawn/reuse/modify |
| `POST` | `/messages` | user → agent; images described via Dwar |
| `GET` | `/events` | SSE live events; no replay |
| `GET` | `/agents` | all agents + `running` + `sessions` |
| `GET` | `/agents/:id` | agent, children, grants |
| `GET` | `/agents/:id/logs` | per-agent audit trail |
| `GET` | `/logs` | cross-agent audit trail |
| `GET` | `/tools` | grantable tool catalog |
| `GET` | `/tools/:name` | one tool schema |
| `POST` | `/tools/:name/execute` | run tool as `as_agent_id` (`uuid`, `"dadi"`, or `"user"`) |

Unknown request fields are a 422. No CORS — clients use Tauri HTTP (or equivalent) outside the browser sandbox.
