# AI Studio OS

A creative AI workspace: one place to shape ideas, run them through real models, and keep every output, credit, and decision in a searchable project.

This repository is a working application, not a mockup. It has a browser UI, an HTTP API, a
provider-agnostic generation gateway, and SQLite persistence — with no build step and no npm
dependencies.

```bash
node --version   # 22.5+ (uses the built-in node:sqlite driver)
npm start        # http://localhost:4173
```

That is the whole setup. Without API keys the app runs in **demo mode**: generations come from a
local placeholder engine so every flow still works end to end. Add a key to `.env` and the same
flows start calling the real model — no code changes, no rebuild.

## What works today

| Area | Status |
| --- | --- |
| Prompt → streamed model output | ✅ Real streaming (SSE), live token-by-token rendering |
| Projects, prompts, automations, settings | ✅ Stored in SQLite, survive restarts |
| Usage & credits | ✅ Computed from recorded generations, CSV export |
| Multiple providers | ✅ OpenAI, Anthropic, Google Gemini, Ollama, plus the demo engine |
| Model catalogue | ✅ Curated list + live discovery from each connected provider |
| Failures | ✅ Provider errors surface with a plain-language hint and are stored on the run |
| Automations that run themselves | ✅ Clock schedules (interval/daily/monthly) + event triggers, with run history |
| Reference files | ✅ Upload images and documents; images go to the model as vision input |
| Generated assets | ✅ Written to `data/uploads/` and served by URL, not inlined in rows |
| Billing, teams, canvas editor | ❌ Not in this phase (see Roadmap) |

## Run it

```bash
npm start              # production-ish: plain node, quiet experimental warnings
npm run dev            # same, with --watch for auto restart on file changes
npm test               # 62-check end-to-end self test (uses a temporary database)
```

Then open <http://localhost:4173>. The server binds `0.0.0.0` so it also works from a container or
a hosted preview URL.

### Configuration

Copy `.env.example` to `.env` and fill in what you have. Every provider is optional:

```bash
cp .env.example .env
# then set one or more of:
#   OPENAI_API_KEY=...
#   ANTHROPIC_API_KEY=...
#   GEMINI_API_KEY=...
#   OLLAMA_ENABLED=1          # local models, no key needed
```

Keys are read **only** by the server. The browser never receives a key, and `/.env` plus the
`server/` and `data/` directories are never served over HTTP. `.env`, `data/`, and `*.db` are
git-ignored.

Other useful settings: `PORT`, `AI_STUDIO_DB` (use `:memory:` for a throwaway database),
`AI_STUDIO_PROVIDER_ORDER` (which provider "Auto select" prefers), `AI_STUDIO_TIMEOUT_MS`,
`AI_STUDIO_UPLOADS` (where reference files and generated assets live), and
`AI_STUDIO_ALLOW_MOCK=0` to refuse demo output entirely.

The scheduler has its own switches:

```bash
AI_STUDIO_SCHEDULER=0            # stop the server from running workflows on a clock
AI_STUDIO_SCHEDULER_TICK_MS=30000  # how often it looks for due work
AI_STUDIO_SCHEDULER_MAX_PER_TICK=3 # a ceiling per check, so one tick cannot stampede
AI_STUDIO_SCHEDULER_BACKOFF_MS=300000 # wait after a failure instead of retrying at once
```

## How a generation flows

```
browser prompt ──► POST /api/generate ──► gateway.resolve(selection, kind)
   + fileIds          │                         │
                      │                         ├── picks a provider adapter
                      │                         ├── streams normalised events
                      │                         ▼
                      │   meta → references → start → delta… → (asset) → usage → done
                      │                                        text/event-stream
                      ▼                         │
        attachments read from disk              ▼
        (images → vision, text → prompt)  generations row + asset file on disk
                                          + credits + project outputs + activity
```

The browser renders each event as it arrives, so the user watches output appear rather than
watching a spinner. When the stream ends, the generation, its cost estimate, the project's output
count, the activity feed, and the usage totals are all updated in the same request. If the model
produced an image, the data URL becomes a real file under `data/uploads/` and the row stores its
URL instead of the bytes.

## Automations that run themselves

A schedule is data, not prose, so the server can tell when something is due:

```js
{ type: 'interval', everyMinutes: 60 }
{ type: 'daily',    time: '09:00', daysOfWeek: [1] }   // 1 = Monday
{ type: 'monthly',  day: 1, time: '09:00' }
{ type: 'event',    event: 'project.status', value: 'In review' }
{ type: 'manual' }
```

Wall-clock times are interpreted in the workspace timezone (Settings → Preferences), because "every
Monday at 9" means 9am for the person who wrote it. One scheduler timer in the server finds due
workflows, **moves each one's next run forward before executing it**, then runs it through the same
executor the Run-now button uses — so manual, scheduled, and event runs all produce identical rows
in `automation_runs`.

