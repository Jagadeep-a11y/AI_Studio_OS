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

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Liveness, mode, provider summary (`?probe=1` also tests each key) |
| `GET /api/bootstrap` | Everything the UI needs to boot, in one call |
| `GET /api/models` | Model catalogue (`?refresh=1` forces rediscovery) |
| `GET /api/projects` | Projects (`?archived=1` includes archived) |
| `POST /api/projects` | Create a project |
| `GET /api/projects/:id` | Project plus its generation history |
| `PATCH /api/projects/:id` | Update title, type, model, status, or brief |
| `DELETE /api/projects/:id` | Archive (not delete) |
| `POST /api/projects/:id/duplicate` | Copy a project |
| `POST /api/generate` | **Stream a generation** |
| `GET /api/generations/:id` | A single generation record |
| `GET /api/prompts` · `POST /api/prompts` | Prompt library |
| `POST /api/prompts/:id/use` | Increment a prompt's use count |
| `GET /api/automations` · `POST /api/automations` | Workflows |
| `PATCH /api/automations/:id` | Pause, enable, or edit |
| `POST /api/automations/:id/run` | Run now (real generation for generator steps) |
| `GET /api/automations/:id/runs` | Run history |
| `GET /api/usage` | Plan, totals, breakdowns, seven-day series, recent runs |
| `GET /api/activity` | Dashboard feed (`?limit=`) |
| `GET /api/settings` · `PUT /api/settings` | Workspace and profile settings |

---

## `GET /api/bootstrap`

One round trip for the whole workspace: mode, providers, models, projects, prompts, automations,
activity, settings, usage, and capability flags.

```bash
curl -s localhost:4173/api/bootstrap | jq '{mode, projects: (.projects|length), models: (.models|length)}'
```

```json
{ "mode": "demo", "allowMock": true,
  "providers": [{ "id": "openai", "label": "OpenAI", "configured": false, "hint": "Set OPENAI_API_KEY in .env to generate with OpenAI models." }],
  "models": [{ "id": "openai-gpt-4.1", "name": "GPT-4.1", "provider": "openai", "kind": "text",
               "selectable": false, "isDemo": false, "verified": null,
               "pricing": { "input": 2, "output": 8, "unit": "usd-per-million-tokens", "estimated": true } }],
  "capabilities": { "generation": true, "streaming": true, "persistence": "sqlite",
                    "imageGeneration": true, "realProviders": false,
                    "fileUploads": false, "billing": false, "scheduling": false } }
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
`{ "status": "skipped", "message": "…" }` — the scheduler phase implements those.

---

## Behaviour worth knowing

- `POST /api/projects` and `POST /api/prompts` return the created record **and** the refreshed
  collection, so the UI can update without a follow-up read.
- `DELETE /api/projects/:id` archives: usage history and generations stay intact.
- Request bodies are capped at 1 MB; malformed JSON returns `400 invalid_json`.
- `OPTIONS` is answered for every route; `Access-Control-Allow-Origin` echoes the request origin.
- `AI_STUDIO_QUIET=1` disables the access log for cleaner test output.
