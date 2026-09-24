# API reference

Base URL: the origin that serves the app (default `http://localhost:4173`). All responses are
JSON except `POST /api/generate`, which streams `text/event-stream`.

Errors use one shape, and include a hint the UI shows verbatim:

```json
{ "error": { "message": "anthropic is not connected, so \"Claude Sonnet\" cannot run yet.",
             "code": "provider_not_configured",
             "hint": "Set ANTHROPIC_API_KEY in .env to enable Claude models.",
             "provider": "anthropic" } }
```

## Authentication

Every endpoint below except `GET /api/health`, `GET /api/auth/session`, and the two invite-accept
routes requires a signed-in member of a workspace. The session is a cookie (`studio_session`,
`HttpOnly`, `SameSite=Lax`, 30-day sliding expiry) or the same token as
`Authorization: Bearer <token>`. A missing or expired session answers `401` with
`code: "unauthenticated"`; a session without permission for the action answers `403` with
`code: "forbidden"` and a hint naming the role that would be needed.

Cookie-authenticated writes must also be same-origin — a request carrying `Origin`/`Referer` for
another host is refused with `code: "cross_origin"`. Non-browser clients (curl, tests) send no
`Origin` and are unaffected, because they cannot send an ambient cookie.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Liveness, mode, provider summary (`?probe=1` also tests each key) — public |
| `GET /api/auth/session` | Who am I: user, workspaces, role, capabilities — public, `authenticated: false` when signed out |
| `POST /api/auth/signup` | Create the first account (claims the seeded workspace) or a new one |
| `POST /api/auth/login` / `POST /api/auth/logout` | Start and end a session |
| `PATCH /api/me` | Rename yourself, or change your password (which signs out every session) |
| `GET /api/workspaces` · `POST /api/workspaces` | List / create (and switch to) a workspace |
| `POST /api/workspaces/switch` | Make another of your workspaces active |
| `PATCH /api/workspaces/:id` | Rename, set the plan, or `transferTo` a member |
| `DELETE /api/workspaces/:id` | Delete it — requires `{ "confirm": "<exact name>" }` |
| `GET /api/members` | Members, pending invites, and the roles you may assign |
| `PATCH /api/members/:id` · `DELETE /api/members/:id` | Change a role / remove (yourself included) |
| `POST /api/invites` | Invite someone by email, as admin, editor, or viewer |
| `GET /api/invites/:token` | Describe an invite — public, for the acceptance screen |
| `POST /api/invites/:token/accept` | Join the workspace (creates the account, or uses your session) |
| `DELETE /api/invites/:id` | Revoke a pending invite |
| `GET /api/bootstrap` | Everything the UI needs to boot, in one call |
| `GET /api/models` | Model catalogue (`?refresh=1` forces rediscovery) |
| `GET /api/projects` | Projects (`?archived=1` includes archived) |
| `POST /api/projects` | Create a project |
| `GET /api/projects/:id` | Project plus its generation history |
| `PATCH /api/projects/:id` | Update title, type, model, status, or brief |
| `DELETE /api/projects/:id` | Archive (not delete) |
| `POST /api/projects/:id/duplicate` | Copy a project |
| `POST /api/generate` | **Stream a generation** |
| `GET /api/generations/:id` | A single generation record plus its files |
| `GET /api/prompts` · `POST /api/prompts` | Prompt library |
| `POST /api/prompts/:id/use` | Increment a prompt's use count |
| `GET /api/automations` | Workflows (`?runs=1` includes each one's recent runs) |
| `POST /api/automations` | Create a workflow, with a schedule |
| `PATCH /api/automations/:id` | Pause, enable, edit, or reschedule |
| `POST /api/automations/:id/run` | Run now (real generation for generator steps) |
| `GET /api/automations/:id/runs` | Run history (`?limit=`) |
| `GET /api/scheduler` | Scheduler health: enabled, tick, counts, next automation |
| `POST /api/files` | **Upload reference files** (multipart) |
| `GET /api/files` | Stored files (`?projectId=`, `?limit=`) |
| `GET /api/files/:id` | Serve a stored file (`?download=1` forces an attachment; `302` to a presigned URL when redirects are enabled) |
| `DELETE /api/files/:id` | Delete a stored file and its bytes |
| `GET /api/storage` | Which driver holds the bytes, its details, and usage — any member |
| `POST /api/storage/check` | Write, read back, and delete a probe object — owners and admins |
| `GET /api/projects/:id/files` | A project's reference files and generated assets |
| `GET /api/usage` | Plan, totals, breakdowns, seven-day series, recent runs |
| `GET /api/activity` | Dashboard feed (`?limit=`) |
| `GET /api/settings` · `PUT /api/settings` | Workspace and profile settings |

---

## `GET /api/bootstrap`

One round trip for the whole workspace: who you are, the workspaces you can reach, the members of
the active one, then mode, providers, models, projects, prompts, automations, activity, settings,
usage, and capability flags. It requires a session — signed out it answers `401`.

```bash
curl -s -b cookies.txt localhost:4173/api/bootstrap | jq '{user: .user.name, role, workspace: .workspace.name, projects: (.projects|length)}'
```

```json
{ "mode": "demo", "allowMock": true,
  "providers": [{ "id": "openai", "label": "OpenAI", "configured": false, "hint": "Set OPENAI_API_KEY in .env to generate with OpenAI models." }],
  "models": [{ "id": "openai-gpt-4.1", "name": "GPT-4.1", "provider": "openai", "kind": "text",
               "selectable": false, "isDemo": false, "verified": null,
               "pricing": { "input": 2, "output": 8, "unit": "usd-per-million-tokens", "estimated": true } }],
  "scheduler": { "enabled": true, "active": true, "tickMs": 30000, "timeZone": "Asia/Kolkata",
                 "counts": { "ticks": 12, "runs": 1, "failures": 0 },
                 "nextAutomation": { "id": "a-digest", "name": "Monday inspiration digest", "nextRunAt": "2026-09-28T03:30:00.000Z" } },
  "files": [{ "id": "f-98…", "name": "brief.txt", "mime": "text/plain", "size": 97, "kind": "attachment", "isImage": false, "url": "/api/files/f-98…" }],
  "capabilities": { "generation": true, "streaming": true, "persistence": "sqlite",
                    "imageGeneration": true, "realProviders": false,
                    "fileUploads": true, "attachments": true, "fileStorage": "local-disk",
                    "billing": false, "scheduling": true, "eventTriggers": true,
                    "accounts": true, "teams": true, "invites": true,
                    "roles": ["owner", "admin", "editor", "viewer"], "sessions": "cookie" } }
```

`selectable` is false when the model's provider has no key. `verified` is `true`/`false` when the
provider reported a live model list (`null` when it did not), which is how model-id drift becomes
visible in the UI instead of a runtime error.

---

## `POST /api/generate`

Streams a generation and persists it. If no `projectId` is given, the project is created from the
prompt (unless `createProject: false`).

| Field | Type | Notes |
| --- | --- | --- |
| `prompt` | string | Required |
| `model` | string | Catalogue name or id, or `"Auto select"` (default) |
| `mode` | string | `Writing` (default), `Image`, `Video`, `Audio`, `Code` |
| `projectId` | string | Attach to an existing project |
| `title` | string | Title for a newly created project |
| `type` | string | Project type for a newly created project |
| `system` | string | Optional system instruction |
| `maxTokens` | number | Clamped to 64–8000 (default 1200) |

```bash
curl -N -X POST localhost:4173/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"A slow launch film for a ceramic studio","mode":"Writing","model":"Auto select"}'
```

```
event: meta
data: {"generationId":"g-muf2uqry-cigf","projectId":"p-3f2a91c0","projectTitle":"A slow launch film for a ceramic studio"}

event: start
data: {"provider":"mock","providerLabel":"Studio demo engine","modelId":"studio-mock-v1","modelLabel":"Studio demo engine","kind":"text","isDemo":true,"isDemoFallback":true}

event: notice
data: {"message":"Demo output: generated locally by the Studio demo engine, not by an AI model."}

event: delta
data: {"text":"Here is a first pass"}

event: usage
data: {"tokensIn":23,"tokensOut":176,"estimated":true}

event: done
data: {"generation":{"id":"g-muf2uqry-cigf","status":"succeeded","credits":1,"latencyMs":369,"...":"..."},
       "project":{"id":"p-3f2a91c0","outputs":1,"status":"In progress"},
       "activity":[ ... ], "usage":{ ... }, "failed":false}
```

Notes for clients:

- `text/event-stream` framing is standard: `event:` then `data:` then a blank line.
- Failure before the first token arrives as `error` + `done{failed:true}` with the same HTTP 200
  stream (the connection is already open at that point). A JSON error status is only returned when
  the request is rejected before streaming starts (for example a missing prompt → `400`).
- Aborting the request cancels the upstream call; partial output is still stored.
- `credits` and `costUsd` are estimates from `server/catalog.js` rates, not invoices.

---

## `POST /api/generate` with reference files

Send `fileIds` (from `POST /api/files`) with the request and the run carries them:

```bash
curl -sN localhost:4173/api/generate -H 'Content-Type: application/json' \
  -d '{"prompt":"Match this brief","mode":"Writing","fileIds":["f-98…","f-5c…"]}'
```

```text
event: meta
data: {"generationId":"g-…","references":[{"id":"f-98…","name":"brief.txt","kind":"text","bytes":97}]}

event: start
data: {"provider":"mock","modelLabel":"Studio demo engine","kind":"text","imagesSent":1,"references":[…], …}
```

Images are forwarded to the provider as vision input; text documents are appended to the prompt as
reference material. Anything the model cannot read is still stored and listed. If the run produces
an image, `done.generation.assetUrl` is a `/api/files/…` URL and `done.generation.assetFile`
describes the stored file.

---

## `POST /api/files`

`multipart/form-data`, field name `files` (repeat up to 8 times), optional `?projectId=` to attach
them to a project. 10 MB per file; allowed types are images, PDFs, and plain-text-ish documents.

```bash
curl -s -F "files=@brief.txt;type=text/plain" -F "files=@swatch.png" \
  "localhost:4173/api/files?projectId=p-3f2a91c0"
```

```json
{ "files": [{ "id": "f-98…", "name": "brief.txt", "mime": "text/plain", "size": 97,
              "kind": "attachment", "isImage": false, "excerpt": "Studio brief…",
              "url": "/api/files/f-98…" }],
  "project": { "id": "p-3f2a91c0", "files": [ … ] },
  "storage": { "count": 2, "bytes": 258 } }
```

Text files come back with an `excerpt`; images are previewed in the UI by `url`. Bytes live in
`data/uploads/` (`AI_STUDIO_UPLOADS` overrides), never in a database row.

---

## `GET /api/storage`

Where files actually go, and how much is stored. Safe to show any member: it never includes
credentials.

```bash
curl -s -b cookies.txt localhost:4173/api/storage
```

```json
{ "driver": "s3", "label": "S3-compatible (studio-files)", "redirects": false,
  "active": { "driver": "s3", "bucket": "studio-files", "endpoint": "https://…r2.cloudflarestorage.com",
              "region": "auto", "prefix": "studio", "addressing": "path-style" },
  "drivers": [ { "driver": "local", "directory": "/app/data/uploads" },
               { "driver": "s3", "bucket": "studio-files", "endpoint": "…" } ],
  "usage": { "count": 12, "bytes": 1_884_320 } }
```

`POST /api/storage/check` performs the only test that matters — it writes an object, reads it back,
compares the bytes, and deletes it:

```json
{ "ok": true, "ms": 143, "bytes": 46, "driver": "s3", "bucket": "studio-files" }
```

A failure is reported as a 200 with `ok: false` and the provider's own reason, because "the bucket
refused us" is a finding rather than a server fault:

```json
{ "ok": false, "ms": 41,
  "error": { "message": "Object storage rejected the request: SignatureDoesNotMatch — The request signature we calculated does not match the signature you provided",
             "code": "storage_signature_does_not_match",
             "hint": "The storage credentials in .env do not match the bucket. Re-check the key id and secret." } }
```

## `GET /api/scheduler`

```json
{ "enabled": true, "active": true, "tickMs": 30000, "timeZone": "Asia/Kolkata",
  "startedAt": "2026-09-24T05:31:02.114Z", "lastTickAt": "2026-09-24T05:41:00.004Z",
  "lastResult": { "reason": "timer", "due": 1, "outcomes": [{ "automation": "Monday inspiration digest", "status": "succeeded" }] },
  "counts": { "ticks": 20, "runs": 1, "failures": 0 },
  "nextAutomation": { "id": "a-digest", "name": "Monday inspiration digest", "nextRunAt": "2026-09-28T03:30:00.000Z" } }
```

---

## `GET /api/usage`

```json
{ "plan": { "name": "Studio plan", "creditsIncluded": 10000, "creditsUsed": 3, "creditsRemaining": 9997, "renewsOn": "2026-10-06" },
  "totals": { "generations": 2, "succeeded": 2, "tokensIn": 46, "tokensOut": 352, "credits": 3, "costUsd": 0, "avgLatencyMs": 400 },
  "byProvider": [{ "provider": "mock", "count": 2, "credits": 3, "costUsd": 0 }],
  "byKind": [{ "kind": "text", "count": 2, "credits": 3 }],
  "daily": [{ "day": "2026-09-24", "label": "T", "count": 2, "credits": 3 }],
  "recent": [{ "id": "g-…", "model": "Studio demo engine", "status": "succeeded", "credits": 1, "createdLabel": "Just now" }] }
```

---

## `POST /api/automations/:id/run`

Runs an automation's mapped generator step through the gateway and records the run.

```json
{ "status": "succeeded", "output": "…generated text…", "isDemo": true,
  "automation": { "id": "a-digest", "lastRun": "2026-09-24T…" },
  "generation": { "id": "g-…", "credits": 1 } }
```

Automations whose action is a workspace chore rather than a generation reply
`{ "status": "skipped", "message": "…" }` — nothing is written, and the run is still recorded so
the history does not quietly lose it.

### Schedules

`POST` and `PATCH /api/automations` accept a `schedule` object. Anything else is rejected with
`400 invalid_schedule` and a hint the UI shows.

| Type | Shape | Meaning |
| --- | --- | --- |
| `interval` | `{ "type": "interval", "everyMinutes": 60 }` | Every hour (minimum 6 seconds) |
| `daily` | `{ "type": "daily", "time": "09:00", "daysOfWeek": [1] }` | Mondays at 09:00 (1 = Monday; omit the array for every day) |
| `monthly` | `{ "type": "monthly", "day": 1, "time": "09:00" }` | The 1st of each month (day 1–28) |
| `event` | `{ "type": "event", "event": "project.status", "value": "In review" }` | Whenever a project is marked “In review” |
| `manual` | `{ "type": "manual" }` | Only when someone presses Run |

`time` is a wall-clock time in the workspace timezone (`GET /api/settings` → `timezone`). Automation
rows carry `nextRunAt`, `nextRunLabel`, `triggerLabel`, `lastStatus`, and `lastRun`, so a client can
render the schedule without knowing the schedule rules. A manual run moves `nextRunAt` forward, so
pressing Run never causes a duplicate run minutes later.

---

## Behaviour worth knowing

- `POST /api/projects` and `POST /api/prompts` return the created record **and** the refreshed
  collection, so the UI can update without a follow-up read.
- `DELETE /api/projects/:id` archives: usage history and generations stay intact.
- Request bodies are capped at 1 MB; malformed JSON returns `400 invalid_json`.
- `OPTIONS` is answered for every route, but no `Access-Control-Allow-Origin` is ever sent: with
  cookie sessions the API is same-origin only, and a browser will not expose a cross-origin
  response to a page that has no business reading it.
- `AI_STUDIO_QUIET=1` disables the access log for cleaner test output.
- Uploads are capped at 8 files × 10 MB per request; larger bodies are rejected with `413` before
  anything is written to disk.
- Changing a project's `status` to a value an event automation watches fires that automation in the
  background — the `PATCH` response returns immediately and lists what it triggered.
- Everything workspace-owned is addressed inside the active workspace. Asking for a project,
  generation, file, or automation that lives in a workspace you belong to but are not currently in
  answers `404`, exactly like an id that never existed. Switch first, then ask.
- Pending invites are only included in `GET /api/members` and `GET /api/bootstrap` for owners and
  admins: they contain email addresses that a viewer has no reason to see.
- A generation run by a viewer is refused with the same `403` as any other write — running costs
  credits, so it counts as writing.
