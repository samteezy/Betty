# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`betty-mcp` is an MCP server for **Betty** — an assistant layer that travels between agentic platforms. Betty's memory and skills live in the user's own file storage rather than inside any one platform, so they move with them. See **[README.md](README.md)** for the authoritative reference on supported backends, configuration, available tools, and usage examples. Keep the README updated when adding or changing user-facing behavior.

Betty shares a codebase and lineage with [`better-email-mcp`](https://github.com/samteezy/better-email-mcp), which remains a separately maintained project for people who want email, calendar, and contacts without a memory layer. Neither supersedes the other. Keep changes to the email, calendar, task, and contact layers portable between the two — if a fix applies to both, it should be easy to carry across.

High-level capabilities:

- **Email** — IMAP/SMTP (any provider) or Fastmail JMAP
- **Calendar** — CalDAV (Fastmail, iCloud, Nextcloud, Radicale, etc.)
- **Tasks** — CalDAV VTODO (same providers as calendar)
- **Contacts** — CardDAV (same providers)
- **Notes & memory** — WebDAV (Fastmail Files, Nextcloud, etc.) or a local folder
- **Skills** — markdown `SKILL.md` folders loaded from the same storage

Every capability is independently opt-in and gated on its own env var, and they all run in one server instance combined. Notes, memory, and skills are one capability sharing the `NOTES_BACKEND` gate — `MEMORY_ROOT` and `SKILLS_ROOT` both have defaults, so skills no longer need their own opt-in. **Email is optional like the rest** — `NOTES_BACKEND` alone is a valid configuration, and Betty then registers no email tools at all. If nothing is configured the server refuses to start rather than exposing an empty toolbox.

## Tech Stack

- **TypeScript** on Node.js, compiled with `tsc`
- **npm** for package management
- **MCP SDK**: `@modelcontextprotocol/sdk` — uses `McpServer` with `StdioServerTransport`
- **Zod** for input validation on MCP tool schemas
- **Jest** with `ts-jest` for testing

## Commands

| Task | Command |
|------|---------|
| Install deps | `npm install` |
| Build | `npm run build` |
| Build (watch) | `npm run dev` |
| Run server | `npm start` |
| Run all tests | `npm test` |
| Run single test | `npx jest path/to/file.test.ts` |
| Watch tests | `npm run test:watch` |
| Lint | `npm run lint` |
| Type-check only | `npm run typecheck` |
| Count tool tokens | `npm run count-tokens` |

## Preflight

**Run the full suite before reporting any code change as done.** Not the one test file you touched — the whole gate. A passing targeted test says nothing about the twenty other suites that share the harness, the backends, or the tool layer.

```bash
npm test && npm run lint && npm run typecheck && npm run build
```

All four must be green. Then, depending on what changed:

- [ ] **`npm test`** — every suite, not just the one you edited.
- [ ] **`npm run lint`** — `src/test-support/` is linted too, under the relaxed test-file rules.
- [ ] **`npm run typecheck`** — two passes: `tsc --noEmit` for the shipped build, then `tsc -p tsconfig.test.json` for tests and test-support. A test file that doesn't compile is a test that isn't testing.
- [ ] **`npm run build`** — then confirm `dist/` has no `test-support/` directory.
- [ ] **Tool schemas changed?** `npm run count-tokens` and update the token cost table in `README.md`.
- [ ] **User-facing behavior changed?** Update `README.md` — it's the authoritative reference.
- [ ] **Shipping?** See the Release checklist below for the version bump.

Report what actually ran. If a step was skipped or a test fails, say so with the output rather than reporting green.

## Live WebDAV credentials

`.env.local` (gitignored via `.env.*`) holds a real WebDAV account for end-to-end testing: `WEBDAV_URL`, `WEBDAV_USERNAME`, `WEBDAV_PASSWORD`, `NOTES_ROOT`.

- **The server does not read it.** Betty has no dotenv dependency and never will — env arrives from the MCP client. Any harness that wants these must parse the file itself.
- **Never print the values.** Redact when echoing (`sed -E 's/=.*/=<set>/'`), and don't paste them into scripts, commits, or test fixtures.
- Use it for what mocks structurally cannot prove. It has already earned its keep: **Fastmail Files discards `If-Match` and `If-None-Match` on PUT** (stale, bogus, and `*`-against-existing all accepted), which made every conditional-write guarantee false on the primary documented backend and would have let startup seeding rewrite a user's edited `SKILL.md`. `WebDavNotesBackend.checkPrecondition()` now enforces both client-side. `Overwrite: F` on MOVE *is* honoured. Unescaped `#`/`?` in a filename also truncated every request URL until `encodeUrlPath()`.
- Re-run it after touching the WebDAV backend, the client, or anything conditional-write shaped. Mocked tests pin the intent; only the live run proves the server agrees.
- Confirm `NOTES_ROOT` points at a scratch folder before running anything that writes. Betty has no delete tool, so cleanup means `WebDavClient.delete()` directly (`src/webdav/client.ts`) or manual removal.

## Architecture

Entry point is `src/index.ts` — a thin shebang wrapper that hands `process.env` to `buildServer()` and connects the stdio transport. The wiring lives in **`src/server.ts`**, the composition root: it takes the environment as a parameter (rather than reading `process.env`) and exports `createEmailBackend()`, `registerAll()`, `buildServer()`, and `connectAll()`. That parameterization is what makes it importable, so `src/server.test.ts` can drive the whole gating matrix through the shared harness — `src/index.ts` itself remains a side-effecting script that can't be imported under Jest.

1. **Email backend adapters** (`src/backends/`) — IMAP and JMAP backends, each implementing the `EmailBackend` interface defined in `src/types.ts`, so the MCP tool layer is backend-agnostic. Backend is selected at startup via `EMAIL_BACKEND`, or inferred from a `JMAP_TOKEN` / `IMAP_HOST` credential. **Email is optional**: `createEmailBackend()` returns `null` when nothing email-shaped is configured (or on `EMAIL_BACKEND=none`), and the email tools are then never registered. Naming a backend without its credentials is still a startup error.

2. **IMAP client** (`src/imap/`) — zero-dependency IMAP implementation using Node's built-in `net`/`tls` modules. `parser.ts` handles IMAP response parsing (parenthesized lists, envelopes, RFC 2047 decoding). `client.ts` manages the TCP/TLS connection with tagged command/response handling and literal string support. IMAP message IDs use composite `folder:uid` format (e.g. `INBOX:4523`) since UIDs are only unique within a mailbox. Sending requires SMTP configuration (IMAP itself is read-only).

3. **WebDAV transport** (`src/webdav/`) — one `fetch`-based, Basic-auth WebDAV client shared by CalDAV, CardDAV, and notes, with SSRF guards on both request URLs and redirect hops. `xml.ts` is a deliberately narrow regex parser for `DAV:multistatus` only.

4. **CalDAV / CardDAV clients** — calendar and contact access, activated when their respective env vars are set. Work alongside any email backend, or with none configured. JMAP contacts are the exception: they ride on the email backend's JMAP session, so they require JMAP email — `CARDDAV_URL` is the way to get contacts without it.

5. **Notes backends** (`src/notes/`) — `NotesBackend` implementations over WebDAV or the local filesystem, selected via `NOTES_BACKEND`. The interface is `connect`/`list`/`read`/`write`/`move` — no delete anywhere. Reads span `NOTES_ROOT`; writes are confined by a code-enforced prefix check (`assertWritable` takes the list of writable prefixes, not a single one). All four roots default under `<NOTES_ROOT>/betty/`, so memory is always a strict subset of the user's notes and everything Betty owns sits in one folder. Every write carries a real `If-Match` ETag and fails loudly on conflict rather than clobbering a concurrent human edit. Memory files use Google's Open Knowledge Format (OKF v0.1) — markdown with YAML frontmatter, one concept per file; `SKILL.md` files get `name`/`description` frontmatter instead, written from `src/tools/skills.ts`.

   **Four roots, three of them searchable.** `MEMORY_ROOT` and `SKILLS_ROOT` are content. `DESK_ROOT` (`unfiled.md`, `backlog.md`, `log.md`) and `TRASH_ROOT` are pruned from the search walk via `WalkOptions.exclude`, unless `search_notes` is given a `dir` inside them.

   **"Inbox" is reserved for email.** Betty ships `list_messages`, so in this product "inbox" means the mail inbox to every user and every model — and users will write their own mail-triage skills that claim the word. Betty's own queue is `unfiled.md`, gated by `MEMORY_UNFILED`, and the bundled skill's description avoids the word entirely (a test enforces that). `list_skills` returns only names and descriptions, so two skills both claiming "inbox" is a real ambiguity at the point where a model chooses one. This buys an invariant worth preserving: **every automatic write lands in the desk, so nothing code writes can ever appear in a recall result.** `index.md` has no code writer at all — the bundled organize-desk skill is its only author, which is what keeps `matchedOn: "index"` (the top-ranked match kind) meaning "filed on purpose".

6. **MCP tool layer** (`src/tools/`) — registers MCP tools that delegate to the configured backends. Tool inputs and outputs are designed for LLM usability: concise, structured, and avoiding raw protocol output where possible. Every `register*Tools` function takes its settings as a config object (`TaskToolConfig`, `NotesToolConfig`, …) rather than reading `process.env`.

7. **Wake gate** (`src/gate.ts`, `src/tools/wake.ts`) — added in 0.5.0. Every tool registers as normal, then `ToolGate.arm()` flips `enabled = false` on each `RegisteredTool` handle, so a client's first `tools/list` returns only `wake_betty`. Calling it opens the gate and sends one `tools/list_changed` for the whole batch (setting `enabled` directly rather than calling the SDK's per-tool `enable()`, which would emit one notification per tool).

   `registerAll` wraps the server in a `Proxy` that collects handles and stamps activity — **no tool module knows the gate exists**, which is what keeps the email/calendar/contact layers portable to `better-email-mcp`. `wake_betty` itself registers on the bare server.

   The Proxy intercepts **both** `tool()` and `registerTool()` (`TOOL_REGISTRARS` in `gate.ts`) and passes everything else through bound to the real server. Both halves matter: the SDK deprecates `tool()` in favour of `registerTool()`, so a `{ tool }`-only stand-in would throw the day a module migrates — but a Proxy that forwarded an unrecognized registration blind would be worse, leaving that tool *visible while Betty is asleep*. Add any future registration method to that set.

   **Gated on `NOTES_BACKEND`**, because with no memory layer there is no `wake-betty` skill to wake into and a mail-only server would be gating for nothing. Off with `BETTY_WAKE_GATE=false` or `DISABLED_TOOLS=wake_betty` (a gate with no key would strand every other tool — `wakeGateFor()` and `registerWakeTool()` both check).

   **It re-arms.** MCP has no per-conversation signal, so the gate is per-*connection*: on a host that keeps one process across chats, waking would otherwise be permanent. `BETTY_WAKE_REARM_MINUTES` (default 10) closes it after idle time; the sweep interval lives in `connectAll`, never `registerAll`, which stays free of I/O *and timers*. Re-arming mid-conversation is affordable only because of the `loaded` parameter: a model that already has the instructions gets the tools back for a sentence. Don't remove it. The SDK's rejection message for a disabled tool is a fixed `Tool X disabled` that can't be customized, so recovery depends entirely on the client acting on `list_changed`.

   `wake_betty`'s definition sits in every request's context forever, so it is a token budget as much as a tool: ~104 tokens against ~2,062 awake. `wake.test.ts` asserts the ceiling. Resist adding parameters or prose.

