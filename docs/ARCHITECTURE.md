# Architecture

AI Studio OS is three layers in one process. There is no build step, no bundler, and no runtime
dependency: the browser loads `index.html`, `styles.css`, and `app.js` as-is, and the server is
plain Node with the built-in SQLite driver.

```
┌────────────────────────────── browser ──────────────────────────────┐
│  index.html   app shell + inline SVG sprite                         │
│  app.js       pages, dialogs, streaming view, api client            │
│  styles.css   visual system                                          │
└───────────────────────────────┬─────────────────────────────────────┘
                                │  same origin: / and /api/*
┌───────────────────────────────▼─────────────────────────────────────┐
│  server/index.js    static files · JSON API · SSE generation stream │
│  server/gateway.js  model resolution · streaming · credits          │
│  server/scheduler.js  claim-then-run clock for due workflows        │
│  server/automations.js  one executor for manual/scheduled/event runs │
│  server/files.js    uploads, disk storage, attachment prep          │
│  server/schedule.js schedule shapes · timezone math · next run      │
│  server/store.js    data access (all SQL)                           │
│  server/db.js       schema · seeding · row shaping                  │
│  server/providers/  openai · anthropic · gemini · ollama · mock     │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                data/studio.db (SQLite, WAL) + data/uploads/
```

## Why one process

The browser must never hold a provider key, so generation has to happen server-side. Once that is
true, serving the static files from the same origin removes CORS, cookie, and dev-proxy problems
in one move: there is nothing to configure and nothing to keep in sync between two dev servers.
A separately hosted front end can still use the API — permissive CORS headers are set on `/api/*`,
and no credentials are involved.

## The gateway

`server/gateway.js` is the seam that keeps vendors out of the product code. Everything else —
routes, UI, database — speaks in product terms ("Auto select", "Claude Sonnet", "Image mode").

Responsibilities:

1. **Model catalogue.** `catalog.js` holds curated entries (`id`, `name`, `provider`,
   `providerModel`, `kind`, `pricing`). Entries are data, not code.
2. **Live discovery.** For every configured provider the gateway asks for its current model list
   (cached 10 minutes). Discovery failures are recorded per provider, never thrown, so one bad key
   cannot take the app down. Anything a provider reports that the catalogue does not list appears
   as a `Discovered` entry instead of being hidden.
3. **Resolution.** An explicit selection resolves to exactly that model — never a silent
   substitution. If its provider is not configured the request fails with an actionable hint.
   "Auto select" resolves to the first configured provider that can produce the requested kind,
   following `AI_STUDIO_PROVIDER_ORDER`.
4. **Normalised streaming.** Every adapter yields the same events:
   `start → delta… → (asset) → usage → summary`, or an `error` event mid-stream.
5. **Accountability.** Token counts, credits, estimated cost, latency, status, and errors are
   computed once, here, and stored on the generation row.
6. **Demo fallback.** With no provider configured (and `AI_STUDIO_ALLOW_MOCK=1`), the local demo
   engine answers — clearly marked as demo in the event, the row, and the UI.

## Provider adapters

An adapter is a plain object with a small interface:

```js
{
  id, label,
  isConfigured(): boolean,
  discoverModels({ signal }): Promise<Array<{ id, kind }>>,
  streamText({ model, prompt, system, maxTokens, signal, images }): AsyncGenerator<Event>,
  generateImage?({ model, prompt, signal }): Promise<{ dataUrl, revisedPrompt }>,
  checkHealth?({ signal }): Promise<{ ok, detail }>,
}
```

Adapters own their vendor's quirks — auth headers, request shape, SSE dialect, usage fields — and
nothing else. `docs/PROVIDERS.md` walks through adding one.

## Streaming protocol

`POST /api/generate` responds with `text/event-stream`:

| Event | Payload | Meaning |
| --- | --- | --- |
| `meta` | `generationId`, `projectId`, `projectTitle`, `references` | Sent before any provider work; the run is already addressable |
| `references` | `references`, `imagesSent` | Which uploaded files are travelling with this prompt, and how many go as vision input |
| `start` | provider, model, kind, pricing flags, `isDemo` | Which model is answering, and whether it is real |
| `delta` | `text` | A chunk of output; appended verbatim |
| `asset` | `url`, `revisedPrompt` | An image as it streams (data URL), for image kinds |
| `notice` | `message` | Non-fatal information (demo output, estimated usage, early stop) |
| `usage` | `tokensIn`, `tokensOut`, `estimated` | Token accounting |
| `error` | `message`, `hint`, `code` | A failure the user can act on |
| `done` | `generation`, `project`, `activity`, `usage`, `failed` | The persisted record plus refreshed workspace state |

A failure before the first token (unconfigured provider, unknown model) is reported as an `error`
event followed by `done`, so the UI has one failure path instead of two. If the client disconnects,
the request is aborted upstream and the partial output is still stored with its status.

