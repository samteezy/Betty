# betty-mcp

Betty is an assistant layer that travels between agentic platforms. She gives LLM tools access to your email, calendar, tasks, and contacts — and, crucially, her memory and skills live in **your** file storage, not locked inside whichever platform you're subscribed to this month.

Point Betty at a Fastmail Files folder or a local directory and she remembers what she learns and loads the skills you write for her. Switch platforms and she comes with you.

> Betty grew out of [`better-email-mcp`](https://github.com/samteezy/better-email-mcp) and shares its codebase. That project is still maintained and still recommended — if you want email, calendar, tasks, and contacts *without* a memory layer, use it directly. Betty is the same foundation plus notes, memory, and skills.

## Who Betty is

You know Betty. She has been here longer than anyone, reading glasses on a gold chain she has had for twenty years, and she has never once raised her voice. She sits in the corner, takes the notes, and remembers the thing you mentioned in passing back in March. She is not chatty and she is not flashy. She is *reliable* — the follow-up gets done, the small thing doesn't get dropped, the file is where she said it would be. Nobody has the faintest idea when, or whether, she plans to retire.

And she's loyal — to *you*, not to the building. When you change jobs, Betty comes with you, and so does the filing cabinet: your memories and notes are yours, sitting in your own storage, not the property of whichever agentic platform you were subscribed to at the time. Switch tools and she's already at the next desk, glasses on, knowing exactly where everything is.

**Your agent is not Betty.** Betty is who your agent works with. Claude does the talking; Betty keeps the file, chases the follow-up, and hands over twenty years of institutional memory when it's asked for. She's the colleague who has been here through three reorgs and knows where everything is — not a costume the model puts on.

## Why Betty?

- **Virtually zero dependencies.** The only runtime dependency is the MCP SDK itself. IMAP, SMTP, CalDAV, CardDAV, and WebDAV clients are implemented from scratch using Node built-ins — no third-party libraries in your supply chain.
- **Works with any provider.** Supports IMAP/SMTP (Gmail, Outlook, self-hosted, etc.), Fastmail JMAP (email + contacts), and any CalDAV/CardDAV server (Fastmail, iCloud, Nextcloud, Radicale, etc.) for calendars, tasks, and contacts. Notes and skills work over WebDAV or a plain local folder.
- **You own the storage.** Memory is plain markdown in a directory you control — readable in Obsidian, syncable, greppable, and deletable without asking anyone's permission. No proprietary memory store, no vendor lock-in.
- **You control what the LLM can do.** Disable any tool with a single environment variable — enforce read-only access, hide search, or strip it down to just what you need. Less tool clutter means better LLM performance. Betty's writes are confined to a directory you nominate, enforced in code.
- **Token-efficient.** List and search responses return only essential fields by default. Pass `verbose: true` for full details when needed. Skills load by name on demand rather than filling the context window up front.

## Memory

Betty's memory is a folder of markdown files. No database, no embedding index, no proprietary store — the entire mechanism is files you can open, grep, edit, and delete.

### Where it lives, and what it isn't

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

Memory is a strict subset of your notes, and everything Betty writes lands in one folder you can inspect, back up, or delete wholesale.

Three of those four are memory in the ordinary sense. The fourth, `desk/`, is bookkeeping — a queue, a backlog, a change log — and it is deliberately **excluded from search**. Betty's paperwork should not compete with what she actually knows when you ask her a question. `trash/` is excluded for the same reason: retired means gone from recall, not deleted.

That containment has a consequence worth stating plainly: **an index Betty maintains is an index of memories, not of your notes.** She can only write inside `betty/`, so the `index.md` she curates covers what she has learned and written down — the people, projects, and preferences in `memory/`. Your own notes stay uncatalogued unless you index them yourself. Betty *searches* the whole vault; she only *catalogues* her own corner of it.

### Recall

`search_notes` works outward from the strongest signal. It reads the markdown links inside any `index.md` you've curated, then matches filenames straight off the directory listing — neither of which costs a file read. Pass `content: true` to also read bodies and frontmatter (one read per file, capped at 100). Every result carries `matchedOn` — `index`, `frontmatter`, `path`, or `body` — and results are ranked in that order, so the model can tell a curated hit from a coincidental filename match. `get_note` then reads the one that looked right, returning the body plus the list of headings available to `replace_memory_section`.

`desk/` and `trash/` are skipped. Pass `dir` pointing into either one to search it deliberately — so nothing is unreachable, it just isn't in the way.

When a search hits its bounds it says so — `truncated: true` with a reason — rather than returning a short list that looks complete.

### Storing

Three tools, all confined to `MEMORY_ROOT`, `DESK_ROOT`, and `TRASH_ROOT`:

- **`append_memory`** adds content to a memory, creating it with OKF frontmatter if it doesn't exist. Pass `heading` to append under an existing section instead of at the end of the file.
- **`replace_memory_section`** rewrites the content under a heading that already exists, leaving the rest of the file untouched. If the heading doesn't exist, the error lists the ones that do, so the model can retry instead of guessing.
- **`move_memory`** moves or renames a memory. It refuses to overwrite, so the destination must not already exist.

Skills have their own two tools — see [Betty can write skills too](#betty-can-write-skills-too). A memory tool cannot write a skill and a skill tool cannot write a memory, which is what keeps `DISABLED_TOOLS` able to freeze one without the other.

That is the entire write surface — see [read-wide, write-narrow](#read-wide-write-narrow) for why there is nothing else. In particular there is **no delete**. Retiring a memory means `move_memory` into `trash/`, where it stops appearing in searches but stays readable by path. Nothing Betty wrote is ever destroyed.

A write anywhere outside those directories is refused before it reaches storage, and the refusal names the roots so the model can retarget rather than give up.

### What a memory file looks like

Memory files follow Google's [Open Knowledge Format](https://github.com/google/open-knowledge-format) (OKF v0.1): markdown with YAML frontmatter, one concept per file, interlinked with plain markdown links.

Ask Betty to remember how a colleague likes to work, and she writes:

```markdown
---
type: person
title: Priya Raman
description: Engineering manager on the billing team
timestamp: 2026-08-17T14:22:09Z
source: betty
---

# Priya Raman

Prefers async updates over standups. Owns the billing migration.
```

OKF requires only `type`, but Google's own reference parser expects all four of `type`, `title`, `description`, and `timestamp`, so Betty always writes all four — `type` defaults to `note`, and `description` falls back to the title. The `source: betty` key is Betty's own addition: everything she wrote stays greppable, and deletable in bulk, without touching anything you wrote yourself.

Frontmatter keys are written in a fixed order — the four required ones, then the rest alphabetically — so a note she rewrites produces a clean diff instead of a reshuffled block.

### index.md — the part worth curating

`search_notes` reads `index.md` files before anything else and follows the markdown links inside them. Link *text* is matched as well as link target, so an index is how you tell Betty what a note is about without her having to read it:

```markdown
# People

- [Priya Raman — billing, async-first](people/priya-raman.md)
- [Dan Whitfield — vendor contact at Acme](people/dan-whitfield.md)
```

A hit here outranks every other kind. One curated index turns a folder Betty has to scan into one she can navigate.

**Nothing in Betty's code ever writes an index**, and that is what keeps the ranking honest. A top-ranked index hit always means something was filed on purpose — by you, or by the [organize-desk skill](#the-desk) on its periodic pass. If code appended a line here every time a memory was created, the index would be a running list of raw entries wearing the authority of a curated one.

Search reads **every** `index.md` under `NOTES_ROOT`, including ones you wrote for your own notes. If you want your wider vault indexed, write that index yourself; Betty will read it and rank hits from it just as highly.

### The desk

`betty/desk/` is where Betty keeps her working papers. None of it is searched.

| File | What it is | Who writes it |
|------|------------|---------------|
| `unfiled.md` | Memories not yet in the index, under an `## Unprocessed` heading | Betty, automatically |
| `backlog.md` | Things to raise with you next time | the organize-desk skill |
| `log.md` | Append-only change history | Betty, automatically |

**`unfiled.md`** gets a line each time a memory is created or moved:

```markdown
## Unprocessed

- 2026-08-17T14:22:09Z `create` [betty/memory/people/priya-raman.md](…) — Priya Raman
- 2026-08-17T14:31:44Z `move` [betty/memory/projects/betty.md](…) — moved from betty/memory/betty.md
```

That is the whole automatic half of the system. Deciding what those entries *mean* — whether a memory needs merging, re-filing, retiring, or raising with you, and where it belongs in the index — is the [organize-desk skill's](#organize-desk) job, and it runs when you or your schedule tell it to.

**`log.md`** is the permanent record, distinct from `unfiled.md` because that list gets drained and the log never does:

```markdown
- 2026-08-17T14:22:09Z `create` [betty/memory/people/priya-raman.md](betty/memory/people/priya-raman.md)
- 2026-08-17T14:31:44Z `append` [betty/memory/projects/betty.md](betty/memory/projects/betty.md) — Open questions
- 2026-08-17T15:02:11Z `move` [betty/trash/old-note.md](betty/trash/old-note.md) — from betty/memory/old-note.md
```

Set `MEMORY_LOG=false` or `MEMORY_UNFILED=false` to turn either off. Both are deliberately best-effort: the memory write has already succeeded by that point, so a failure comes back as a `warning` on a successful write rather than as a failed one.

Nothing is hidden in a dot-prefixed folder. Obsidian ignores dot paths entirely, and memory you can't see isn't memory you can trust — which is also why trash is a visible folder rather than a delete.

### Telling Betty when to remember

Betty exposes the tools; she doesn't inject instructions into your host's prompt. Deciding *when* to search and *when* to write is the host model's call, and left to their own devices most models under-use both.

By default [the wake gate](#the-wake-gate) handles this for you: `wake_betty` is the only tool a client sees until it's called, and calling it hands the model your [wake-betty](#wake-betty--the-default) skill before it can touch anything else. No client-side configuration, on any platform.

With the gate turned off (`BETTY_WAKE_GATE=false`), you need a line in your client's instructions — `CLAUDE.md`, a system prompt, a project rule — to do the same job:

> If I mention Betty, `load_skill` **wake-betty** first.

Or, if you'd rather not depend on the skill at all:

> At the start of a session, `search_notes` for anything relevant to what I'm working on. When you learn something durable about me, my projects, or the people I work with, `append_memory` it under `betty/memory/`.

### The two skills Betty ships with

Both are installed the first time she connects, and never touched again.

#### wake-betty — the default

This is what `wake_betty` hands back, and what your one-line client rule should point at if you've turned [the wake gate](#the-wake-gate) off:

> If I mention Betty, `load_skill` **wake-betty** first.

It tells the model who Betty is, that the first move is to *search before answering*, where memory lives, what is worth recording, and — importantly — what she refuses to do, so it expects the refusal instead of working around it. Keeping it in a skill rather than in your client config is the whole point: the substance lives in your storage and travels with you, and the config stays a single line on every platform — or no line at all, with the gate on.

`wake_betty` reads *your* copy of the file, not the bundled template. Edit it and you have edited Betty's boot prompt.

#### organize-desk — the maintenance pass

The other half of the memory system: the tools capture, and this decides what the captures mean.

A pass over the desk drains `unfiled.md` — for each entry, merge it into an existing memory, re-file it, retire it into `trash/`, or add it to `backlog.md` to raise with you — then rebuilds `index.md` so every memory sits under a category heading, and finishes by reporting what's in the backlog.

It is written to be run on a schedule. Point your client's daily or weekly job at it:

> `load_skill` organize-desk and follow it.

If it never runs, nothing breaks — memories still get written and searched. You simply get no index and no triage, which is exactly where Betty was before it existed.

**Both files are seeded once and never revised**, so any edits you make survive upgrades — Betty never rewrites a skill she has handed over. Delete one and it comes back on the next start; set `BETTY_SEED_SKILLS=false` if you'd rather it didn't.

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
docker compose up -d
curl localhost:8765/health   # {"status":"ok"}
```

The image serves HTTP on 8765 and the compose file publishes it to **loopback only**. Point your tunnel at `127.0.0.1:8765`; change that binding and Betty is on your LAN in the clear.

### Connecting from a phone

The token is accepted two ways, because the clients that matter here disagree about headers:

| Form | Use it when |
|------|-------------|
| `Authorization: Bearer <token>` | Your client lets you set headers — Claude Code, `mcp-remote`, most desktop clients. |
| `https://host/mcp/<token>` | Your client takes a URL and nothing else, which is the usual shape of a mobile connector UI. |

The path form puts a secret in a URL, so treat that URL as the credential it is: it lands in browser history, and it would land in an access log if anything in front of Betty keeps one. Rotate it by changing `BETTY_HTTP_TOKEN` and restarting.

### What's on the wire

Betty serves **no TLS of her own**. She binds loopback by default and expects a tunnel or reverse proxy to terminate TLS — Tailscale, Cloudflare Tunnel, Caddy, whatever you already run. Exposing the port directly means a bearer token over plaintext HTTP.

Three things she does do:

- **Nothing reaches the MCP layer unauthenticated.** The token is checked first, in constant time, and a miss is a 401 before any Betty is built.
- **Browsers are shut out unless invited.** Any request carrying an `Origin` header is refused unless that origin is in `BETTY_HTTP_ALLOWED_ORIGINS`, which is empty by default. Native MCP clients don't send one; a web page attacking a loopback bind does. `BETTY_HTTP_ALLOWED_HOSTS` does the same for the `Host` header when you want to pin the tunnel's hostname.
- **Every session gets its own Betty.** The [wake gate](#the-wake-gate) is per-connection, so a session is a connection: your phone waking her doesn't wake her on the laptop, and each session's re-arm clock runs on its own. Sessions close on DELETE, on a dropped connection, and after `BETTY_HTTP_SESSION_TIMEOUT_MINUTES` of silence — a phone that walks out of wifi never sends the DELETE.

`GET /health` answers `{"status":"ok"}` without a token, for tunnel and container health checks. It is the only unauthenticated endpoint and it says nothing about your configuration.

| Variable | Required | Description |
|----------|----------|-------------|
| `BETTY_TRANSPORT` | No | `stdio` (default) or `http`. Setting `BETTY_HTTP_PORT` implies `http`. |
| `BETTY_HTTP_TOKEN` | When serving HTTP | Shared secret, minimum 16 characters. `openssl rand -hex 32`. |
| `BETTY_HTTP_HOST` | No | Interface to bind (default `127.0.0.1`; the Docker image sets `0.0.0.0`) |
| `BETTY_HTTP_PORT` | No | Port to bind (default `8765`) |
| `BETTY_HTTP_PATH` | No | Endpoint path (default `/mcp`) |
| `BETTY_HTTP_ALLOWED_ORIGINS` | No | Comma-separated origins allowed to send an `Origin` header (default: none) |
| `BETTY_HTTP_ALLOWED_HOSTS` | No | Comma-separated `Host` values to accept (default: any) |
| `BETTY_HTTP_MAX_SESSIONS` | No | Concurrent sessions before new ones are refused (default `8`) |
| `BETTY_HTTP_SESSION_TIMEOUT_MINUTES` | No | Idle minutes before a session is closed (default `60`) |

One licensing note, since this is the case the AGPL is actually about: running Betty for yourself or your household is not distribution and asks nothing of you. Running a *modified* Betty as a service other people use means offering those users the source — see [License](#license).

## Configuration

The server is configured entirely through environment variables. The `BETTY_HTTP_*` set lives under [Remote access](#remote-access); everything else is below.

Every capability is opt-in and activates on its own trigger variable — email on `EMAIL_BACKEND` (or a credential), calendar and tasks on `CALDAV_URL`, contacts on `CARDDAV_URL`, notes, memory, and skills together on `NOTES_BACKEND`. Configure one or all of them. If *nothing* is configured the server refuses to start rather than presenting an empty toolbox.

### Backend selection

| Variable | Description | Default |
|----------|-------------|---------|
| `EMAIL_BACKEND` | `"jmap"`, `"imap"`, or `"none"` | `"jmap"` when a credential is present — see below |
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
| `CARDDAV_DEFAULT_ADDRESS_BOOK` | No | Default address book name — when set, tools scope to this book automatically |

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
| `BETTY_PROGRESSIVE_TOOLS` | No | Set `true` to keep mail, calendar, tasks, and contacts in their drawers at wake, to be opened by `open_drawer` — see [Progressive disclosure](#progressive-disclosure) (default: `false`) |
| `BETTY_WAKE_REARM_MINUTES` | No | Close the gate again after this many minutes with no tool call. `0` leaves it open for the life of the process (default: `10`) |
| `WEBDAV_URL` | When `NOTES_BACKEND=webdav` | WebDAV base URL |
| `WEBDAV_USERNAME` | When `NOTES_BACKEND=webdav` | HTTP Basic auth username |
| `WEBDAV_PASSWORD` | When `NOTES_BACKEND=webdav` | HTTP Basic auth password |

All four roots accept either a full path (`/Notes/betty/memory`) or a path relative to `NOTES_ROOT` (`betty/memory`). Either way, the server refuses to start if any falls outside `NOTES_ROOT`, or if two of them resolve to the same directory.

All four default under `betty/` so that everything Betty owns sits in one folder inside your notes rather than scattered among them. None needs setting: `NOTES_BACKEND` and `NOTES_ROOT` are enough.

> **Upgrading from 0.3.x?** The write tools were renamed — `append_note` → `append_memory` / `append_skill`, and `replace_section` → `replace_memory_section` / `replace_skill_section` — so that each name matches what it can actually write. Existing `DISABLED_TOOLS` values keep working: the old names are translated to the new ones. Update any skill or client instruction that names a write tool.
>
> The change log also moved from `<MEMORY_ROOT>/log.md` to `<DESK_ROOT>/log.md`, so it stops turning up in searches. Your existing `log.md` is left exactly where it is and a fresh one starts on the desk; move or delete the old one at your leisure.

> **Upgrading from 0.2.x?** `MEMORY_ROOT` used to default to `<NOTES_ROOT>/memory`, and skills only loaded when `SKILLS_ROOT` was set explicitly. If you relied on either default, Betty now looks in `betty/memory` and `betty/skills` instead. Either move those two directories under a new `betty/` folder, or pin the old layout by setting `MEMORY_ROOT=memory` and `SKILLS_ROOT=skills`. Configs that already set both paths explicitly are unaffected.

#### Read-wide, write-narrow

Betty can **read** anything under `NOTES_ROOT` — your whole vault, if you point her at it. She can only **write** under `MEMORY_ROOT`, `DESK_ROOT`, `TRASH_ROOT`, and `SKILLS_ROOT`. That boundary is enforced in code, before any request reaches storage, not merely described in a tool description the model is free to ignore.

There is deliberately **no whole-file write or overwrite tool, and no delete**. Betty can create a memory, append to one, replace the content under a heading that already exists, and move one. She cannot replace a file wholesale, so the worst case for a note you wrote by hand is an unwanted paragraph at the end, not a vanished document.

`move_memory` refuses a destination that already exists, at every layer down to the `Overwrite: F` header on the WebDAV request — so a move can relocate a file but never consume one. Retiring a memory means moving it into `TRASH_ROOT`, which you can inspect and empty yourself.

Every write is conditional. Betty reads a note, edits it, and writes it back with an `If-Match` on the exact version she read. If you edited that note in Obsidian in the meantime, the write fails loudly and she re-reads instead of clobbering your edit.

**That header is not enough on its own, and Fastmail is the reason.** Fastmail Files accepts a `PUT` carrying a stale `If-Match`, a syntactically invalid one, or `If-None-Match: *` against a file that already exists — all three are discarded rather than honoured. Tested against the live service. So the WebDAV backend checks the precondition itself: a `PROPFIND` before every write compares the current ETag, or confirms nothing is there yet, and refuses locally if the server wouldn't. The headers are still sent, so a server that does enforce them keeps the stronger atomic guarantee.

This costs one extra round trip per write, and it narrows the race rather than closing it — another writer can still land in the gap between the `PROPFIND` and the `PUT`. It is the difference between a guarantee that usually holds and one that never did. `MOVE` needs no such help: Fastmail honours `Overwrite: F` correctly, so a move genuinely cannot consume a file.

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

For what Betty actually does with these directories — the file format, `index.md`, the desk, and how skills load — see [Memory](#memory) and [Skills](#skills).

### The wake gate

Betty starts asleep. Her tools are registered but hidden, and a client's first `tools/list` returns exactly one:

```
wake_betty — Load Betty's instructions and bring her tools online: memory,
             skills, mail, calendar, tasks and contacts. …
```

Calling it brings her core tools online and hands back three things: a list of what just came online, grouped by capability; your own [wake-betty](#wake-betty--the-default) skill; and a closing nudge to search memory and call `list_skills` before answering.

The tool list matters more than it looks. Waking is the one moment in a session when a model's tool list is stale — the gate fires `notifications/tools/list_changed`, but until the client acts on it the model is still looking at a list holding only `wake_betty`, and a model that doesn't believe a tool exists won't call it. Naming them in the reply closes that window. `list_skills` is the other half of the same question: the tools are what Betty *can* do, the skills are what you have *taught* her to do.

Two things the gate buys:

- **Betty carries her own bootstrap.** Without the gate, the wake-betty skill only loads if you write a client-side rule for it — the one part of Betty that has to be re-done on every platform you use her from. A visible tool whose description is the trigger travels with her.
- **~104 tokens instead of ~2,062.** A full configuration's tool schemas ride in the context window of every request, whether or not Betty comes up. Asleep, she costs one small tool definition.

**It re-arms.** MCP has no concept of a conversation — the server sees one connection and then an undifferentiated stream of calls — so a gate that only opened once would stay open for the life of the process. On Claude Code that's your session; on a host that keeps one server running across chats, it's until you quit the app. `BETTY_WAKE_REARM_MINUTES` closes it again after a quiet stretch, so the next chat, or the next hour of unrelated work, starts asleep. Default 10 minutes; `0` disables it.

Recovering from a re-arm mid-conversation is deliberately cheap: the model calls `wake_betty` with `loaded: true`, which brings the tools back without re-sending instructions it already has.

**Turn it off with `BETTY_WAKE_GATE=false`** if your client doesn't act on `notifications/tools/list_changed` — waking works by telling the client the tool list changed, and a client that never refetches will see one tool forever. Claude Code and Claude Desktop both refetch. `DISABLED_TOOLS=wake_betty` turns the gate off too, since a gate with no key would strand every other tool.

The gate requires `NOTES_BACKEND`. With no memory layer configured there is no skill to wake into, so a mail-and-calendar-only server is never gated.

### Progressive disclosure

Set `BETTY_PROGRESSIVE_TOOLS=true` and waking stops revealing everything. Memory and skills come online — they are what waking is *for* — while mail, calendar, tasks, and contacts stay hidden behind one more step:

```
open_drawer — Open one of Betty's drawers to reveal the tools inside: mail,
              calendar, tasks and contacts. …
```

Her desk has drawers, and mail is in one of them. The wake reply lists what's in each **by tool name**, so the model can see that `list_events` and `search_events` exist without carrying their schemas. One call opens a drawer for the rest of the session; the gate remembers, so a later re-arm and re-wake leaves it open.

(Drawers are capabilities, not the `desk/` folder — that one is Betty's bookkeeping, tidied by [organize-desk](#organize-desk).)

That brings the awake tier to ~1,105 tokens instead of ~2,062 on a full configuration. A conversation about the user's week never pays for mail.

**It's off by default, and that's a deliberate trade.** Waking already does most of the work — a full configuration drops from ~2,062 schema tokens to ~104 asleep, and drawers save a further ~950 once awake. What they cost is a *second* `tools/list_changed` in the middle of a conversation. Whether that's worth it depends entirely on your client:

- **Clients that fetch the new tool list synchronously** get the ~950 for the price of one extra round trip. Turn it on.
- **Clients that defer tool schemas behind their own search index** — Claude Code, and anything else that hands the model a search tool instead of the definitions — should leave it off. That client is already withholding schemas, so the ~950 isn't saved; meanwhile its index typically refreshes on a turn boundary rather than on the notification, so the model spends a turn discovering that a tool it was just promised isn't callable yet. Worst case it concludes Betty can't read mail at all.

The wake gate itself is subject to the same lag — it's one list change instead of two — which is what `BETTY_WAKE_GATE=false` is for if you'd rather have no mid-conversation churn at all.

### When a credential doesn't authenticate

Every backend authenticates at startup — a JMAP session fetch, an IMAP `LOGIN`, a CalDAV `PROPFIND`. A capability that is configured but *not accepted* is taken out of service rather than taking the server down with it:

```
betty-mcp: mail is configured but did not authenticate (401 Unauthorized) —
           its tools stay hidden for this session.
```

Betty starts. Memory, skills, and anything else that authenticated work normally. The failed capability leaves nothing behind: its tools never appear, `wake_betty`'s description stops naming it, `open_drawer` will not open it, and the bundled `wake-betty` skill is seeded without mentioning it. A model cannot offer the user something Betty has no working credential for.

Two boundaries worth knowing:

- **Notes are still fatal.** A notes root that can't be reached is a configuration error you have to fix, and Betty with no memory isn't a smaller Betty.
- **Degrading needs the gate.** With `BETTY_WAKE_GATE=false` the tools are plainly registered and there are no handles to take back, so a failed connect exits the process — exactly as it did before, and as `better-email-mcp` still does.
- **JMAP contacts fall with mail**, since they ride on the same session; CalDAV calendar and tasks fall together for the same reason.

### Disabling tools

Set `DISABLED_TOOLS` to a comma-separated list of tool names to prevent them from being registered:

```bash
DISABLED_TOOLS=send_message,search_messages
```

This is useful for enforcing read-only access or reducing context for the LLM. When using `CALDAV_DEFAULT_CALENDAR` or `CARDDAV_DEFAULT_ADDRESS_BOOK`, you can also disable `list_calendars` or `list_address_books` since the LLM no longer needs to discover them.

### Attachment downloads

The `get_attachment` tool supports a `saveTo` parameter that writes the file to disk instead of returning base64 content. For security, `saveTo` paths are restricted to a base directory:

```bash
ATTACHMENT_DIR=~/Downloads  # default; set to change the allowed directory
```

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

### Waking (WebDAV or local)

| Tool | Description |
|------|-------------|
| `wake_betty` | Bring Betty's core tools online, then hand back the names of the tools just revealed, the names of the ones held back, and the `wake-betty` skill. Pass `loaded: true` to re-enable them without re-sending instructions the model already has |
| `open_drawer` | Open one of Betty's drawers to reveal its tools — `mail`, `calendar`, `tasks`, or `contacts`. Only registered while Betty is awake, and only when a drawer is actually being held shut |

The only tool visible until it's called. Registered whenever `NOTES_BACKEND` is set, unless `BETTY_WAKE_GATE=false` — see [The wake gate](#the-wake-gate).

### Email

| Tool | Description |
|------|-------------|
| `list_folders` | List all email folders/mailboxes |
| `list_messages` | List recent messages with optional folder, limit, and offset |
| `get_message` | Get a single message by ID, including full body and attachment metadata |
| `search_messages` | Search messages by text query |
| `get_attachment` | Download an email attachment by part ID. Returns base64 content, or saves to disk if `saveTo` path is provided |
| `send_message` | Send an email (JMAP, or IMAP with SMTP configured) |

### Calendar (CalDAV)

| Tool | Description |
|------|-------------|
| `list_calendars` | List all calendars |
| `list_events` | List calendar events with optional calendar filter and limit |
| `get_event` | Get a single event by href, including full details |
| `search_events` | Search events by text query (matches title, description, location) |

### Tasks (CalDAV VTODO)

| Tool | Description |
|------|-------------|
| `list_tasks` | List tasks (excludes completed/cancelled by default; pass `includeCompleted: true` to show all) |
| `get_task` | Get a single task by href, including full details |
| `search_tasks` | Search tasks by text query (matches title, description, categories) |
| `create_task` | Create a new task with title, due date, priority, categories |
| `update_task` | Update an existing task's fields |
| `complete_task` | Mark a task as completed |

### Contacts (CardDAV)

| Tool | Description |
|------|-------------|
| `list_address_books` | List all address books |
| `list_contacts` | List contacts with optional address book filter and limit |
| `get_contact` | Get a single contact by href, including full details |
| `search_contacts` | Search contacts by name, email, phone, or organization |

### Notes and memory (WebDAV or local)

| Tool | Description |
|------|-------------|
| `search_notes` | Search notes. Reads `index.md` files and matches filenames by default; pass `content: true` to also search bodies and frontmatter. Skips the desk and trash unless `dir` points into them |
| `get_note` | Read a note anywhere under `NOTES_ROOT`, returning its body, title, type, and the headings available to `replace_memory_section` |
| `append_memory` | Append to a memory, creating it with OKF frontmatter if missing. Optionally appends under a named heading |
| `replace_memory_section` | Replace the content under an existing heading, leaving the rest of the file untouched |
| `move_memory` | Move or rename a memory. Refuses to overwrite; retire a memory by moving it into `TRASH_ROOT` |

Reads may span `NOTES_ROOT`; the three write tools are restricted to `MEMORY_ROOT`, `DESK_ROOT`, and `TRASH_ROOT`. There is no whole-file write tool and no delete. See [Memory](#memory) for how these fit together.

### Skills (WebDAV or local)

| Tool | Description |
|------|-------------|
| `list_skills` | List available skills by name and description only |
| `load_skill` | Load the full instructions for one skill by name |
| `append_skill` | Append instructions to a skill by name, creating it if missing |
| `replace_skill_section` | Replace the content under an existing heading in a skill |

The two write tools are restricted to `SKILLS_ROOT`, which no memory tool can reach — so `DISABLED_TOOLS` can freeze skills and memory independently.

## Token efficiency

All tool responses use compact JSON (no pretty-printing). List and search tools (`list_messages`, `search_messages`, `list_events`, `search_events`, `list_tasks`, `search_tasks`, `list_contacts`, `search_contacts`, `search_notes`) return a lean field set by default — just enough to identify and triage each item. Pass `verbose: true` to get the full response with all fields.

Skills go further: `list_skills` returns only each skill's name and description, and the full instructions load on demand via `load_skill`. A dozen skills cost a few hundred tokens to know about, not a few thousand.

If you never dictate skills or never reorganize memory, `DISABLED_TOOLS=append_skill,replace_skill_section,move_memory` takes about 300 tokens back off every request.

**Tool definition token cost** (schema tokens consumed per request, estimated at ~3.5 chars/token):

Tools are only registered when the matching backend is configured. Combine rows to estimate your setup:

| Protocol | Tools | Est. tokens |
|----------|-------|-------------|
| IMAP | 6 | ~373 |
| JMAP (`EMAIL_FORMAT=html` adds `htmlBody`) | 6 | ~380 |
| CalDAV — calendar | 4 | ~192 |
| CalDAV — tasks | 6 | ~383 |
| CardDAV | 4 | ~206 |
| Notes & memory | 5 | ~587 |
| Skills | 4 | ~316 |
| `open_drawer` (awake, a drawer to open) | 1 | ~98 |
| **Asleep** (any of the above, gate on) | **1** | **~104** |

Notes and skills register together on `NOTES_BACKEND`, so those two rows come as a pair unless you trim them with `DISABLED_TOOLS`.

**Example totals:** IMAP only ~373 · Notes + Skills only ~903 · IMAP + CalDAV + Tasks ~947 · No email (CalDAV + Tasks + Notes + Skills) ~1,477 · Everything (JMAP + CalDAV + Tasks + CardDAV + Notes + Skills) ~2,062

Those are the *fully open* numbers — every capability revealed at once. What a full configuration actually costs depends on the gate:

| Tier | What the model can see | Est. tokens |
|------|------------------------|-------------|
| Asleep | `wake_betty` | ~104 |
| Awake | all 29 tools | ~2,062 |

Most requests in a session are made asleep, so ~104 is the number that gets paid most often, and it drops back there after `BETTY_WAKE_REARM_MINUTES` of quiet.

With `BETTY_PROGRESSIVE_TOOLS=true` a middle tier appears — memory, skills, `open_drawer`, and the *names* of what is in each drawer, at ~1,105 — and mail schemas arrive only in the conversations that are about mail. Whether that's a saving or a stall depends on your client; see [Progressive disclosure](#progressive-disclosure).

Run `npm run count-tokens` for a per-tool breakdown. Use `DISABLED_TOOLS` to trim tools you don't need.

**Default fields by tool type:**

| Tool type | Default fields | Additional with `verbose: true` |
|-----------|---------------|--------------------------------|
| Email list/search | `id`, `from`, `subject`, `date`, `snippet` | `to`, `cc`, `isRead`, `folder` |
| Calendar list/search | `id`, `href`, `title`, `start`, `end`, `location`, `allDay` | `description`, `organizer`, `attendees`, `status`, `recurrence`, `calendar` |
| Task list/search | `id`, `href`, `title`, `status`, `due`, `priority` | `description`, `categories`, `start`, `completed`, `percentComplete`, `recurrence`, `calendar` |
| Contact list/search | `id`, `href`, `name`, `emails`, `phones` | `organization`, `title`, `address`, `notes`, `addressBook` |
| Note search | `path`, `matchedOn`, `title`, `snippet` | `description` |
| `get_note` | `path`, `title`, `type`, `headings`, `body` | full `frontmatter`, `etag`, `hasFrontmatter` |
| `list_skills` | `name`, `description` | `path`, `invalid` |

The `folder`, `calendar`, and `addressBook` fields are automatically included in lean responses when no filter is applied (listing across all), and omitted when filtering by a specific one (since it's redundant).

## License

[GNU AGPL v3](LICENSE). If you run a modified Betty as a network service, the AGPL requires you to offer that service's users the corresponding source.