8. **Test support** (`src/test-support/`) — shared harness for tool-layer tests. `harness(server => registerXTools(...))` records tool registrations against a duck-typed `McpServer` and returns `names()`/`call()`/`json()` for driving the handlers; the stub's `tool()` returns a handle with an `enabled` field so the gate has something to flip, `names()` lists only enabled tools (what a client would see) while `allNames()` lists every registration, and `call()` refuses a disabled tool the way the SDK does; `backends.ts` holds in-memory backends that implement the real interfaces from `src/types.ts`, so an interface change breaks compilation rather than leaving the fakes silently behind; `env.ts` has `withEnv()` for the `DISABLED_TOOLS` tests. Excluded from `tsconfig.json` so it never ships in `dist/`.

## Testing

Jest with `ts-jest`. Test files sit next to the code they cover as `*.test.ts`.

- `tsconfig.json` excludes tests and `src/test-support` from the build; `tsconfig.test.json` includes everything and is what both `ts-jest` and the second half of `npm run typecheck` use. Adding a test-only file means it must be reachable from `tsconfig.test.json`.
- Prefer the shared harness over hand-rolling a mock server or backend in a test file — the two local copies that existed before were already drifting apart.
- Tool-layer tests assert on the exact options object the backend received. These layers are a thin passthrough plus a lean projection, so passthrough fidelity is the thing worth pinning down.
- `src/server.test.ts` covers the composition root's gating matrix — which tools register for a given environment, and which misconfigurations throw at startup. It works because `registerAll(server, env)` takes both the server and the environment as parameters and every backend constructor is I/O-free, so no network or filesystem access is involved. When you add a capability or change a gate, add the case here.