`done` deliberately carries the refreshed project, activity feed, and usage summary: the client
applies them directly rather than firing three more requests and risking a stale view.

## Data model

```
users ──── memberships ──── workspaces ──── invites
  │             │                 │
  └── sessions  └── role          └── every content table below carries workspace_id
                                      │
projects ──┬── generations (project_id, ON DELETE SET NULL)
           ├── files (project_id)  ◄── bytes live in data/uploads/
           │
automations ──┬── automation_runs ──► generations (generation_id)
              │
prompts      settings (workspace_id, key)      activity (feed)
```

### Tenancy

`users`, `workspaces`, `memberships`, `sessions`, and `invites` are the account tables. Every
content table gained a `workspace_id`, and **no route queries content directly**: `store.forWorkspace(id)`
returns a scoped handle whose statements all carry the workspace id, so a forgotten `WHERE` clause
cannot leak another tenant's row. Asking for a project that exists in a different workspace answers
`404`, the same as asking for one that never existed.

A workspace always has exactly one owner. Transferring ownership demotes the previous owner to
admin in the same transaction, and the owner row cannot be edited or removed by anyone — including
themselves — which is what makes "exactly one owner" true rather than aspirational.

### Accounts and sessions

| Concern | Decision |
| --- | --- |
| Passwords | `scrypt` (N=16384, r=8, p=1) with a 16-byte random salt, stored as `scrypt$salt$hash`; verified in constant time |
| Sessions | 32 random bytes, base64url in the cookie; only its SHA-256 digest is stored, so a database copy cannot be replayed |
| Cookie | `studio_session`, `HttpOnly`, `SameSite=Lax`, `Secure` when `x-forwarded-proto: https`; 30-day sliding expiry |
| Scripts | The same token is accepted as `Authorization: Bearer …` |
| CSRF | Any cookie-authenticated write must be same-origin. The browser's `Sec-Fetch-Site` header is the primary signal — page JavaScript cannot forge it and it survives a proxy that rewrites `Host`; `Origin`/`Referer` against `Host` is the fallback, and a request with neither came from a non-browser client that cannot carry an ambient cookie |
| Throttling | Sign-in and sign-up are limited per `email|ip` in memory (10 per 15 minutes by default) |
| Enumeration | A wrong password and an unknown email return the identical 401 body |
| Password change | Every session for that user is deleted, then the caller signs in again |

Roles are a ladder — `viewer(1) < editor(2) < admin(3) < owner(4)` — and routes ask for a
**capability** (`read`, `write`, `run`, `manage`, `own`) rather than naming a role, so adding a role
later is a one-line change in `server/auth.js`. The frontend mirrors the ladder only to hide
controls; the server never trusts it.

### The upgrade path

A database created before this phase has no workspace column anywhere. `server/db.js` migrates it
additively: tables are created if missing, missing columns are added, the old global `settings`
table is rebuilt with a composite key, and existing rows are parked in a workspace with **no
members**. The next person to sign up claims it (`claimed: true` in the response), so an existing
studio stays reachable without a default password. Indexes are created after the migration, never
inside the schema string, because an index on a column that only exists post-migration cannot be
created before it. `npm test` builds a database with the previous release's schema and asserts the
migration keeps its projects, generations, settings, and activity.

- **projects** — title, type, model, status, brief, deterministic artwork key, output count, archived flag.
- **generations** — the unit of truth for usage: provider, model id and label, kind, mode, prompt,
  output text, optional asset, status, error, tokens, credits, cost, latency, timestamps.
- **prompts** — the library, with real use counts.
- **automations / automation_runs** — workflows with a structured `schedule` (JSON), the `next_run_at`
  the scheduler claims, and a run history linked to the generation each run produced.
- **files** — uploads and generated assets: name, mime, size, kind (`attachment` / `output`), the
  stored filename, a text excerpt for prompt use, and the project/generation they belong to.
- **settings** — per-workspace preferences and timezone; a `(workspace_id, key)` table so new
  preferences need no migration.
- **activity** — the dashboard feed, written whenever something meaningful happens.

Archiving a project sets a flag rather than deleting rows, so usage history stays intact.

## The scheduler

`server/schedule.js` is pure math: it turns a schedule object plus a timezone into the next UTC
instant, and never returns a moment in the past. Timezone handling goes through `Intl`, so DST is
the platform's problem rather than a table of offsets we would get wrong.

`server/scheduler.js` is one unref'd timer with a three-step contract:

1. **Find** automations whose `next_run_at` has passed (`store.dueAutomations`).
2. **Claim** — move `next_run_at` forward *before* running. A crash mid-run, a slow provider, or a
   second tick cannot double-fire the same window.
3. **Run** through `automations.execute()` — the same function behind the Run-now button — then set
   the next occurrence relative to the finish time.

Two policies are deliberate and documented in the code:

