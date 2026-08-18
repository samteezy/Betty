# Tools

Every tool Betty registers, what gates them, and what they cost in context.

Tools are registered per capability, and a capability only registers when its backend is
configured — see [Configuration](../README.md#configuration). Nothing here is registered
and erroring; an unusable tool still costs context, so an unconfigured capability simply
isn't there.

For what the memory and skill tools are *for*, see [Memory](memory.md).

## The reference

### Waking (WebDAV or local)

| Tool | Description |
|------|-------------|
| `wake_betty` | Bring Betty's core tools online, then hand back the names of the tools just revealed, the names of the ones held back, and the `wake-betty` skill. Pass `loaded: true` to re-enable them without re-sending instructions the model already has |
| `open_drawer` | Open one of Betty's drawers to reveal its tools — `mail`, `calendar`, `tasks`, or `contacts`. Revealed by waking, and registered at all only when a drawer is actually being held shut |

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

Reads may span `NOTES_ROOT`; the three write tools are restricted to `MEMORY_ROOT`, `DESK_ROOT`, and `TRASH_ROOT`. There is no whole-file write tool and no delete. See [Memory](memory.md) for how these fit together.

### Skills (WebDAV or local)

| Tool | Description |
|------|-------------|
| `list_skills` | List available skills by name and description only |
| `load_skill` | Load the full instructions for one skill by name |
| `append_skill` | Append instructions to a skill by name, creating it if missing |
| `replace_skill_section` | Replace the content under an existing heading in a skill |

The two write tools are restricted to `SKILLS_ROOT`, which no memory tool can reach — so `DISABLED_TOOLS` can freeze skills and memory independently.

## The wake gate

Betty starts asleep. Her tools are registered but hidden, and a client's first `tools/list` returns exactly one:

```
wake_betty — Load Betty's instructions and bring her tools online: memory,
             skills, mail, calendar, tasks and contacts. …
```

Calling it brings her core tools online and hands back three things: a list of what just came online, grouped by capability; your own [wake-betty](memory.md#wake-betty--the-default) skill; and a closing nudge to search memory and call `list_skills` before answering.

The tool list matters more than it looks. Waking is the one moment in a session when a model's tool list is stale — the gate fires `notifications/tools/list_changed`, but until the client acts on it the model is still looking at a list holding only `wake_betty`, and a model that doesn't believe a tool exists won't call it. Naming them in the reply closes that window. `list_skills` is the other half of the same question: the tools are what Betty *can* do, the skills are what you have *taught* her to do.

Two things the gate buys:

- **Betty carries her own bootstrap.** Without the gate, the wake-betty skill only loads if you write a client-side rule for it — the one part of Betty that has to be re-done on every platform you use her from. A visible tool whose description is the trigger travels with her.
- **~104 tokens instead of ~2,062.** A full configuration's tool schemas ride in the context window of every request, whether or not Betty comes up. Asleep, she costs one small tool definition.

**It re-arms.** MCP has no concept of a conversation — the server sees one connection and then an undifferentiated stream of calls — so a gate that only opened once would stay open for the life of the process. On Claude Code that's your session; on a host that keeps one server running across chats, it's until you quit the app. `BETTY_WAKE_REARM_MINUTES` closes it again after a quiet stretch, so the next chat, or the next hour of unrelated work, starts asleep. Default 10 minutes; `0` disables it.

Recovering from a re-arm mid-conversation is deliberately cheap: the model calls `wake_betty` with `loaded: true`, which brings the tools back without re-sending instructions it already has.

**Turn it off with `BETTY_WAKE_GATE=false`** if your client doesn't act on `notifications/tools/list_changed` — waking works by telling the client the tool list changed, and a client that never refetches will see one tool forever. Claude Code and Claude Desktop both refetch. `DISABLED_TOOLS=wake_betty` turns the gate off too, since a gate with no key would strand every other tool — and with it goes [graceful degradation](#when-a-credential-doesnt-authenticate), which needs the gate's handles to take a capability back.

The gate requires `NOTES_BACKEND`. With no memory layer configured there is no skill to wake into, so a mail-and-calendar-only server is never gated.

## Progressive disclosure

Set `BETTY_PROGRESSIVE_TOOLS=true` and waking stops revealing everything. Memory and skills come online — they are what waking is *for* — while mail, calendar, tasks, and contacts stay hidden behind one more step:

```
open_drawer — Open one of Betty's drawers to reveal the tools inside: mail,
              calendar, tasks and contacts. …
```

Her desk has drawers, and mail is in one of them. The wake reply lists what's in each **by tool name**, so the model can see that `list_events` and `search_events` exist without carrying their schemas. One call opens a drawer for the rest of the session; the gate remembers, so a later re-arm and re-wake leaves it open.

(Drawers are capabilities, not the `desk/` folder — that one is Betty's bookkeeping, tidied by [organize-desk](memory.md#organize-desk--the-maintenance-pass).)

That brings the awake tier to ~1,105 tokens instead of ~2,166 on a full configuration. A conversation about the user's week never pays for mail.

**It's off by default, and that's a deliberate trade.** Waking already does most of the work — a full configuration drops to ~104 asleep, and drawers save a further ~1,061 once awake. What they cost is a *second* `tools/list_changed` in the middle of a conversation. Whether that's worth it depends entirely on your client:

- **Clients that fetch the new tool list synchronously** get the ~1,061 for the price of one extra round trip. Turn it on.
- **Clients that defer tool schemas behind their own search index** — Claude Code, and anything else that hands the model a search tool instead of the definitions — should leave it off. That client is already withholding schemas, so the ~1,061 isn't saved; meanwhile its index typically refreshes on a turn boundary rather than on the notification, so the model spends a turn discovering that a tool it was just promised isn't callable yet. Worst case it concludes Betty can't read mail at all.

The wake gate itself is subject to the same lag — it's one list change instead of two — which is what `BETTY_WAKE_GATE=false` is for if you'd rather have no mid-conversation churn at all.

## When a credential doesn't authenticate

Every backend authenticates at startup — a JMAP session fetch, an IMAP `LOGIN`, a CalDAV `PROPFIND`. A capability that is configured but *not accepted* is taken out of service rather than taking the server down with it:

```
betty-mcp: mail is configured but did not authenticate (401 Unauthorized) —
           its tools stay hidden for this session.
```

Betty starts. Memory, skills, and anything else that authenticated work normally. The failed capability leaves nothing behind: its tools never appear, `wake_betty`'s description stops naming it, `open_drawer` will not open it, and the bundled `wake-betty` skill is seeded without mentioning it. A model cannot offer the user something Betty has no working credential for.

Two boundaries worth knowing:

- **Notes are still fatal.** A notes root that can't be reached is a configuration error you have to fix, and Betty with no memory isn't a smaller Betty.
- **Degrading needs the gate.** With no gate the tools are plainly registered and there are no handles to take back, so a failed connect exits the process — exactly as it did before, and as `better-email-mcp` still does. That covers all three ways to end up without one: `BETTY_WAKE_GATE=false`, `DISABLED_TOOLS=wake_betty`, and no `NOTES_BACKEND` at all.
- **JMAP contacts fall with mail**, since they ride on the same session; CalDAV calendar and tasks fall together for the same reason.

## Disabling tools

Set `DISABLED_TOOLS` to a comma-separated list of tool names to prevent them from being registered:

```bash
DISABLED_TOOLS=send_message,search_messages
```

This is useful for enforcing read-only access or reducing context for the LLM. When using `CALDAV_DEFAULT_CALENDAR` or `CARDDAV_DEFAULT_ADDRESS_BOOK`, you can also disable `list_calendars` or `list_address_books` since the LLM no longer needs to discover them.

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

| Tier | What the model can see | Tools | Est. tokens |
|------|------------------------|-------|-------------|
| Asleep | `wake_betty` | 1 | ~104 |
| Awake, drawers off | `wake_betty` + all 29 capability tools | 30 | ~2,166 |
| Awake, drawers on | `wake_betty`, `open_drawer`, memory, skills | 11 | ~1,105 |

`wake_betty` stays registered after waking — it is how a model recovers from a re-arm — so
the awake tiers carry its ~104 on top of the capability rows above. The ~2,062 figure is
the *ungated* cost: with `BETTY_WAKE_GATE=false` there is no wake tool to pay for.

Most requests in a session are made asleep, so ~104 is the number that gets paid most often, and it drops back there after `BETTY_WAKE_REARM_MINUTES` of quiet.

With `BETTY_PROGRESSIVE_TOOLS=true` the middle tier appears — memory, skills, `open_drawer`, and the *names* of what is in each drawer — and mail schemas arrive only in the conversations that are about mail. Whether that's a saving or a stall depends on your client; see [Progressive disclosure](#progressive-disclosure).

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