## Key Design Principles

- **LLM-first tool design**: tool schemas and return values should be easy for a model to reason about. Prefer structured fields over raw protocol output.
- **Every capability is opt-in, email included**: each activates on its own env var and none is a prerequisite for another. A user who only wants memory and skills should never have to supply mail credentials. When a capability is unconfigured its tools are not registered at all, rather than registered and erroring — an unusable tool still costs context.
- **Single email backend per instance**: don't multiplex IMAP and JMAP in one running server. CalDAV and CardDAV do run alongside the email backend in the same instance, or without one.
- **Credentials via environment**: never bake credentials into config files committed to the repo. See README for the full env var reference.
- **Zero/minimal dependencies**: implement protocol clients from scratch using Node built-ins (`net`/`tls`/`fetch`) to minimize supply chain attack surface. Avoid adding npm packages when the functionality can be implemented with reasonable effort. This extends to formats — the YAML frontmatter parser is hand-rolled rather than pulling in `js-yaml`.
- **User-disablable tools**: `DISABLED_TOOLS` env var prevents specific tools from being registered. See README for details.
- **Read-wide, write-narrow**: notes reads may span `NOTES_ROOT`; writes are prefix-checked against `MEMORY_ROOT`, `DESK_ROOT`, `TRASH_ROOT` (the memory tools) and `SKILLS_ROOT` (the skill tools), and rejected otherwise. Enforced in code, never merely described in a tool description. There is deliberately **no whole-file write or overwrite tool, and no delete** — the absence is the safety mechanism, so don't add one. Widening the write scope further needs a deliberate decision: the point is that the user's own notes stay readable and untouchable.

  `move_memory` is the one tool that can make a path stop existing, added deliberately in 0.4.0 so memory can be reorganized. It is not an overwrite: it refuses a non-empty destination at all three layers — `assertWritable` on both ends in the tool, an exclusive-create placeholder before `rename` locally, and `Overwrite: F` on the WebDAV MOVE. Retiring a memory means moving it into `TRASH_ROOT`, which is pruned from search but still readable. Do not add a delete tool; `notes.test.ts` asserts its absence.
