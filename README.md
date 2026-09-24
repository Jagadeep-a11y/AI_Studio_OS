# AI Studio OS

A creative AI workspace: one place to shape ideas, run them through real models, and keep every output, credit, and decision in a searchable project.

This repository is a working application, not a mockup. It has a browser UI, an HTTP API, a
provider-agnostic generation gateway, SQLite persistence, and real accounts — with no build step
and no npm dependencies.

```bash
node --version   # 22.5+ (uses the built-in node:sqlite driver)
npm start        # http://localhost:4173
```

That is the whole setup. The first visitor creates the owner account and claims the workspace that
ships with the demo content; everyone else is invited into a workspace. Without API keys the app
runs in **demo mode**: generations come from a local placeholder engine so every flow still works
end to end. Add a key to `.env` and the same flows start calling the real model — no code changes,
no rebuild.

**Deploying this?** Create the owner account before the server is reachable from the internet —
after the first sign-up this server behaves like any multi-tenant app, but until then the first
stranger to sign up claims the seeded workspace.

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
| Accounts | ✅ Sign-up / sign-in with scrypt-hashed passwords and hashed session cookies |
| Teams & roles | ✅ Owner / admin / editor / viewer per workspace, enforced on every route |
| Workspaces | ✅ Per-user workspaces, switching, renaming, transfer, delete; complete data isolation |
| Invites | ✅ Single-use, 7-day links; accept by creating an account or signing in |
| Billing, canvas editor | ❌ Not in this phase (see Roadmap) |

## Run it

```bash
npm start              # production-ish: plain node, quiet experimental warnings
npm run dev            # same, with --watch for auto restart on file changes
npm test               # 159-check end-to-end self test (uses a temporary database)
```

Then open <http://localhost:4173>. The server binds `0.0.0.0` so it also works from a container or
a hosted preview URL.

The first screen is the sign-in gate: on a fresh database it offers to create the owner account and
explains which workspace that account will claim. Everyone after that signs in, or follows an invite
link (`/?invite=<token>`) that carries them into someone's workspace.

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

Accounts are local as well: passwords are hashed with `scrypt` (per-user salt, constant-time
compare) and only the SHA-256 digest of a session token is stored, so a copy of the database cannot
be replayed as a login. Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` whenever the
request arrived over HTTPS. See `docs/ARCHITECTURE.md` for the full account model.

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

## Accounts, workspaces, and roles

Everything in the Studio belongs to a **workspace**, and every workspace belongs to people with a
role. The roles are cumulative:

| Role | Can |
| --- | --- |
| **owner** | Everything, including transferring ownership and deleting the workspace. Exactly one per workspace. |
| **admin** | Invite editors and viewers, change roles below admin, rename the workspace, run and edit everything. |
| **editor** | Create projects, upload references, run generations and automations. |
| **viewer** | Read the workspace. Every write is refused, and the UI says so instead of failing late. |

The rules are enforced twice on purpose: the server checks the capability on every route, and the
UI hides controls the caller could not use. A viewer sees the composer replaced by a plain
explanation; nobody can reach a write by editing the DOM.

**Invites** are single-use links valid for seven days. Nothing is emailed in this build, so the
inviter copies the link out of the dialog. Opening it shows what the invitation is for; accepting
either creates the account or, if the address already has one, adds the workspace to that account
after they sign in.

Two details worth knowing:

- **The first account claims the demo workspace.** A fresh database seeds a workspace with no
  members so that the demo content is reachable without shipping a default password. The next
  person to sign up adopts it; everyone after that gets their own empty workspace.
- **Leaving is not a management action.** Any member can remove themselves; owners cannot leave
  until they hand ownership over, and a workspace you are alone in cannot be deleted.

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
  store.js          data access (all SQL lives here), workspace scoping
  accounts.js       sign-up, sessions, invites, roles, membership rules
  auth.js           password hashing, cookie helpers, rate limiting, origin checks
  html.js           the single HTML-escape helper shared by activity lines
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
npm test                           # 159 API, auth, tenancy, and migration checks
npm i --no-save jsdom              # test-only, never a runtime dependency
node tools/frontend-smoke.mjs      # 121 UI checks (starts its own server)
```

`npm test` boots the real server against a temporary database with every provider key blanked, then
drives the API the way the browser does — cookie sessions, whole SSE generation streams, and the
rows, output counts, credits, and usage aggregates they produce. It covers:

- **accounts**: weak and duplicate sign-ups, identical answers for a wrong password and an unknown
  email, sign-in, bearer tokens, password change invalidating other sessions, logout, throttling;
- **teams**: invites (create, describe, accept, revoke, re-use refused), an existing account joining
  without a second password, role changes in both directions, who may invite whom, self-removal,
  what an admin and a viewer are refused, ownership transfer;
- **tenancy**: a second workspace is empty, another workspace's project / generation / file /
  automation is invisible, switching cannot reach a workspace you are not in, settings are scoped;
- **hardening**: cross-origin cookie writes refused, same-origin writes allowed, only the token
  digest in the database, workspace deletion requiring the exact name, the last workspace kept;
- **the upgrade path**: a database built with the previous version's schema (kept in
  `server/fixtures/legacy-db.sql`) boots, migrates, and keeps its projects, generations, settings,
  and activity.

`tools/frontend-smoke.mjs` loads `index.html` into a headless DOM against a real server and drives
the actual UI as two different people: it creates the owner account at the sign-in gate, walks every
page, runs an image generation and then a writing generation (watching tokens arrive, the caret
state, the stats block, and the saved history), builds an automation, saves a prompt, opens the
project detail, uses the command palette, creates a second workspace and switches back, invites a
viewer, accepts that invite in a second window, confirms the viewer is read-only everywhere, then
promotes, removes, and verifies them — failing if anything logs an error or throws.

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
- **Accounts are built for one server.** Sessions live in the database (so a restart does not sign
  anyone out) and the sign-in throttle is in-process, which is honest for a single node and not
  enough behind a load balancer. Email is not verified and there is no password reset — an invite
  link is the recovery path an owner can hand out.
- **Sharing is per workspace, not per project.** A membership grants the whole workspace. Per-project
  grants are the next step if teams need them.
- **The first sign-up wins.** Until an owner exists, the demo workspace is claimable by anyone who
  reaches the server. Create the owner account before exposing a fresh instance.
- **Workspace chores still need you.** Automations that generate (digests, handoffs, briefs) run
  end to end; steps that are not a generation (tidying projects, sending email) record themselves
  as `skipped` rather than pretending they happened.

## Roadmap

1. **Object storage** — swap the disk file store for S3/R2 and keep only URLs in SQLite.
2. ~~**Accounts and teams**~~ — shipped in this phase: users, workspaces, memberships, invites, roles.
3. **Billing** — real plan management instead of the estimated credits ledger.
4. **Canvas** — a real node/graph editor instead of the current concept page.
5. **Non-generation automation steps** — project tidying, exports, and outbound notifications.
6. **Account depth** — email verification, password reset, per-project sharing, and a shared session
   store so more than one server process can serve the same workspace.
