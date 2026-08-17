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


### Token efficiency

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
| Notes & memory | 4 | ~403 |
| Skills | 2 | ~120 |

**Example totals:** IMAP only ~373 · Notes + Skills only ~523 · IMAP + CalDAV + Tasks ~947 · Everything (JMAP + CalDAV + Tasks + CardDAV + Notes + Skills) ~1,683

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

## Configuration

The server is configured entirely through environment variables.

### Backend selection

| Variable | Description | Default |
|----------|-------------|---------|
| `EMAIL_BACKEND` | `"jmap"` or `"imap"` | `"jmap"` |
| `EMAIL_FORMAT` | `"plain"` or `"html"` | `"plain"` |

When set to `html`, the `send_message` tool requires an `htmlBody` field in addition to `textBody`, and messages are sent as multipart with both plain text and HTML. When set to `plain` (the default), only `textBody` is exposed — the LLM cannot generate HTML email.

### JMAP (Fastmail)

| Variable | Required | Description |
|----------|----------|-------------|
| `JMAP_TOKEN` | Yes | Fastmail API token |
| `JMAP_SESSION_URL` | No | JMAP session URL (default: `https://api.fastmail.com/.well-known/jmap`) |

To get a token, go to Fastmail **Settings > Privacy & Security > API tokens** and create a token with the email scopes you need.

### IMAP

| Variable | Required | Description |
|----------|----------|-------------|
| `IMAP_HOST` | Yes | IMAP server hostname (e.g. `imap.gmail.com`) |
| `IMAP_USER` | Yes | Login username |
| `IMAP_PASSWORD` | Yes | Login password or app-specific password |
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

Calendar and task tools activate when `CALDAV_URL` is set. Works alongside any email backend. Tasks use CalDAV VTODO — supported by Fastmail, iCloud, Nextcloud, Radicale, and most CalDAV servers.

| Variable | Required | Description |
|----------|----------|-------------|
| `CALDAV_URL` | Yes | CalDAV principal or calendar-home URL |
| `CALDAV_USERNAME` | Yes | HTTP Basic auth username |
| `CALDAV_PASSWORD` | Yes | HTTP Basic auth password |
| `CALDAV_DEFAULT_CALENDAR` | No | Default calendar name — when set, tools scope to this calendar automatically |

### Contacts

When using the JMAP backend, contact tools activate automatically via JMAP Contacts (RFC 9610) — no extra configuration needed. To use CardDAV instead (or with the IMAP backend), set `CARDDAV_URL`:

#### CardDAV (optional override)

| Variable | Required | Description |
|----------|----------|-------------|
| `CARDDAV_URL` | Yes | CardDAV principal or addressbook-home URL |
| `CARDDAV_USERNAME` | Yes | HTTP Basic auth username |
| `CARDDAV_PASSWORD` | Yes | HTTP Basic auth password |
| `CARDDAV_DEFAULT_ADDRESS_BOOK` | No | Default address book name — when set, tools scope to this book automatically |

### Notes, memory, and skills

This is what makes Betty an assistant rather than a mail client with extra steps. Notes tools activate when `NOTES_BACKEND` is set, and work alongside any email backend.

| Variable | Required | Description |
|----------|----------|-------------|
| `NOTES_BACKEND` | Yes | `"webdav"` or `"local"`. Enables notes, memory, and skills. |
| `NOTES_ROOT` | Yes | Read scope. A directory path (local) or a path on the WebDAV server. |
| `MEMORY_ROOT` | No | Write scope — must be inside `NOTES_ROOT` (default: `<NOTES_ROOT>/memory`) |
| `SKILLS_ROOT` | No | Skills directory, inside `NOTES_ROOT`. Skill tools are only registered when this is set. |
| `MEMORY_LOG` | No | Append a change-history line to `<MEMORY_ROOT>/log.md` (default: `true`) |
| `WEBDAV_URL` | When `NOTES_BACKEND=webdav` | WebDAV base URL |
| `WEBDAV_USERNAME` | When `NOTES_BACKEND=webdav` | HTTP Basic auth username |
| `WEBDAV_PASSWORD` | When `NOTES_BACKEND=webdav` | HTTP Basic auth password |

