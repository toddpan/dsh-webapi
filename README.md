# dsh-webapi (@dsh-external/dsh-web-service)

**English** | [中文](README.zh.md)

A DSH plugin that exposes DeepSeek Harness over HTTP: the workspaces, sessions, models, settings,
skills and files already inside DSH become plain REST endpoints and SSE streams, plus an
OpenAI-compatible `/chat/completions` so an existing OpenAI client can talk to DSH unchanged.

Typical uses: a self-hosted console for DSH, a desktop or mobile client, CI / automation that drives
an agent, a non-DSH agent that calls DSH as a tool, or a gateway that puts DSH behind your own API.

- **No new dependencies** — the plugin only `inject`s `webServer` and `tools`; the routes ride on the
  DSH host webserver (or an optional standalone port).
- **47 routes** (REST + SSE), documented by a built-in OpenAPI 3.0 spec and a request page.
- **Bilingual skill included** — `skills/dsh-web-service/SKILL.md` teaches a DSH agent how to drive
  the API (streaming, cancelling, answering pending questions, file uploads).

## Install

Requires DSH `0.1.0`–`0.1.9` (peer ranges in `package.json`; verified on `0.1.7-rc.2`).

**Option 1: prebuilt tarball (recommended — no build step, no `allowBuilds` approval)**

```bash
dsh plugin --profile web add \
  https://github.com/toddpan/dsh-webapi/releases/latest/download/dsh-web-service.tgz
```

`dsh plugin` records the package in the profile `package.json` (dependency + `dsh.profile.bundles`);
a profile with HMR assembles it immediately, otherwise restart DSH. Verify:

```bash
curl -s http://127.0.0.1:3080/api/v1/system/status   # {"ok":true,...}
curl -sI http://127.0.0.1:3080/api/v1/docs           # HTTP/1.1 200 OK
```

> **Upgrading.** The asset name carries no version, so `latest/download/dsh-web-service.tgz` always
> points at the newest build for a *fresh* install — but package managers may reuse a cached
> resolution of that URL. To move an existing install to a known build, pin the versioned asset:
> `dsh plugin --profile web add https://github.com/toddpan/dsh-webapi/releases/download/v0.1.11/dsh-web-service-0.1.11.tgz`

**Option 2: build from source** (needs a DSH source checkout)

```bash
git clone https://github.com/toddpan/dsh-webapi && cd dsh-webapi
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh     # src/ → lib/
dsh plugin --profile web add "$PWD"
```

`lib/` is build output and is not committed, **so installing straight from git yields no runnable
code** — use option 1, or build first. `scripts/build.sh` symlinks `cordis` / `schemastery` /
`@deepseek-ai/*` peers out of the checkout, so no `npm install` is needed.

## Configuration

All fields are optional; they live in the plugin row's `config` in your profile patch (defaults in
`src/index.ts`):

| Field | Default | Meaning |
|---|---|---|
| `pathPrefix` | `/api/v1` | Route prefix |
| `apiKey` | `''` | Non-empty enables auth; requests must carry this key |
| `standalonePort` | `0` | `>0` also listens on its own port; `0` means host webserver only |
| `cors` | `true` | Allow cross-origin requests |
| `defaultCwd` | `''` | Default working directory; empty means `process.cwd()` |
| `maxUploadBytes` | `2 GiB` | Upload size limit; use the chunked endpoints for bigger files |

## Features

1. **Workspaces** — create, update, delete and list workspaces and their sessions.
2. **Sessions** — create, delete/archive, retitle or switch model, list, and page through message history.
3. **Models & settings** — list models and providers, read and update the global default model, read
   settings namespaces, list agent presets.
4. **Streaming** — `POST /sessions/:id/prompt-stream` pushes `delta`, `reasoning`, `tool_call`,
   `tool_result` and `turn_end` over Server-Sent Events; `GET /sessions/:id/events` taps the session's
   raw event bus.
5. **OpenAI compatibility** — `POST /chat/completions` accepts a standard OpenAI client, streaming or not.
6. **Built-in docs** — interactive request page at `GET /api/v1/docs`, OpenAPI 3.0 spec at
   `GET /api/v1/openapi.json`.
7. **Interactive sessions** — read pending `ask_user_question` batches and answer them over REST, cancel
   a running turn, upload/list/download workspace files (including resumable chunked upload).

## API routes

Default prefix: `/api/v1`

