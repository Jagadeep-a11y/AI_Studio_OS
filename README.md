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
| File uploads, billing, schedulers, teams | ❌ Not in this phase (see Roadmap) |

## Run it

```bash
npm start              # production-ish: plain node, quiet experimental warnings
npm run dev            # same, with --watch for auto restart on file changes
npm test               # 42-check end-to-end self test (uses a temporary database)
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
`AI_STUDIO_PROVIDER_ORDER` (which provider "Auto select" prefers), `AI_STUDIO_TIMEOUT_MS`, and
`AI_STUDIO_ALLOW_MOCK=0` to refuse demo output entirely.

## How a generation flows

```
browser prompt ──► POST /api/generate ──► gateway.resolve(selection, kind)
                                             │
                                             ├── picks a provider adapter
                                             ├── streams normalised events
                                             ▼
   meta → start → delta… → (asset) → usage → done        text/event-stream
                                             │
                                             ▼
                       generations row + project outputs + credits + activity
```

The browser renders each event as it arrives, so the user watches output appear rather than
watching a spinner. When the stream ends, the generation, its cost estimate, the project's output
count, the activity feed, and the usage totals are all updated in the same request.

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
  providers/        one file per vendor: openai, anthropic, gemini, ollama, mock
  selftest.js       end-to-end API and streaming test
docs/               architecture, API reference, provider guide
data/               SQLite database (created on first run, git-ignored)
```

## Tests

```bash
npm test                          # 42 API + streaming + persistence checks
npm i --no-save jsdom             # test-only, never a runtime dependency
node tools/frontend-smoke.mjs      # 48 UI checks against a running server
```

`npm test` boots the real server against a temporary database with every provider key blanked, then
drives the API the way the browser does — including reading a whole SSE generation stream and
asserting the generation row, project output count, credits, and usage aggregates it produced.

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
- **Generated images are stored inline** in SQLite as data URLs. Fine for a prototype; move
  assets to object storage before real use.
- **No authentication.** One workspace, one user, local-first. Do not expose a keyed instance to
  the public internet as-is.
- **Automations run when you press Run.** There is no scheduler yet, and non-generation steps
  (tidying projects, sending digests) report themselves as skipped rather than pretending.

## Roadmap

1. **Scheduler** — cron-style triggers so automations run on their stated schedule.
2. **Object storage** — move generated assets out of the database, add real uploads.
3. **Accounts and teams** — auth, workspaces, roles, shared projects.
4. **Billing** — real plan management instead of the estimated credits ledger.
5. **Canvas** — a real node/graph editor instead of the current concept page.