Two policies are deliberate: a server that was offline for a week runs a due workflow **once**
rather than catching up on 168 missed windows, and a failed run **backs off** instead of retrying
in a tight loop. Every run is recorded with its source (`manual`, `scheduled`, `event`), its status,
and the generation it produced.

## Reference files and assets

`POST /api/files` accepts multipart uploads (`multipart/form-data`, up to 8 files, 10 MB each) and
stores the bytes in `data/uploads/` beside the database. A generation can reference them with
`fileIds`:

- **images** are sent to the provider as vision input (OpenAI `image_url`, Anthropic base64 source,
  Gemini `inline_data`, Ollama `images`),
- **text documents** are appended to the prompt as reference material,
- anything else is stored and listed, and the run records what it attached.

Generated images are saved as files too, so project rows stay small and browsers can cache and
download assets like any other URL: `GET /api/files/:id`.

## Project layout

```
index.html          app shell, inline SVG icon sprite
styles.css          responsive visual system
app.js              UI: pages, dialogs, streaming view, API client
server/
  index.js          HTTP server: static files + JSON/SSE API
  gateway.js        model resolution, streaming, credits, demo fallback
  catalog.js        curated models, credit rates, cost estimates
  store.js          data access (all SQL lives here)
  db.js             SQLite schema, seeding, row shaping
  config.js         .env loading and provider configuration
  seed.js           the demo workspace and automation templates
  schedule.js       schedule data model, timezone math, next-occurrence engine
  scheduler.js      the tick loop: claim, run, reschedule, back off
  automations.js    one executor shared by manual, scheduled, and event runs
  files.js          multipart parsing, disk storage, attachment preparation
  providers/        one file per vendor: openai, anthropic, gemini, ollama, mock
  selftest.js       end-to-end API and streaming test
docs/               architecture, API reference, provider guide
data/               SQLite database + uploaded/generated files (git-ignored)
```

## Tests

```bash
npm test                          # 62 API + streaming + persistence + scheduler checks
npm i --no-save jsdom             # test-only, never a runtime dependency
node tools/frontend-smoke.mjs      # 63 UI checks against a running server
```

`npm test` boots the real server against a temporary database with every provider key blanked, then
drives the API the way the browser does — including reading whole SSE generation streams and
asserting the generation rows, project output counts, credits, and usage aggregates they produced.
Phase-3 checks cover multipart uploads, attachments reaching the prompt, generated assets landing
on disk, an event trigger firing from a status change, and a scheduled workflow running on its own
(the test drives the scheduler with a fast tick).

`tools/frontend-smoke.mjs` loads `index.html` into a headless DOM pointed at a running server and
drives the actual UI: it moves between every page, filters the model catalogue, checks the
Connections tab, runs an image generation and then a writing generation (watching tokens arrive,
the caret state, the stats block, and the saved history), saves a prompt, opens the project detail,
and uses the command palette — failing if anything logs an error or throws.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layers, data model, request flows, decisions
- [`docs/API.md`](docs/API.md) — every endpoint with examples
- [`docs/PROVIDERS.md`](docs/PROVIDERS.md) — how to add a provider or a model

## Honest limitations

- **Credits and costs are estimates.** They are derived from published per-model rates in
  `server/catalog.js`, which you should verify with each provider. They are suitable for a usage
  view, not for invoicing.
- **Model ids drift.** Curated ids are defaults. When a key is present the server asks the
  provider for its live model list and marks entries `verified`/`ID UNVERIFIED` in the UI.
- **The demo engine is not an AI.** It writes a deterministic draft locally. Output from it is
  labelled `DEMO` in the API, the UI, and the database row.
- **Files live on the local disk.** `data/uploads/` is fine for one machine; point it at a shared
  volume (`AI_STUDIO_UPLOADS`) or object storage before running more than one server.
- **The scheduler is in-process.** It ticks inside the web server, so workflows only run while that
  process is up — a due window is caught once on the next boot. Nothing is lost or repeated, but a
  multi-instance deployment would want a shared queue.
- **No authentication.** One workspace, one user, local-first. Do not expose a keyed instance to
  the public internet as-is.
- **Workspace chores still need you.** Automations that generate (digests, handoffs, briefs) run
  end to end; steps that are not a generation (tidying projects, sending email) record themselves
  as `skipped` rather than pretending they happened.

## Roadmap

1. **Object storage** — swap the disk file store for S3/R2 and keep only URLs in SQLite.
2. **Accounts and teams** — auth, workspaces, roles, shared projects.
3. **Billing** — real plan management instead of the estimated credits ledger.
4. **Canvas** — a real node/graph editor instead of the current concept page.
5. **Non-generation automation steps** — project tidying, exports, and outbound notifications.