| Module | Method | Path | Notes |
|---|---|---|---|
| **System** | `GET` | `/system/status` | System status, live models, port info |
| **Workspaces** | `GET` | `/workspaces` | List workspaces |
| | `POST` | `/workspaces` | Create / add a workspace |
| | `GET` | `/workspaces/:id` | Workspace detail |
| | `PUT` | `/workspaces/:id` | Rename a workspace |
| | `DELETE` | `/workspaces/:id` | Remove a workspace binding |
| | `GET` | `/workspaces/:id/sessions` | Sessions in a workspace |
| **Sessions** | `GET` | `/sessions` | List sessions (search + workspace filter) |
| | `POST` | `/sessions` | Create a session |
| | `GET` | `/sessions/:id` | Session detail and state |
| | `PUT` | `/sessions/:id` | Update a session (title / model) |
| | `DELETE` | `/sessions/:id` | Delete or archive a session |
| | `GET` | `/sessions/:id/history` | Paged message history |
| | `GET` | `/sessions/:id/stats` | Live stats: turns/steps, LLM and tool timings, mean first token, decode throughput, cache hits, token ledger (matches the harness session-stats projection) |
| | `GET` | `/sessions/:id/todos` | Task list + elapsed time: `todos[{content,status}]` (`todo_write` full-table projection, cleared on `turn/start`), `counts{completed,inProgress,pending}`, `running`/`elapsedMs` (wall clock of the current or last turn), `turnStartedAt`/`turnEndedAt`/`updatedAt` — for a third-party console's "tasks" panel (≥0.1.8) |
| | `GET` | `/sessions/:id/skills` | Session-scoped skill catalog (resolves skill roots from the session cwd, supports `?search=`; mirrors `skills/list` for a "/" completion menu) |
| | `GET` | `/sessions/:id/questions` | Pending `ask_user_question` batches (host-side answer bridge, ≥0.1.7; includes the connection-layer race bypass and ALS session binding) |
| | `POST` | `/sessions/:id/answers` | Answer pending questions (`answers: [{id, selected, custom?}]`); the tool returns as an ordinary tool/result and the session continues |
| | `POST` | `/sessions/:id/cancel` | Abort the current turn |
| | `POST` | `/sessions/:id/files` | Upload into the session workspace (multipart, or raw + `?filename=`); duplicate names get `-1` suffixes, and the agent can read them with its file tools |
| | `GET` | `/sessions/:id/files` | List the session workspace (`?path=` browses a subdirectory, directories first) |
| | `GET` | `/sessions/:id/files/download` | Download a workspace file (`?path=` relative; `?inline=1` for in-browser preview) |
| **Streaming** | `POST` | `/sessions/:id/prompt-stream` | Send a prompt and receive generation as SSE |
| | `GET` | `/sessions/:id/events` | Subscribe to the session event bus as SSE |
| | `POST` | `/sessions/:id/prompt` | Send a prompt and wait for the result synchronously |
| **OpenAI** | `POST` | `/chat/completions` | OpenAI Chat protocol (streaming and non-streaming) |
| **Models** | `GET` | `/models` | Available models and the default model |
| | `GET` | `/models/default` | Read the global default model |
| | `PUT` | `/models/default` | Update the global default model |
| | `GET` | `/providers` | Registered LLM providers |
| | `GET` | `/presets` | Available agent presets |
| **Settings** | `GET` | `/settings` | Settings namespaces |
| | `PATCH` | `/settings/:namespace` | Update one namespace |
| **Docs** | `GET` | `/docs` | Interactive API request page |
| | `GET` | `/openapi.json` | OpenAPI 3.0 document |

## Development

```bash
# Build the plugin
bash scripts/build.sh

# Hot-inject at runtime (needs dsh-super-injector)
dev_inject_plugin {"dir": "/path/to/dsh-web-service"}

# Hot reload
dev_reload_package {"packageName": "dsh-web-service"}
```

## Skill: teach an agent to drive this API

The repository ships a DSH-native skill (`skills/dsh-web-service/SKILL.md`). Once installed, a DSH
agent discovers it automatically and knows how to use every endpoint (triggers: driving DSH over
HTTP, third-party integration, OpenAI-compatible calls; also available in-session as
`/dsh-web-service`).

### Install online (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/toddpan/dsh-webapi/main/scripts/install-skill.sh | bash
```

It installs into the user-level skill directory `~/.dsh/skills/dsh-web-service/`, where DSH's
skill-filesystem provider discovers it live (no restart) — usable from the next session.

### Options

```bash
# Install into a specific directory (project-level .dsh/skills or .agents/skills)
curl -fsSL .../install-skill.sh | bash -s -- --dir /path/to/project/.dsh/skills

# Pick a branch / repository
curl -fsSL .../install-skill.sh | bash -s -- --branch dev
curl -fsSL .../install-skill.sh | bash -s -- --repo other/dsh-webapi

# Uninstall
curl -fsSL .../install-skill.sh | bash -s -- uninstall
# or locally: bash install-skill.sh uninstall
```

What the script does: download `SKILL.md` → validate the frontmatter → install into the target
directory → probe ports 3080/3000 for a running DSH Web Service and report. Idempotent.

### Local install (inside the repo)

```bash
bash scripts/install-skill.sh
```

## License

BSD-3-Clause