- **No backfill.** A server that was offline runs a due workflow once, not once per missed window.
- **Back off on failure.** A failed run schedules its next attempt one backoff window out instead
  of retrying immediately, so a broken provider cannot become a tight loop.

Event triggers take the same path. A `PATCH /api/projects/:id` that changes a status looks up the
automations watching that value and runs them in the background, so the HTTP response is not held
open by a model call. The run history records its source (`manual`, `scheduled`, `event`), which is
why the same executor exists in one place.

## Files and attachments

Uploads arrive as multipart, are validated against an allowlist and a size cap, and are written to
`data/uploads/` beside the database. `server/files.js` owns the disk side; `store` owns the rows;
both are keyed by the same file id, so a row without bytes is detectable (`file_missing`) rather
than silently serving an empty image.

Attachments reach a prompt in two shapes, because models accept them that way: images become vision
input for the provider adapter, and text documents are appended under a "Reference material"
heading. The gateway reports what it sent back to the client in the `references` event, so the UI
can show the user exactly which files the model saw.

Generated images are persisted the same way: the provider returns a data URL, the server writes it
as a file, and the generation row stores the URL. Rows stay small, the browser can cache assets,
and the same `GET /api/files/:id` route serves uploads and outputs.

## Frontend design

`app.js` is a single IIFE with an explicit state object and a render function per page. Two rules
keep it honest:

- **Optimistic only where it is invisible.** A toggle flips instantly and rolls back on failure.
  Anything that produces data (a project, a generation) waits for the server's answer.
- **The server is the source of truth when it is present.** `GET /api/bootstrap` returns the whole
  workspace in one call and overwrites local state; anything the server reports as changed is
  applied through a single `applyServerState()` helper.

The gate comes first. Boot asks `GET /api/auth/session`; if nobody is signed in, an auth screen
covers the shell (the shell is never rendered behind it) and the studio loads only after a session
exists. A `?invite=<token>` link in the URL turns that same screen into an acceptance flow. Every
request that comes back `401` re-opens the gate, so an expired session can never leave a half-dead
workspace on screen.

Role awareness lives in one place, `state.session.canWrite` / `canManage`, read from the bootstrap
payload. It hides what the caller cannot use — the composer becomes a read-only note for viewers,
invite controls disappear below admin, the owner's row is a badge instead of a dropdown — but it is
only a courtesy: the same action attempted directly against the API is refused by the server.

Offline behaviour is deliberate: if the API is not reachable, the app renders the demo workspace
from local storage, the status pill switches to `Demo mode`, and generation is replaced by a clear
"start the server" message rather than a broken button.

The status pill (`Demo mode` / `Demo engine` / `Live models`) is the user-facing contract for what
is really happening. Clicking it shows provider configuration state, and generation output always
carries a demo notice when the demo engine wrote it.

## Persistence and operations

- SQLite in WAL mode with foreign keys on, created and seeded on first run.
- Seeding happens only when the projects table is empty; after that the database is authoritative.
- `SIGINT`/`SIGTERM` close the server, then the database. `AI_STUDIO_QUIET=1` silences the access log.
- Static serving refuses to hand out `.env`, anything under `server/`, or anything under `data/`,
  and blocks path traversal outside the repository root.
- Uploads and generated assets live in `data/uploads/` (`AI_STUDIO_UPLOADS` overrides); with an
  in-memory database the file store falls back to a temporary directory so a test run leaves no
  traces behind.
- The scheduler starts with the server and shuts down with it: the timer is `unref`'d, so it never
  keeps the process alive on its own.

## Testing

Two layers, both running the real code rather than mocks:

- **`npm test`** (`server/selftest.js`) boots an actual server process against a temporary SQLite
  file with every provider key blanked, then drives the API the way a browser does — including
  reading complete SSE streams and asserting the generation rows, credits, project output count,
  and usage aggregates that result. It also covers static serving, secret-exposure checks,
  archiving, duplication, prompt counters, automation runs, error paths (missing prompt, malformed
  JSON, unconfigured provider, 404s), multipart uploads, attachments reaching the prompt, generated
  assets landing on disk, an event trigger firing from a status change, and a scheduled workflow
  running on its own — the test boots the scheduler with a fast tick so the real timer is exercised.
- **`node tools/frontend-smoke.mjs`** loads `index.html` into a headless DOM (jsdom, installed with
  `--no-save` so it never becomes a runtime dependency) with `fetch` pointed at a running server,
  and drives the real UI: page navigation, catalogue filtering, the Connections tab, an image
  generation and a writing generation with their streamed output and persisted history, attaching a
  reference file and confirming the dialog reports it, reading run history on the automations page,
  building a schedule through the modal, opening a project's stored files, saving a prompt, and
  using the command palette. It fails on any uncaught error, unhandled rejection, or
  `console.error`.

That combination is why a `const` reassigned inside the boot path — invisible to the API tests —
was caught before shipping.