`MEMORY_ROOT` and `SKILLS_ROOT` accept either a full path (`/Notes/memory`) or a path relative to `NOTES_ROOT` (`memory`). Either way, the server refuses to start if they fall outside `NOTES_ROOT`.

#### Read-wide, write-narrow

Betty can **read** anything under `NOTES_ROOT` — your whole vault, if you point her at it. She can only **write** under `MEMORY_ROOT`. That boundary is enforced in code, before any request reaches storage, not merely described in a tool description the model is free to ignore.

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
MEMORY_ROOT=/you@fastmail.com/Notes/memory
SKILLS_ROOT=/you@fastmail.com/Notes/skills
```

Create the password under **Settings > Privacy & Security > App passwords**, scoped to **Files**.

#### Local folder

For a local vault — an Obsidian directory, a Syncthing folder, anything on disk:

```bash
NOTES_BACKEND=local
NOTES_ROOT=/Users/you/Notes
MEMORY_ROOT=/Users/you/Notes/memory
SKILLS_ROOT=/Users/you/Notes/skills
```

#### Memory format

Memory files follow Google's [Open Knowledge Format](https://github.com/google/open-knowledge-format) (OKF v0.1): markdown with YAML frontmatter, one concept per file, interlinked with plain markdown links, `index.md` for directory listings, and `log.md` for change history.

```markdown
---
type: person
title: Sam Taylor
description: Notes about Sam
timestamp: 2026-08-17T10:00:00Z
source: betty
---

# Sam Taylor

Prefers email over calls. See [Project Betty](../projects/betty.md).
```

OKF requires only `type`, but Google's own reference parser expects all four of `type`, `title`, `description`, and `timestamp`, so Betty always writes all four. The `source: betty` key is Betty's own addition — everything she wrote stays greppable, and deletable in bulk, without touching anything you wrote yourself.

Nothing is hidden in a dot-prefixed folder. Obsidian ignores dot paths entirely, and memory you can't see isn't memory you can trust.

#### Skills

A skill is a folder containing a `SKILL.md`, in the standard format — frontmatter with `name` and `description`, then markdown instructions. Unknown frontmatter keys are ignored, so skills written for other tools generally load unchanged.

```
skills/
  inbox-triage/
    SKILL.md
  deep-research/
    SKILL.md
```

Because skills live in your storage rather than in a platform's account settings, they travel with you: point Betty at the same folder from a different agent host and she arrives already knowing how you work.

**Skills are instructions, not code.** Betty reads the markdown. She does not read, resolve paths into, or execute anything from a skill's `scripts/` directory — a skill loaded off file storage is untrusted input, and the only safe thing to do with it is read it as text.

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
        "MEMORY_ROOT": "/you@fastmail.com/Notes/memory",
        "SKILLS_ROOT": "/you@fastmail.com/Notes/skills"
      }
    }
  }
}
```

### Memory and skills only (local folder)

Betty needs an email backend configured, but nothing stops you from disabling the email tools and running her purely as a portable memory layer:

```json
{
  "mcpServers": {
    "betty": {
      "command": "npx",
      "args": ["betty-mcp"],
      "env": {
        "EMAIL_BACKEND": "jmap",
        "JMAP_TOKEN": "your-fastmail-api-token",
        "NOTES_BACKEND": "local",
        "NOTES_ROOT": "/Users/you/Notes",
        "SKILLS_ROOT": "/Users/you/Notes/skills",
        "DISABLED_TOOLS": "list_folders,list_messages,get_message,search_messages,send_message,get_attachment"
      }
    }
  }
}
```

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

Reads may span `NOTES_ROOT`; `append_note` and `replace_section` are restricted to `MEMORY_ROOT`. There is no whole-file write tool.

Each `search_notes` result carries `matchedOn` — `index` (linked from a curated `index.md`), `frontmatter`, `path`, or `body` — so the model can tell a deliberate hit from a coincidental filename match. When a search hits its bounds it returns `truncated: true` with a reason, rather than a short list that looks complete.

### Skills (WebDAV or local)

| Tool | Description |
|------|-------------|
| `list_skills` | List available skills by name and description only |
| `load_skill` | Load the full instructions for one skill by name |