- **Skills are instructions, not code**: Betty reads markdown from `SKILLS_ROOT`, and may write it there too via `append_skill` / `replace_skill_section` — but nothing in a skill's `scripts/` directory is ever read or executed. Writability is about authoring instructions, and does not loosen that. The skill write tools take a **name**, not a path, so a `SKILL.md` cannot land at a depth `list_skills` won't look.

- **Bundled skills, seeded once**: `src/skills/bundled.ts` lists them; each is a template string compiled into `dist/` (`package.json` `files` is `["dist"]`, so a committed `.md` would not ship). `wake-betty` is the default entry point a client config points at; `organize-desk` is the maintenance pass. They are written in `connectAll()` — never `registerAll()`, which must stay I/O-free for `server.test.ts` — with a create-only write per skill, so the user's edits win on every subsequent start and one failure never blocks the others. A seeding failure warns on stderr and never blocks startup. `bundled.test.ts` applies the shared invariants to every entry via `describe.each`, so a new skill inherits them.
- **Transport-neutral tool layer**: capability configuration is read in `src/server.ts`, which receives the environment as a parameter and passes it down as config objects; `src/index.ts` is the only file that hands it `process.env`. Tool *handlers* never reach for the environment, so an HTTP transport can be added later without rewriting them. This holds for every tool module — `registerTaskTools`, `registerCalendarTools`, and `registerContactTools` take their defaults as config instead of reading `CALDAV_DEFAULT_CALENDAR` / `CARDDAV_DEFAULT_ADDRESS_BOOK` directly.

  Three registration-time reads in the email layer are the remaining exceptions, all pre-existing: `parseDisabledTools()` (`src/tools/helpers.ts`), `parseEmailFormat()` reading `EMAIL_FORMAT` (`src/tools/register.ts:41`), and the module-scope `ATTACHMENT_DIR` (`src/tools/register.ts:16`). None runs inside a handler. Threading them through an `EmailToolConfig` would finish the job — `registerEmailTools` is the one `register*` function that still takes no config object.

## Versioning

Version lives in two places — `package.json` and the `SERVER_VERSION` constant in `src/server.ts` (which feeds the `McpServer` constructor). Both must be updated together.

- **Minor bump** (0.4.0 → 0.5.0): new features, new tools, new capabilities.
- **Patch bump** (0.4.0 → 0.4.1): bug fixes, refactors, documentation-only changes.
- If unclear whether a change is a feature or a fix, ask the user before bumping.

## Release checklist

1. Bump the version in **both** `package.json` and `SERVER_VERSION` in `src/server.ts`.
2. Run the full **Preflight** gate above — all green.
3. `npm run count-tokens` and update the token cost table in `README.md` if tools changed.
4. `npm publish` (runs `prepublishOnly` → `build`).

**Do not deprecate `better-email-mcp`.** It is a separately maintained package that stands on its own merits — a focused email/calendar/contacts MCP for people who don't want a memory layer. Betty is a sibling, not a replacement, and the two are published independently.

## Token cost table

`README.md` has a "Tool definition token cost" table in the Token efficiency section. Keep it updated when tools are added, removed, or renamed. Run `npm run count-tokens` to regenerate the numbers — it builds the project, loads the actual tool registrations with mock backends, and prints per-tool and per-configuration estimates (~3.5 chars/token heuristic for BPE on JSON Schema). The script lives at `scripts/count-tool-tokens.js`.
