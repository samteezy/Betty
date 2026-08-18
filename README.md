# Betty

Betty is an assistant layer that travels between agentic platforms. She gives LLM tools access to your email, calendar, tasks, and contacts — and, crucially, her memory and skills live in **your** file storage, not locked inside whichever platform you're subscribed to this month.

Point Betty at an existing local directory or WebDAV folder with your notes (for example, if you're already an Obsidian user) and she remembers what she learns and loads the skills you write for her. Switch platforms and she comes with you. Essentially, she lives in your notes.

**Betty is not an agent.** Betty is a list of skills, tools, and instructions that the agent can use, but she's not an AI herself. This means she can live anywhere with minimal processing power and doesn't carry any separate costs of her own.

By defining her as an independent entity, rather than building her in the agent you're using, the LLM you're working with can understand that Betty is separate and only invoked when needed.

> Betty grew out of [`better-email-mcp`](https://github.com/samteezy/better-email-mcp) and shares its codebase. That project is still maintained and still recommended — if you want email, calendar, tasks, and contacts *without* a memory layer, use it directly. Betty is the same foundation plus notes, memory, and skills.


## Why Betty?

- **Virtually zero dependencies.** The only runtime dependency is the MCP SDK itself. IMAP, SMTP, CalDAV, CardDAV, and WebDAV clients are implemented from scratch using Node built-ins — no third-party libraries in your supply chain.
- **Works with any provider.** Supports IMAP/SMTP (Gmail, Outlook, self-hosted, etc.), Fastmail JMAP (email + contacts), and any CalDAV/CardDAV server (Fastmail, iCloud, Nextcloud, Radicale, etc.) for calendars, tasks, and contacts. Notes and skills work over WebDAV or a plain local folder.
- **You own the storage.** Memory is plain markdown in a directory you control — readable in Obsidian, syncable, greppable, and deletable without asking anyone's permission. No proprietary memory store, no vendor lock-in.
- **You control what the LLM can do.** Disable any tool with a single environment variable — enforce read-only access, hide search, or strip it down to just what you need. Less tool clutter means better LLM performance. Betty's writes are confined to a directory you nominate, enforced in code.
- **Token-efficient.** List and search responses return only essential fields by default. Pass `verbose: true` for full details when needed. Skills load by name on demand rather than filling the context window up front.

## Memory

Betty's memory is a folder of markdown files. No database, no embedding index, no proprietary store — the entire mechanism is files you can open, grep, edit, and delete.

Memory is not the same thing as your notes. `NOTES_ROOT` is everything Betty can **read** — point it at your whole vault if you like. Inside it, `betty/` is the only part she owns:

```
Notes/                          ← NOTES_ROOT — all of it readable
  projects/                     ← yours
  daily/                        ← yours
  betty/
    memory/                     ← MEMORY_ROOT — writable, searched
      index.md
      people/priya-raman.md
    desk/                       ← DESK_ROOT — writable, never searched
      unfiled.md
      backlog.md
      log.md
    trash/                      ← TRASH_ROOT — writable, never searched
    skills/                     ← SKILLS_ROOT — writable
      wake-betty/SKILL.md         ← shipped
      organize-desk/SKILL.md      ← shipped
      meeting-prep/SKILL.md       ← yours
```

Memory is a strict subset of your notes, and everything Betty writes lands in one folder you can inspect, back up, or delete wholesale. Files follow Google's [Open Knowledge Format](https://github.com/google/open-knowledge-format) (OKF v0.1) — markdown with YAML frontmatter, one concept per file.

Reads may span the whole vault; writes are confined to `betty/`, [enforced in code](#read-wide-write-narrow). There is no whole-file overwrite and no delete: retiring a memory means moving it into `trash/`, which drops out of search but stays readable.

**→ [Memory, in full](docs/memory.md)** — how recall ranks results, the OKF format, `index.md` and who writes it, the desk, and the two skills Betty ships with.

## Skills

A skill is a folder containing a `SKILL.md`: frontmatter with `name` and `description`, then markdown instructions. It's the standard format, and unknown frontmatter keys are ignored rather than rejected, so skills written for other tools generally load unchanged.

```
betty/skills/
  meeting-prep/
    SKILL.md
  weekly-review/
    SKILL.md
```

One level deep, a folder per skill. The `SKILL.md` itself is just instructions you'd otherwise repeat every session:

```markdown
---
name: meeting-prep
description: Brief me before a meeting — who is coming, what we agreed last time, what is still open. Use when I ask to prep for or get ready for a meeting.
---

# Meeting prep

1. `list_events` for the next 24 hours.
2. For each attendee, `search_notes` their name, then `get_note` anything under `betty/memory/people/`.
3. Check `betty/desk/backlog.md` for anything I owe them.
4. One short paragraph per meeting: who, what we agreed last time, what is open. Nothing else.
```

The `description` is the part that earns its keep. `list_skills` returns only names and descriptions, so the description is all the model has when deciding whether a skill is worth loading — write it to say *when to use this*, not merely what it is. `load_skill` then returns the full instructions, matched on the skill's `name` or its folder name, case-insensitively.

Both `name` and `description` are required. A folder whose `SKILL.md` is missing either one is skipped and counted in `skippedFolders` — pass `verbose: true` to `list_skills` to see which and why. A folder with no `SKILL.md` at all simply isn't a skill, and isn't reported as a problem.

Because skills live in your storage rather than in a platform's account settings, they travel with you: point Betty at the same folder from a different agent host and she arrives already knowing how you work.

### Betty can write skills too

A skill can be dictated rather than hand-written — "you worked that out well, save it as a skill" is a thing you can say. Two tools, scoped to `SKILLS_ROOT` and nothing else: `append_skill` to create or extend, `replace_skill_section` to rewrite a section, and no way to overwrite a file wholesale.

Both take a **skill name**, not a path — `append_skill({ name: "meeting-prep", … })` writes `<SKILLS_ROOT>/meeting-prep/SKILL.md`. `list_skills` only looks exactly one level below the skills root, so a `SKILL.md` written any deeper, or at the root itself, would look saved and never load. A name can't express either mistake.

The frontmatter is a skill manifest rather than OKF, because a skill isn't a note — `list_skills` reads `name` and `description`, and a folder with neither is skipped:

```markdown
---
name: meeting-prep
description: Brief me before a meeting — who is coming and what is still open.
source: betty
timestamp: 2026-08-17T14:22:09Z
---
```

The `name` you pass becomes both the folder and the frontmatter `name`, so `append_skill({ name: "meeting-prep" })` produces the `meeting-prep` skill. A skill with no `description` is refused rather than written, because the result would look saved and be useless — `list_skills` shows nothing else.

Because skills and memory have separate tools, `DISABLED_TOOLS` can freeze one without the other. `DISABLED_TOOLS=append_skill,replace_skill_section` leaves memory fully writable while making skills read-only; swap the names to do the reverse. Listing all four makes Betty read-only everywhere.

**Skills are instructions, not code.** Betty reads the markdown. She does not read, resolve paths into, or execute anything from a skill's `scripts/` directory — a skill loaded off file storage is untrusted input, and the only safe thing to do with it is read it as text.

## Setup

Install and run directly with npx — no clone needed:

```bash
npx betty-mcp
```

Or install globally:

```bash
npm install -g betty-mcp
```

For local development:

```bash
git clone https://github.com/samteezy/Betty.git
cd Betty
npm install
npm run build
```

## Quick start

Every capability is opt-in, **email included** — so the smallest useful Betty is just memory and skills. No mail credentials, no calendar, one app password.

Point her at a folder in Fastmail Files and add her to Claude Code:

```bash
claude mcp add betty \
  -e NOTES_BACKEND=webdav \
  -e WEBDAV_URL=https://myfiles.fastmail.com \
  -e WEBDAV_USERNAME=you@fastmail.com \
  -e WEBDAV_PASSWORD=your-files-app-password \
  -e NOTES_ROOT=/you@fastmail.com/Notes \
  -- npx betty-mcp
```

Or, for Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "betty": {
      "command": "npx",
      "args": ["betty-mcp"],
      "env": {
        "NOTES_BACKEND": "webdav",
        "WEBDAV_URL": "https://myfiles.fastmail.com",
        "WEBDAV_USERNAME": "you@fastmail.com",
        "WEBDAV_PASSWORD": "your-files-app-password",
        "NOTES_ROOT": "/you@fastmail.com/Notes"
      }
    }
  }
}
```

Create the Files app password under Fastmail **Settings > Privacy & Security > App passwords**, scoped to **Files (WebDAV)**. It is a different credential from the JMAP API token used for email — you don't need that one here.

`NOTES_ROOT` must already exist on the server. `betty/memory/` and `betty/skills/` beneath it are the defaults and are created on first write — set `MEMORY_ROOT` or `SKILLS_ROOT` only if you want them somewhere else.

### Prefer a local folder?

Swap the WebDAV variables for a path and nothing else changes — no credentials at all:

```json
{
  "mcpServers": {
    "betty": {
      "command": "npx",
      "args": ["betty-mcp"],
      "env": {
        "NOTES_BACKEND": "local",
        "NOTES_ROOT": "/Users/you/Notes"
      }
    }
  }
}
```

Useful when your notes are already synced by something else — Dropbox, iCloud Drive, Syncthing, a git repo — or when you just want to try Betty before wiring up storage.

From there, add email with `JMAP_TOKEN` (or the `IMAP_*` set), calendars with `CALDAV_URL`, and contacts with `CARDDAV_URL`. See [Configuration](#configuration) for the full reference and [Usage with MCP clients](#usage-with-mcp-clients) for fuller examples.

## Remote access

Everything above launches Betty as a subprocess over stdio, which means she runs wherever your client runs. That covers the laptop and nothing else. Set `BETTY_TRANSPORT=http` and she serves [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) instead — run her on a machine at home, put a tunnel in front, and the same memory and skills are there from your phone.

```bash
BETTY_TRANSPORT=http \
BETTY_HTTP_TOKEN=$(openssl rand -hex 32) \
NOTES_BACKEND=local NOTES_ROOT=/home/you/Notes \
  npx betty-mcp
```

```
betty-mcp: listening on http://127.0.0.1:8765/mcp (health: http://127.0.0.1:8765/health)
```

Stdio is still the default and is unchanged — nothing about an existing config behaves differently.

### With Docker

There's a [`Dockerfile`](Dockerfile) and a [`docker-compose.yml`](docker-compose.yml) in the repo. The compose file defaults to the smallest useful Betty (local notes, no credentials) and has every other capability sitting commented out.

```bash
git clone https://github.com/samteezy/Betty.git && cd Betty
echo "BETTY_HTTP_TOKEN=$(openssl rand -hex 32)" >> .env
mkdir -p notes          # do this yourself — see below
docker compose up -d
curl localhost:8765/health   # {"status":"ok"}
```

The image serves HTTP on 8765 and the compose file publishes it to **loopback only**. Point your tunnel at `127.0.0.1:8765`; change that binding and Betty is on your LAN in the clear.

**Create the notes directory before the first `up`.** The container runs as the unprivileged `node` user (uid 1000), but a bind mount that Docker has to create for you is created as root — and then Betty cannot write a thing. She starts anyway, answers `/health`, and wakes normally, which is what makes this one confusing: what you get is a Betty with no skills, `list_skills` returning `{"skills":[]}`, and every write failing with `EACCES: permission denied, mkdir '/notes/betty'`. Seeding failures only warn, so the sign of it is in `docker compose logs`:

```
betty-mcp: could not install the wake-betty skill at betty/skills/wake-betty/SKILL.md: EACCES: permission denied, mkdir '/notes/betty'
```

`mkdir -p notes` as yourself avoids it on any single-user Linux box, where you are already uid 1000. If you aren't — or you're pointing `BETTY_NOTES_DIR` at an existing directory owned by someone else — run Betty as that owner instead by uncommenting the `user:` line in `docker-compose.yml`:

```yaml
user: "${BETTY_UID:-1000}:${BETTY_GID:-1000}"
```

```bash
echo "BETTY_UID=$(id -u)" >> .env && echo "BETTY_GID=$(id -g)" >> .env
```

One more thing worth knowing before you go looking: **the directory stays empty until a client connects.** Bundled skills are seeded per session, not at startup, so a freshly started Betty with nothing pointed at her has an empty `notes/`. That's correct, not broken.

### Connecting from a phone

First give her a public address. Betty terminates no TLS herself, so this is the tunnel's job — whichever you already run:

```bash
tailscale funnel 8765                          # https://<machine>.<tailnet>.ts.net
cloudflared tunnel --url http://localhost:8765 # https://<random>.trycloudflare.com
```

Then check it from outside: `curl https://your-host/health` should answer `{"status":"ok"}`. If that works and the MCP endpoint doesn't, the problem is the token, not the tunnel.

The token is accepted two ways, because the clients that matter here disagree about headers:

| Form | Use it when |
|------|-------------|
| `Authorization: Bearer <token>` | Your client lets you set headers — Claude Code, `mcp-remote`, most desktop clients. |
| `https://host/mcp/<token>` | Your client takes a URL and nothing else, which is the usual shape of a mobile connector UI. |

The path form puts a secret in a URL, so treat that URL as the credential it is: it lands in browser history, and it would land in an access log if anything in front of Betty keeps one. Rotate it by changing `BETTY_HTTP_TOKEN` and restarting.

In a client that takes headers, the whole config is a URL and one header:

```json
{
  "mcpServers": {
    "betty": {
      "type": "http",
      "url": "https://betty.example.ts.net/mcp",
      "headers": { "Authorization": "Bearer your-token" }
    }
  }
}
```

Claude Code will write that for you:

```bash
claude mcp add --transport http betty https://betty.example.ts.net/mcp \
  --header "Authorization: Bearer your-token"
```

In a client that takes only a URL — the mobile case this exists for — paste the path form and leave everything else alone:

```
https://betty.example.ts.net/mcp/your-token
```

Either way the first thing you should see is a single tool, `wake_betty`. That's the [wake gate](#the-wake-gate), not a broken connection: everything else arrives when you call it.

### When it doesn't connect

| What you get | What it means |
|--------------|---------------|
| `401 Unauthorized` | No token, or the wrong one. Check for a stray newline or quote — `BETTY_HTTP_TOKEN=$(openssl rand -hex 32)` in a `.env` needs no quotes around it. |
| `403 Origin not allowed` | The request carried an `Origin` header, so it came from a browser. Add that origin to `BETTY_HTTP_ALLOWED_ORIGINS`. Native clients never hit this. |
| `403 Host not allowed` | `BETTY_HTTP_ALLOWED_HOSTS` is set and doesn't list the hostname your tunnel answers on. |
| Container stuck `unhealthy`, but Betty answers fine through the tunnel | Same variable. The image's health check requests `/health` on `127.0.0.1`, and the `Host` check runs on every route — add `127.0.0.1:<port>` to the list. |
| `404 Unknown or expired session — reinitialize` | The session was closed by a DELETE, a dropped connection, or `BETTY_HTTP_SESSION_TIMEOUT_MINUTES` of silence. The client should reinitialize; most do it for you. |
| `503 Too many open sessions` | `BETTY_HTTP_MAX_SESSIONS` (default 8) is reached. Usually stale sessions from clients that dropped without a DELETE — they clear on the idle sweep, or raise the limit. |
| Startup exits immediately | Betty refuses to serve without a token, and refuses one under 16 characters. The error says which. |
| Only `wake_betty`, forever | The client isn't acting on `tools/list_changed`. Call `wake_betty` and let the client refresh; see [The wake gate](#the-wake-gate). |
| `EACCES` on every write | The notes directory isn't writable by the user Betty runs as — see [With Docker](#with-docker). |

### What's on the wire

Betty serves **no TLS of her own**. She binds loopback by default and expects a tunnel or reverse proxy to terminate TLS — Tailscale, Cloudflare Tunnel, Caddy, whatever you already run. Exposing the port directly means a bearer token over plaintext HTTP.

Three things she does do:

- **Nothing reaches the MCP layer unauthenticated.** The token is checked first, in constant time, and a miss is a 401 before any Betty is built.
- **Browsers are shut out unless invited.** Any request carrying an `Origin` header is refused unless that origin is in `BETTY_HTTP_ALLOWED_ORIGINS`, which is empty by default. Native MCP clients don't send one; a web page attacking a loopback bind does. `BETTY_HTTP_ALLOWED_HOSTS` does the same for the `Host` header when you want to pin the tunnel's hostname — note it is checked on every route, `/health` included.
- **Every session gets its own Betty.** The [wake gate](#the-wake-gate) is per-connection, so a session is a connection: your phone waking her doesn't wake her on the laptop, and each session's re-arm clock runs on its own. Sessions close on DELETE, on a dropped connection, and after `BETTY_HTTP_SESSION_TIMEOUT_MINUTES` of silence — a phone that walks out of wifi never sends the DELETE.

`GET /health` (and `HEAD`) answers `{"status":"ok"}` without a token, for tunnel and container health checks. It is the only route that serves content without one, and it says nothing about your configuration. A CORS preflight `OPTIONS` is also answered before the token is checked, but only for an origin that already passed the allow-list, so it discloses nothing either way.

| Variable | Required | Description |
|----------|----------|-------------|
| `BETTY_TRANSPORT` | No | `stdio` (default) or `http`. Setting `BETTY_HTTP_PORT` implies `http`. |
| `BETTY_HTTP_TOKEN` | When serving HTTP | Shared secret, minimum 16 characters. `openssl rand -hex 32`. |
| `BETTY_HTTP_HOST` | No | Interface to bind (default `127.0.0.1`; the Docker image sets `0.0.0.0`) |
| `BETTY_HTTP_PORT` | No | Port to bind (default `8765`) |
| `BETTY_HTTP_PATH` | No | Endpoint path (default `/mcp`) |
| `BETTY_HTTP_ALLOWED_ORIGINS` | No | Comma-separated origins allowed to send an `Origin` header (default: none) |
| `BETTY_HTTP_ALLOWED_HOSTS` | No | Comma-separated `Host` values to accept (default: any). Applies to `/health` too — include `127.0.0.1:<port>` or the container's own health check fails |
| `BETTY_HTTP_MAX_SESSIONS` | No | Concurrent sessions before new ones are refused (default `8`) |
| `BETTY_HTTP_SESSION_TIMEOUT_MINUTES` | No | Idle minutes before a session is closed (default `60`) |

One licensing note, since this is the case the AGPL is actually about: running Betty for yourself or your household is not distribution and asks nothing of you. Running a *modified* Betty as a service other people use means offering those users the source — see [License](#license).

## Configuration

The server is configured entirely through environment variables. The `BETTY_HTTP_*` set lives under [Remote access](#remote-access); everything else is below.

Every capability is opt-in and activates on its own trigger variable — email on `EMAIL_BACKEND` (or a credential), calendar and tasks on `CALDAV_URL`, contacts on `CARDDAV_URL`, notes, memory, and skills together on `NOTES_BACKEND`. Configure one or all of them. If *nothing* is configured the server refuses to start rather than presenting an empty toolbox.

### Backend selection

| Variable | Description | Default |
|----------|-------------|---------|
| `EMAIL_BACKEND` | `"jmap"`, `"imap"`, or `"none"` | Inferred from the credential — `"imap"` with only `IMAP_HOST`, otherwise `"jmap"` |
| `EMAIL_FORMAT` | `"plain"` or `"html"` | `"plain"` |

**Email is optional.** It activates when `EMAIL_BACKEND` is set, or when `JMAP_TOKEN` or `IMAP_HOST` is present — so setting just `JMAP_TOKEN` selects JMAP, as it always has. With no email variables at all, the email tools are simply not registered and Betty runs as a pure memory-and-skills layer. `EMAIL_BACKEND=none` disables email even when a token is present.

Naming a backend without its credentials is still an error, not a request to run without email: `EMAIL_BACKEND=jmap` with no `JMAP_TOKEN` fails at startup.

When set to `html`, the `send_message` tool requires an `htmlBody` field in addition to `textBody`, and messages are sent as multipart with both plain text and HTML. When set to `plain` (the default), only `textBody` is exposed — the LLM cannot generate HTML email.

### JMAP (Fastmail)

| Variable | Required | Description |
|----------|----------|-------------|
| `JMAP_TOKEN` | Yes, for JMAP | Fastmail API token. Also selects the JMAP backend on its own. |
| `JMAP_SESSION_URL` | No | JMAP session URL (default: `https://api.fastmail.com/.well-known/jmap`) |

To get a token, go to Fastmail **Settings > Privacy & Security > API tokens** and create a token with the email scopes you need.

### IMAP

| Variable | Required | Description |
|----------|----------|-------------|
| `IMAP_HOST` | Yes, for IMAP | IMAP server hostname (e.g. `imap.gmail.com`) |
| `IMAP_USER` | Yes, for IMAP | Login username |
| `IMAP_PASSWORD` | Yes, for IMAP | Login password or app-specific password |
| `IMAP_PORT` | No | Server port (default: `993`) |
| `IMAP_TLS` | No | Use TLS (default: `true`) |

### SMTP (sending from IMAP)

To enable sending with the IMAP backend, configure an SMTP server:

| Variable | Required | Description |
|----------|----------|-------------|
| `SMTP_HOST` | No | SMTP server hostname (e.g. `smtp.gmail.com`). Enables sending. |
| `SMTP_PORT` | No | Server port (default: `587`). Use `465` for implicit TLS. |
| `SMTP_USER` | When `SMTP_HOST` set | SMTP login username |
| `SMTP_PASSWORD` | When `SMTP_HOST` set | SMTP login password |
| `SMTP_TLS` | No | Enable TLS (default: `true`). Port 465 uses implicit TLS; port 587 uses STARTTLS. |
| `SMTP_FROM` | No | Sender address (defaults to `SMTP_USER`) |

If `SMTP_HOST` is not set, the IMAP backend is read-only and the `send_message` tool is not registered.

### CalDAV (calendar)

Calendar and task tools activate when `CALDAV_URL` is set — alongside any email backend, or with none at all. Tasks use CalDAV VTODO — supported by Fastmail, iCloud, Nextcloud, Radicale, and most CalDAV servers.

| Variable | Required | Description |
|----------|----------|-------------|
| `CALDAV_URL` | Yes | CalDAV principal or calendar-home URL |
| `CALDAV_USERNAME` | Yes | HTTP Basic auth username |
| `CALDAV_PASSWORD` | Yes | HTTP Basic auth password |
| `CALDAV_DEFAULT_CALENDAR` | No | Default calendar name — when set, tools scope to this calendar automatically |

### Contacts

When using the JMAP backend, contact tools activate automatically via JMAP Contacts (RFC 9610) — no extra configuration needed. They ride on the email backend's JMAP session, so they need JMAP email to be configured.

To use CardDAV instead — with the IMAP backend, or with no email backend at all — set `CARDDAV_URL`:

#### CardDAV (optional override)

| Variable | Required | Description |
|----------|----------|-------------|
| `CARDDAV_URL` | Yes | CardDAV principal or addressbook-home URL |
| `CARDDAV_USERNAME` | Yes | HTTP Basic auth username |
| `CARDDAV_PASSWORD` | Yes | HTTP Basic auth password |
| `CARDDAV_DEFAULT_ADDRESS_BOOK` | No | Default address book name — when set, tools scope to this book automatically. Read whether contacts come from CardDAV or JMAP, so it works with `JMAP_TOKEN` and no `CARDDAV_URL` |

### Notes, memory, and skills

This is what makes Betty an assistant rather than a mail client with extra steps. Notes tools activate when `NOTES_BACKEND` is set — alongside any email backend, or on their own with no email configured at all.

| Variable | Required | Description |
|----------|----------|-------------|
| `NOTES_BACKEND` | Yes | `"webdav"` or `"local"`. Enables notes, memory, and skills. |
| `NOTES_ROOT` | Yes | Read scope. A directory path (local) or a path on the WebDAV server. |
| `MEMORY_ROOT` | No | Write scope for memory — must be inside `NOTES_ROOT` (default: `<NOTES_ROOT>/betty/memory`) |
| `SKILLS_ROOT` | No | Skills directory, also writable (default: `<NOTES_ROOT>/betty/skills`) |
| `DESK_ROOT` | No | Bookkeeping — unfiled, backlog, log. Writable, and never searched (default: `<NOTES_ROOT>/betty/desk`) |
| `TRASH_ROOT` | No | Retired memories. Writable, and never searched (default: `<NOTES_ROOT>/betty/trash`) |
| `MEMORY_LOG` | No | Append a change-history line to `<DESK_ROOT>/log.md` (default: `true`) |
| `MEMORY_UNFILED` | No | Append a line to `<DESK_ROOT>/unfiled.md` when a memory is created or moved (default: `true`) |
| `BETTY_SEED_SKILLS` | No | Install the bundled `wake-betty` and `organize-desk` skills if they aren't already there (default: `true`) |
| `BETTY_WAKE_GATE` | No | Hide every tool behind `wake_betty` until it is called — see [The wake gate](#the-wake-gate) (default: `true`) |
| `BETTY_PROGRESSIVE_TOOLS` | No | Set `true` to keep mail, calendar, tasks, and contacts in their drawers at wake, to be opened by `open_drawer` — see [Progressive disclosure](docs/tools.md#progressive-disclosure) (default: `false`) |
| `BETTY_WAKE_REARM_MINUTES` | No | Close the gate again after this many minutes with no tool call. `0` leaves it open for the life of the process (default: `10`) |
| `WEBDAV_URL` | When `NOTES_BACKEND=webdav` | WebDAV base URL |
| `WEBDAV_USERNAME` | When `NOTES_BACKEND=webdav` | HTTP Basic auth username |
| `WEBDAV_PASSWORD` | When `NOTES_BACKEND=webdav` | HTTP Basic auth password |

These five are matched exactly and case-sensitively. `BETTY_PROGRESSIVE_TOOLS` turns on only for the literal string `true`; the other four turn off only for the literal string `false`. `True`, `TRUE`, `False`, and anything with surrounding whitespace are silently ignored and you get the default.

All four roots accept either a full path (`/Notes/betty/memory`) or a path relative to `NOTES_ROOT` (`betty/memory`). Either way, the server refuses to start if any falls outside `NOTES_ROOT`, is empty, or is `NOTES_ROOT` itself — and the four must not **overlap**, which means no nesting, not merely no duplicates. `MEMORY_ROOT=betty` alongside the default `SKILLS_ROOT=betty/skills` is two different directories and still a startup error.

All four default under `betty/` so that everything Betty owns sits in one folder inside your notes rather than scattered among them. None needs setting: `NOTES_BACKEND` and `NOTES_ROOT` are enough.

> **Upgrading from 0.3.x?** The write tools were renamed — `append_note` → `append_memory` / `append_skill`, and `replace_section` → `replace_memory_section` / `replace_skill_section` — so that each name matches what it can actually write. Existing `DISABLED_TOOLS` values keep working: the old names are translated to the new ones. Update any skill or client instruction that names a write tool.
>
> The change log also moved from `<MEMORY_ROOT>/log.md` to `<DESK_ROOT>/log.md`, so it stops turning up in searches. Your existing `log.md` is left exactly where it is and a fresh one starts on the desk; move or delete the old one at your leisure.

> **Upgrading from 0.2.x?** `MEMORY_ROOT` used to default to `<NOTES_ROOT>/memory`, and skills only loaded when `SKILLS_ROOT` was set explicitly. If you relied on either default, Betty now looks in `betty/memory` and `betty/skills` instead. Either move those two directories under a new `betty/` folder, or pin the old layout by setting `MEMORY_ROOT=memory` and `SKILLS_ROOT=skills`. Configs that already set both paths explicitly are unaffected.

#### Read-wide, write-narrow

Betty can **read** anything under `NOTES_ROOT` — your whole vault, if you point her at it. She can only **write** under `MEMORY_ROOT`, `DESK_ROOT`, `TRASH_ROOT`, and `SKILLS_ROOT`. That boundary is enforced in code, before any request reaches storage, not merely described in a tool description the model is free to ignore.

There is deliberately **no whole-file write or overwrite tool, and no delete**, and every write carries a conditional `If-Match` on the exact version Betty read — so an edit you made in Obsidian in the meantime fails the write loudly instead of being clobbered.

**→ [Read-wide, write-narrow](docs/memory.md#read-wide-write-narrow)** — the full boundary, and why the WebDAV backend enforces the precondition itself rather than trusting the server.

#### Fastmail setup

Fastmail Files uses the same app-password model as CalDAV, with a Files-scoped password:

```bash
NOTES_BACKEND=webdav
WEBDAV_URL=https://myfiles.fastmail.com
WEBDAV_USERNAME=you@fastmail.com
WEBDAV_PASSWORD=your-files-app-password
NOTES_ROOT=/you@fastmail.com/Notes
# Optional — these are the defaults:
MEMORY_ROOT=/you@fastmail.com/Notes/betty/memory
SKILLS_ROOT=/you@fastmail.com/Notes/betty/skills
```

Create the password under **Settings > Privacy & Security > App passwords**, scoped to **Files**.

#### Local folder

For a local vault — an Obsidian directory, a Syncthing folder, anything on disk:

```bash
NOTES_BACKEND=local
NOTES_ROOT=/Users/you/Notes
# Optional — these are the defaults:
MEMORY_ROOT=/Users/you/Notes/betty/memory
SKILLS_ROOT=/Users/you/Notes/betty/skills
```

`DESK_ROOT` and `TRASH_ROOT` follow the same rules and default to `betty/desk` and `betty/trash`; set them only if you want Betty's paperwork somewhere else.

For what Betty actually does with these directories — the file format, `index.md`, the desk, and the bundled skills — see [docs/memory.md](docs/memory.md); for how skills load, [Skills](#skills).

### The wake gate

Betty starts asleep. Her tools are registered but hidden, and a client's first `tools/list` returns exactly one:

```
wake_betty — Load Betty's instructions and bring her tools online: memory,
             skills, mail, calendar, tasks and contacts. …
```

Calling it brings her tools online and hands back your own [wake-betty](docs/memory.md#wake-betty--the-default) skill. Two things that buys: Betty carries her own bootstrap, instead of it living in a client-side rule you re-write on every platform — and a full configuration costs ~104 tokens per request instead of ~2,166 until she is actually wanted.

It re-arms after `BETTY_WAKE_REARM_MINUTES` of quiet (default 10), so the next chat starts asleep. Turn it off with `BETTY_WAKE_GATE=false` if your client doesn't act on `notifications/tools/list_changed`. The gate requires `NOTES_BACKEND` — with no memory layer there is no skill to wake into.

**→ [Tools](docs/tools.md)** — the wake gate in full, [progressive disclosure](docs/tools.md#progressive-disclosure) and `open_drawer`, [what happens when a credential doesn't authenticate](docs/tools.md#when-a-credential-doesnt-authenticate), and [`DISABLED_TOOLS`](docs/tools.md#disabling-tools).

### Attachment downloads

The `get_attachment` tool supports a `saveTo` parameter that writes the file to disk instead of returning base64 content. For security, `saveTo` paths are restricted to a base directory:

```bash
ATTACHMENT_DIR=/home/you/Downloads  # default is <your home>/Downloads
```

The default is computed from your home directory. Set it to an **absolute path** — a leading `~` is only expanded by a shell, and an MCP client's `env` block is not one, so `"~/Downloads"` there resolves to a literal `~` folder under the working directory.

## Usage with MCP clients

### JMAP (Fastmail) — email + contacts

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["betty-mcp"],
      "env": {
        "EMAIL_BACKEND": "jmap",
        "JMAP_TOKEN": "your-fastmail-api-token"
      }
    }
  }
}
```

Contact tools are included automatically via JMAP — no CardDAV setup needed.

### IMAP

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["betty-mcp"],
      "env": {
        "EMAIL_BACKEND": "imap",
        "IMAP_HOST": "imap.example.com",
        "IMAP_USER": "you@example.com",
        "IMAP_PASSWORD": "your-password",
        "SMTP_HOST": "smtp.example.com",
        "SMTP_USER": "you@example.com",
        "SMTP_PASSWORD": "your-password"
      }
    }
  }
}
```

### JMAP + CalDAV (Fastmail, all features)

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["betty-mcp"],
      "env": {
        "EMAIL_BACKEND": "jmap",
        "JMAP_TOKEN": "your-fastmail-api-token",
        "CALDAV_URL": "https://caldav.fastmail.com/",
        "CALDAV_USERNAME": "you@fastmail.com",
        "CALDAV_PASSWORD": "your-app-password"
      }
    }
  }
}
```

Email and contacts use JMAP (automatic), calendar uses CalDAV. To use CardDAV for contacts instead, set `CARDDAV_URL` (this overrides JMAP contacts).

### Full Betty (Fastmail — email, calendar, contacts, memory, and skills)

```json
{
  "mcpServers": {
    "betty": {
      "command": "npx",
      "args": ["betty-mcp"],
      "env": {
        "EMAIL_BACKEND": "jmap",
        "JMAP_TOKEN": "your-fastmail-api-token",
        "CALDAV_URL": "https://caldav.fastmail.com/",
        "CALDAV_USERNAME": "you@fastmail.com",
        "CALDAV_PASSWORD": "your-caldav-app-password",
        "NOTES_BACKEND": "webdav",
        "WEBDAV_URL": "https://myfiles.fastmail.com",
        "WEBDAV_USERNAME": "you@fastmail.com",
        "WEBDAV_PASSWORD": "your-files-app-password",
        "NOTES_ROOT": "/you@fastmail.com/Notes",
        "MEMORY_ROOT": "/you@fastmail.com/Notes/betty/memory",
        "SKILLS_ROOT": "/you@fastmail.com/Notes/betty/skills"
      }
    }
  }
}
```

### No email (calendar, contacts, memory, and skills)

Email is opt-in, so you can leave it out entirely and still get everything else. Nothing needs disabling — the email tools are never registered:

```json
{
  "mcpServers": {
    "betty": {
      "command": "npx",
      "args": ["betty-mcp"],
      "env": {
        "CALDAV_URL": "https://caldav.fastmail.com/",
        "CALDAV_USERNAME": "you@fastmail.com",
        "CALDAV_PASSWORD": "your-caldav-app-password",
        "CARDDAV_URL": "https://carddav.fastmail.com/",
        "CARDDAV_USERNAME": "you@fastmail.com",
        "CARDDAV_PASSWORD": "your-carddav-app-password",
        "NOTES_BACKEND": "local",
        "NOTES_ROOT": "/Users/you/Notes"
      }
    }
  }
}
```

Contacts come from CardDAV here because JMAP contacts need a JMAP email session. For memory and skills on their own, see [Quick start](#quick-start).

If you have a mail credential in your environment for other reasons and want email off regardless, set `EMAIL_BACKEND=none`.

## Tools

| Capability | Tools | Registers on |
|------------|-------|--------------|
| Waking | `wake_betty`, `open_drawer` | `NOTES_BACKEND`, unless `BETTY_WAKE_GATE=false` |
| Email | 6 — list, get, search, send, folders, attachments | `JMAP_TOKEN` or `IMAP_HOST`. On IMAP, `send_message` needs SMTP |
| Calendar | 4 — list, get, search, list calendars | `CALDAV_URL` |
| Tasks | 6 — list, get, search, create, update, complete | `CALDAV_URL` |
| Contacts | 4 — list, get, search, list address books | `CARDDAV_URL`, or JMAP email |
| Notes and memory | 5 — `search_notes`, `get_note`, `append_memory`, `replace_memory_section`, `move_memory` | `NOTES_BACKEND` |
| Skills | 4 — `list_skills`, `load_skill`, `append_skill`, `replace_skill_section` | `NOTES_BACKEND` |

A capability that isn't configured registers nothing at all, rather than registering tools that error — an unusable tool still costs context. All tool responses use compact JSON, and list and search tools return a lean field set by default; pass `verbose: true` for everything.

On a full configuration that is ~2,166 schema tokens awake and ~104 asleep, which is what most requests in a session actually pay.

**→ [Tools, in full](docs/tools.md)** — every tool with its description, the wake gate, progressive disclosure, `DISABLED_TOOLS`, and the per-tool token cost table.

## License

[GNU AGPL v3](LICENSE). If you run a modified Betty as a network service, the AGPL requires you to offer that service's users the corresponding source.
