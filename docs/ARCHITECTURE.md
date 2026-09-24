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
│  server/store.js    data access (all SQL)                           │
│  server/db.js       schema · seeding · row shaping                  │
│  server/providers/  openai · anthropic · gemini · ollama · mock     │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                    data/studio.db (SQLite, WAL)
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
  streamText({ model, prompt, system, maxTokens, signal }): AsyncGenerator<Event>,
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
| `meta` | `generationId`, `projectId`, `projectTitle` | Sent before any provider work; the run is already addressable |
| `start` | provider, model, kind, pricing flags, `isDemo` | Which model is answering, and whether it is real |
| `delta` | `text` | A chunk of output; appended verbatim |
| `asset` | `url`, `revisedPrompt` | An image (data URL), for image kinds |
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
projects ──┬── generations (project_id, ON DELETE SET NULL)
           │
automations ──┬── automation_runs ──► generations (generation_id)
              │
prompts      settings (key/value)      activity (feed)
```

- **projects** — title, type, model, status, brief, deterministic artwork key, output count, archived flag.
- **generations** — the unit of truth for usage: provider, model id and label, kind, mode, prompt,
  output text, optional asset, status, error, tokens, credits, cost, latency, timestamps.
- **prompts** — the library, with real use counts.
- **automations / automation_runs** — workflows and their run history, linked to the generation a
  run produced.
- **settings** — workspace, profile, timezone; a key/value table so new preferences need no migration.
- **activity** — the dashboard feed, written whenever something meaningful happens.

Archiving a project sets a flag rather than deleting rows, so usage history stays intact.

## Frontend design

`app.js` is a single IIFE with an explicit state object and a render function per page. Two rules
keep it honest:

- **Optimistic only where it is invisible.** A toggle flips instantly and rolls back on failure.
  Anything that produces data (a project, a generation) waits for the server's answer.
- **The server is the source of truth when it is present.** `GET /api/bootstrap` returns the whole
  workspace in one call and overwrites local state; anything the server reports as changed is
  applied through a single `applyServerState()` helper.

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

## Testing

Two layers, both running the real code rather than mocks:

- **`npm test`** (`server/selftest.js`) boots an actual server process against a temporary SQLite
  file with every provider key blanked, then drives the API the way a browser does — including
  reading a complete SSE stream and asserting the generation row, credits, project output count,
  and usage aggregates that result. It also covers static serving, secret-exposure checks,
  archiving, duplication, prompt counters, automation runs, and error paths (missing prompt,
  malformed JSON, unconfigured provider, 404s).
- **`node tools/frontend-smoke.mjs`** loads `index.html` into a headless DOM (jsdom, installed with
  `--no-save` so it never becomes a runtime dependency) with `fetch` pointed at a running server,
  and drives the real UI: page navigation, catalogue filtering, the Connections tab, an image
  generation and a writing generation with their streamed output and persisted history, prompt
  saving, and the command palette. It fails on any uncaught error, unhandled rejection, or
  `console.error`.

That combination is why a `const` reassigned inside the boot path — invisible to the API tests —
was caught before shipping.
