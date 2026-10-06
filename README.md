# dsh-webapi (@dsh-external/dsh-web-service)

**English** | [中文](README.zh.md)

A DSH plugin that exposes DeepSeek Harness over HTTP: the workspaces, sessions, models, settings,
skills and files already inside DSH become plain REST endpoints and SSE streams, plus an
OpenAI-compatible `/chat/completions` so an existing OpenAI client can talk to DSH unchanged.

Typical uses: a self-hosted console for DSH, a desktop or mobile client, CI / automation that drives
an agent, a non-DSH agent that calls DSH as a tool, or a gateway that puts DSH behind your own API.

- **No new dependencies** — the plugin only `inject`s `webServer` and `tools`; the routes ride on the
  DSH host webserver (or an optional standalone port).
- **60 routes** (REST + SSE), documented by a built-in OpenAPI 3.0 spec and a request page, plus an API Key settings page.
- **Bilingual skill included** — `skills/dsh-web-service/SKILL.md` teaches a DSH agent how to drive
  the API (streaming, cancelling, answering pending questions, file uploads).

## Install

Requires DSH `0.1.0`–`0.2.x` (peer ranges in `package.json`; verified on `0.1.7-rc.2`, and type-checked plus assembly-verified on `0.2.0-rc.2`).

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
| `adminRemoteAccess` | `false` | Whether non-loopback clients may reach the API Key admin endpoints; key management is local-only by default |

> `apiKey` is only a **legacy single key**, kept for backward compatibility. Manage keys from the
> settings page instead — see [API Key management](#api-key-management-settings-page).

## API Key management (settings page)

Open **`GET /api/v1/settings/api-keys`** to manage the keys third parties use to call the API:
view (masked), create, rotate, revoke, and turn authentication on or off. The `/docs` page also
links to it from its header.

**Three entry points**

| Entry | Notes |
|---|---|
| "API Key 管理" in the DSH Web GUI sidebar | The plugin ships a browser half (client half); after a DSH restart the panel appears in the sidebar and embeds this page |
| `GET /api/v1/settings/api-keys` | The standalone page — bookmarkable |
| "管理 API Key" button on `/docs` | One click from the API docs |

The page sits behind an **admin token gate**: key management and normal API calls use two separate
credentials. On first open it asks for the admin token and shows the exact command to read it (run
on the machine that hosts DSH): `cat <DSH home>/dsh-web-service/admin-token`. The token is then kept
in the browser's localStorage. Until the gate passes, management buttons such as "新建 API Key" stay
hidden — no "click, then hit 401" dead ends.

Creating a key offers **two sources for the key value** (the `plaintext` field on `POST /api-keys`):

| Mode | Behaviour |
|---|---|
| Random (default) | Server generates `dsk_` + 32 bytes of CSPRNG (256-bit entropy) |
| **Use a custom key** | Paste an existing key (16–256 visible ASCII chars) to slot into an existing client or migrate |

> The strength of a custom key is your responsibility, so it **never shows even a prefix** — otherwise
> `my-secret-api-key-xxx` would leak most of its value in the first 12 characters. The server still
> stores only its hash, and the list marks such records as custom. A value that already has an
> **active** record is rejected (400); revoked/expired values may be registered again.

**Two separate credentials**

| Purpose | Credential | Header |
|---|---|---|
| Call business endpoints (data plane) | API Key | `Authorization: Bearer <key>` or `X-API-Key: <key>` |
| Manage keys (admin plane) | Admin Token | `Authorization: Bearer <admin-token>` or `X-Admin-Token: <admin-token>` |

So a third party holding an API key cannot mint new keys for itself. The Admin Token is generated
on first startup and stored under the DSH config root in `dsh-web-service/admin-token` (mode 0600):

```bash
cat "${DSH_HOME:-$HOME/.dsh}/dsh-web-service/admin-token"
```

**Security contract**

- The full key is shown **exactly once**, in the one-shot dialog after create/rotate. Afterwards only
  the prefix and a mask are shown; it cannot be recovered. Only `sha256(plaintext)` is persisted —
  the plaintext never reaches disk, logs or error messages.
- Admin endpoints accept **loopback clients only** by default. Remote key management requires
  `adminRemoteAccess: true`. Browser requests are same-origin checked (CSRF / DNS-rebinding);
  cross-origin gets `403 FORBIDDEN_ORIGIN`.
- Revoking is immediate and irreversible; rotating invalidates the old key at once. The safer path
  is: create a replacement key, roll it out, then revoke the old one.
- When `apiKey` is set in the plugin config, auth is **forced on** and cannot be switched off from
  the page. Auth cannot be switched on when no valid key exists, which would lock you out.
- A corrupt key store fails closed: auth is never relaxed and `/system/status` reports
  `keysStoreDegraded`. The corrupt file is renamed to `api-keys.json.corrupt-<timestamp>` for
  forensics and the store recovers from `api-keys.json.bak` (the last known good state, refreshed
  after every successful write), so existing key records are never silently dropped.
- The loopback guard looks at the TCP peer address. If DSH sits behind a reverse proxy or tunnel the
  plugin sees the proxy as the peer, so the guard is effectively bypassed — close it off at the
  network layer, or keep `adminRemoteAccess: false` and manage keys locally only.
- Data-plane auth is a Bearer/API-Key check with **no** same-origin rule: it is built for
  cross-origin third-party clients, so a browser page sending a valid key cross-origin is by design.
  The cross-origin surface is governed by the `cors` option.
- The admin token is stored in the browser `localStorage`; use "clear local admin token" on shared
  machines.

The store lives at `<DSH_HOME>/dsh-web-service/api-keys.json` (mode 0600).

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
8. **API Key settings page** — `GET /api/v1/settings/api-keys` manages third-party access keys in one
   place: multiple named keys, masked display, create / rotate / revoke, and an auth on/off switch.
   Plaintext is shown once; only hashes are persisted.

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
| **API Keys** | `GET` | `/settings/api-keys` | **API Key settings page** (HTML, public; data endpoints need the Admin Token) |
| | `GET` | `/api-keys` | List API keys (masked; never returns plaintext or hashes) |
| | `POST` | `/api-keys` | Create an API key (plaintext returned once) |
| | `PATCH` | `/api-keys/:id` | Update name / note / expiry |
| | `POST` | `/api-keys/:id/rotate` | Rotate (old key dies immediately; new plaintext returned once) |
| | `POST` | `/api-keys/:id/revoke` | Revoke (idempotent, irreversible) |
| | `DELETE` | `/api-keys/:id` | Delete the record (revoked keys only) |
| | `GET` | `/api-keys/auth` | Read auth status |
| | `PUT` | `/api-keys/auth` | Enable / disable auth (disabling requires `confirm: "disable-auth"`) |
| **Docs** | `GET` | `/docs` | Interactive API request page |
| | `GET` | `/docs/reference` | Full API reference & online debugging (Swagger UI, try-it-out) |
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
