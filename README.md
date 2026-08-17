# betty-mcp

Betty is an assistant layer that travels between agentic platforms. She gives LLM tools access to your email, calendar, tasks, and contacts — and, crucially, her memory and skills live in **your** file storage, not locked inside whichever platform you're subscribed to this month.

Point Betty at a Fastmail Files folder or a local directory and she remembers what she learns and loads the skills you write for her. Switch platforms and she comes with you.

> Betty grew out of [`better-email-mcp`](https://github.com/samteezy/better-email-mcp) and shares its codebase. That project is still maintained and still recommended — if you want email, calendar, tasks, and contacts *without* a memory layer, use it directly. Betty is the same foundation plus notes, memory, and skills.

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
    memory/                     ← MEMORY_ROOT — writable
      index.md
      log.md
      people/priya-raman.md
    skills/                     ← SKILLS_ROOT — writable
      inbox-triage/SKILL.md
```

Memory is a strict subset of your notes, and everything Betty writes lands in one folder you can inspect, back up, or delete wholesale.

That containment has a consequence worth stating plainly: **an index Betty maintains is an index of memories, not of your notes.** She can only write inside `betty/`, so the `index.md` she curates covers what she has learned and written down — the people, projects, and preferences in `memory/`. Your own notes stay uncatalogued unless you index them yourself. Betty *searches* the whole vault; she only *catalogues* her own corner of it.

### Recall

`search_notes` works outward from the strongest signal. It reads the markdown links inside any `index.md` you've curated, then matches filenames straight off the directory listing — neither of which costs a file read. Pass `content: true` to also read bodies and frontmatter (one read per file, capped at 100). Every result carries `matchedOn` — `index`, `frontmatter`, `path`, or `body` — and results are ranked in that order, so the model can tell a curated hit from a coincidental filename match. `get_note` then reads the one that looked right, returning the body plus the list of headings available to `replace_section`.

When a search hits its bounds it says so — `truncated: true` with a reason — rather than returning a short list that looks complete.

### Storing

Two tools, both confined to `MEMORY_ROOT` and `SKILLS_ROOT`:

- **`append_note`** adds content to a note, creating it with OKF frontmatter if it doesn't exist. Pass `heading` to append under an existing section instead of at the end of the file.
- **`replace_section`** rewrites the content under a heading that already exists, leaving the rest of the file untouched. If the heading doesn't exist, the error lists the ones that do, so the model can retry instead of guessing.

That is the entire write surface — see [read-wide, write-narrow](#read-wide-write-narrow) for why there is nothing else.

A write anywhere outside those two directories is refused before it reaches storage, and the refusal names both roots so the model can retarget rather than give up.

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

Search reads **every** `index.md` under `NOTES_ROOT`, including ones you wrote for your own notes — but the only one Betty can add to is `<MEMORY_ROOT>/index.md`. So her index grows with her memories, and yours stays yours. If you want your wider vault indexed, write that index yourself; she'll read it and rank hits from it just as highly.

### log.md — what she changed

Every write appends a line to `<MEMORY_ROOT>/log.md`:

```markdown
- 2026-08-17T14:22:09Z `create` [betty/memory/people/priya-raman.md](betty/memory/people/priya-raman.md)
- 2026-08-17T14:31:44Z `append` [betty/memory/projects/betty.md](betty/memory/projects/betty.md) — Open questions
- 2026-08-17T15:02:11Z `create` [betty/skills/inbox-triage/SKILL.md](betty/skills/inbox-triage/SKILL.md)
```

A chronological record of what Betty did to your notes, kept in the notes themselves. Set `MEMORY_LOG=false` to turn it off. Logging is deliberately best-effort: the note write has already succeeded by that point, so a logging failure comes back as a `warning` on a successful write rather than as a failed one.

Nothing is hidden in a dot-prefixed folder. Obsidian ignores dot paths entirely, and memory you can't see isn't memory you can trust.

### Telling Betty when to remember

Betty exposes the tools; she doesn't inject instructions into your host's prompt. Deciding *when* to search and *when* to write is the host model's call, and left to their own devices most models under-use both. A line in your client's instructions — `CLAUDE.md`, a system prompt, a project rule — is usually all it takes:

> At the start of a session, `search_notes` for anything relevant to what I'm working on. When you learn something durable about me, my projects, or the people I work with, `append_note` it under `betty/memory/`.

Better still, point that instruction at a skill (`list_skills`, then `load_skill`) so the substance lives in your storage and travels between platforms, leaving the client-side config a one-liner.

## Skills

A skill is a folder containing a `SKILL.md`: frontmatter with `name` and `description`, then markdown instructions. It's the standard format, and unknown frontmatter keys are ignored rather than rejected, so skills written for other tools generally load unchanged.

```
betty/skills/
  inbox-triage/
    SKILL.md
  weekly-review/
    SKILL.md
```

One level deep, a folder per skill. The `SKILL.md` itself is just instructions you'd otherwise repeat every session:

```markdown
---
name: inbox-triage
description: Sort the inbox into reply-now, waiting-on, and archive. Use when asked to triage, clear, or catch up on email.
---

# Inbox triage

1. `list_messages` for the last 24 hours.
2. Group into **reply now**, **waiting on someone**, and **archive**.
3. For anything from a name in `betty/memory/people/`, `get_note` it first — reply in the register that note describes.
4. Draft nothing without showing me the grouped list.
```

The `description` is the part that earns its keep. `list_skills` returns only names and descriptions, so the description is all the model has when deciding whether a skill is worth loading — write it to say *when to use this*, not merely what it is. `load_skill` then returns the full instructions, matched on the skill's `name` or its folder name, case-insensitively.

Both `name` and `description` are required. A folder whose `SKILL.md` is missing either one is skipped and counted in `skippedFolders` — pass `verbose: true` to `list_skills` to see which and why. A folder with no `SKILL.md` at all simply isn't a skill, and isn't reported as a problem.

Because skills live in your storage rather than in a platform's account settings, they travel with you: point Betty at the same folder from a different agent host and she arrives already knowing how you work.

### Betty can write skills too

`SKILLS_ROOT` is inside the write scope alongside `MEMORY_ROOT`, so a skill can be dictated rather than hand-written — "you worked that out well, save it as a skill" is a thing you can say. It goes through the same two tools as memory, with the same limits: `append_note` to create or extend, `replace_section` to rewrite a section, and no way to overwrite a file wholesale.

Creating a `SKILL.md` is the one case where `append_note` writes something other than OKF frontmatter, because a skill manifest isn't a note — `list_skills` reads `name` and `description`, and a folder with neither is skipped:

```markdown
---
name: inbox-triage
description: Sort the inbox into reply-now, waiting-on, and archive.
source: betty
timestamp: 2026-08-17T14:22:09Z
---
```

The `name` comes from the folder, so `betty/skills/inbox-triage/SKILL.md` is the `inbox-triage` skill. Two things are refused rather than written, both because the result would look saved and never load: a `SKILL.md` without a `description`, and one that isn't exactly one level under the skills root — which is as deep as `list_skills` looks.

Skill writing rides on the same two tools as memory writing, so there is no switch for one without the other: `DISABLED_TOOLS=append_note,replace_section` makes Betty read-only everywhere, and there is no setting that leaves memory writable while freezing skills.

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

## Configuration

The server is configured entirely through environment variables.

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
| `SKILLS_ROOT` | No | Skills directory, also writable — must be inside `NOTES_ROOT`, and different from `MEMORY_ROOT` (default: `<NOTES_ROOT>/betty/skills`) |
| `MEMORY_LOG` | No | Append a change-history line to `<MEMORY_ROOT>/log.md` (default: `true`) |
| `WEBDAV_URL` | When `NOTES_BACKEND=webdav` | WebDAV base URL |
| `WEBDAV_USERNAME` | When `NOTES_BACKEND=webdav` | HTTP Basic auth username |
| `WEBDAV_PASSWORD` | When `NOTES_BACKEND=webdav` | HTTP Basic auth password |

`MEMORY_ROOT` and `SKILLS_ROOT` accept either a full path (`/Notes/betty/memory`) or a path relative to `NOTES_ROOT` (`betty/memory`). Either way, the server refuses to start if they fall outside `NOTES_ROOT`, or if both resolve to the same directory.

Both default under `betty/` so that everything Betty owns sits in one folder inside your notes rather than scattered among them. Neither needs setting: `NOTES_BACKEND` and `NOTES_ROOT` are enough to get memory and skills together.

> **Upgrading from 0.2.x?** `MEMORY_ROOT` used to default to `<NOTES_ROOT>/memory`, and skills only loaded when `SKILLS_ROOT` was set explicitly. If you relied on either default, Betty now looks in `betty/memory` and `betty/skills` instead. Either move those two directories under a new `betty/` folder, or pin the old layout by setting `MEMORY_ROOT=memory` and `SKILLS_ROOT=skills`. Configs that already set both paths explicitly are unaffected.

#### Read-wide, write-narrow

Betty can **read** anything under `NOTES_ROOT` — your whole vault, if you point her at it. She can only **write** under `MEMORY_ROOT` and `SKILLS_ROOT`. That boundary is enforced in code, before any request reaches storage, not merely described in a tool description the model is free to ignore.

There is deliberately **no whole-file write or overwrite tool**. Betty can create a note, append to one, and replace the content under a heading that already exists. She cannot replace a file wholesale, so the worst case for a note you wrote by hand is an unwanted paragraph at the end, not a vanished document.

Every write is conditional. Betty reads a note, edits it, and writes it back with an `If-Match` on the exact version she read. If you edited that note in Obsidian in the meantime, the write fails loudly and she re-reads instead of clobbering your edit.

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

For what Betty actually does with these directories — the file format, `index.md`, `log.md`, and how skills load — see [Memory](#memory) and [Skills](#skills).

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
| `search_notes` | Search notes. Reads `index.md` files and matches filenames by default; pass `content: true` to also search bodies and frontmatter |
| `get_note` | Read a note, returning its body, title, type, and the headings available to `replace_section` |
| `append_note` | Append to a note, creating it with OKF frontmatter if missing. Optionally appends under a named heading |
| `replace_section` | Replace the content under an existing heading, leaving the rest of the file untouched |

Reads may span `NOTES_ROOT`; `append_note` and `replace_section` are restricted to `MEMORY_ROOT` and `SKILLS_ROOT`. There is no whole-file write tool. See [Memory](#memory) for how these fit together.

### Skills (WebDAV or local)

| Tool | Description |
|------|-------------|
| `list_skills` | List available skills by name and description only |
| `load_skill` | Load the full instructions for one skill by name |

## Token efficiency

All tool responses use compact JSON (no pretty-printing). List and search tools (`list_messages`, `search_messages`, `list_events`, `search_events`, `list_tasks`, `search_tasks`, `list_contacts`, `search_contacts`, `search_notes`) return a lean field set by default — just enough to identify and triage each item. Pass `verbose: true` to get the full response with all fields.

Skills go further: `list_skills` returns only each skill's name and description, and the full instructions load on demand via `load_skill`. A dozen skills cost a few hundred tokens to know about, not a few thousand.

**Tool definition token cost** (schema tokens consumed per request, estimated at ~3.5 chars/token):

Tools are only registered when the matching backend is configured. Combine rows to estimate your setup:

| Protocol | Tools | Est. tokens |
|----------|-------|-------------|
| IMAP | 6 | ~373 |
| JMAP (`EMAIL_FORMAT=html` adds `htmlBody`) | 6 | ~380 |
| CalDAV — calendar | 4 | ~192 |
| CalDAV — tasks | 6 | ~383 |
| CardDAV | 4 | ~206 |
| Notes & memory | 4 | ~425 |
| Skills | 2 | ~120 |

Notes and skills register together on `NOTES_BACKEND`, so those two rows come as a pair unless you trim them with `DISABLED_TOOLS`.

**Example totals:** IMAP only ~373 · Notes + Skills only ~545 · IMAP + CalDAV + Tasks ~947 · No email (CalDAV + Tasks + Notes + Skills) ~1,120 · Everything (JMAP + CalDAV + Tasks + CardDAV + Notes + Skills) ~1,705

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
