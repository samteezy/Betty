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

Every non-email protocol activates alongside whichever email backend is configured — it's one server instance with all protocols combined.

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

## Architecture

Entry point is `src/index.ts` — creates the `McpServer`, registers tools, and connects via stdio transport.

1. **Email backend adapters** (`src/backends/`) — IMAP and JMAP backends, each implementing the `EmailBackend` interface defined in `src/types.ts`, so the MCP tool layer is backend-agnostic. Backend is selected at startup via `EMAIL_BACKEND` env var.

2. **IMAP client** (`src/imap/`) — zero-dependency IMAP implementation using Node's built-in `net`/`tls` modules. `parser.ts` handles IMAP response parsing (parenthesized lists, envelopes, RFC 2047 decoding). `client.ts` manages the TCP/TLS connection with tagged command/response handling and literal string support. IMAP message IDs use composite `folder:uid` format (e.g. `INBOX:4523`) since UIDs are only unique within a mailbox. Sending requires SMTP configuration (IMAP itself is read-only).

3. **WebDAV transport** (`src/webdav/`) — one `fetch`-based, Basic-auth WebDAV client shared by CalDAV, CardDAV, and notes, with SSRF guards on both request URLs and redirect hops. `xml.ts` is a deliberately narrow regex parser for `DAV:multistatus` only.

4. **CalDAV / CardDAV clients** — calendar and contact access, activated when their respective env vars are set. Work alongside any email backend in a single server instance.

5. **Notes backends** (`src/notes/`) — `NotesBackend` implementations over WebDAV or the local filesystem, selected via `NOTES_BACKEND`. Reads span `NOTES_ROOT`; writes are confined to `MEMORY_ROOT` by a code-enforced prefix check. Every write carries a real `If-Match` ETag and fails loudly on conflict rather than clobbering a concurrent human edit. Memory files use Google's Open Knowledge Format (OKF v0.1) — markdown with YAML frontmatter, one concept per file.

6. **MCP tool layer** (`src/tools/`) — registers MCP tools that delegate to the configured backends. Tool inputs and outputs are designed for LLM usability: concise, structured, and avoiding raw protocol output where possible.

## Key Design Principles

- **LLM-first tool design**: tool schemas and return values should be easy for a model to reason about. Prefer structured fields over raw protocol output.
- **Single email backend per instance**: don't multiplex IMAP and JMAP in one running server. CalDAV and CardDAV do run alongside the email backend in the same instance.
- **Credentials via environment**: never bake credentials into config files committed to the repo. See README for the full env var reference.
- **Zero/minimal dependencies**: implement protocol clients from scratch using Node built-ins (`net`/`tls`/`fetch`) to minimize supply chain attack surface. Avoid adding npm packages when the functionality can be implemented with reasonable effort. This extends to formats — the YAML frontmatter parser is hand-rolled rather than pulling in `js-yaml`.
- **User-disablable tools**: `DISABLED_TOOLS` env var prevents specific tools from being registered. See README for details.
- **Read-wide, write-narrow**: notes reads may span `NOTES_ROOT`; writes are prefix-checked against `MEMORY_ROOT` and rejected otherwise. Enforced in code, never merely described in a tool description. There is deliberately **no whole-file write or overwrite tool** — the absence is the safety mechanism, so don't add one.
- **Skills are instructions, not code**: Betty reads markdown from `SKILLS_ROOT`. Nothing in a skill's `scripts/` directory is ever read or executed.
- **Transport-neutral tool layer**: all `process.env` reading happens in `src/index.ts` and is passed down as config objects. Tool handlers never reach for the environment, so an HTTP transport can be added later without rewriting them. (`parseDisabledTools()` at registration time is the one accepted exception.)

## Versioning

Version lives in two places — `package.json` and the `McpServer` constructor in `src/index.ts`. Both must be updated together.

- **Minor bump** (0.4.0 → 0.5.0): new features, new tools, new capabilities.
- **Patch bump** (0.4.0 → 0.4.1): bug fixes, refactors, documentation-only changes.
- If unclear whether a change is a feature or a fix, ask the user before bumping.

## Release checklist

1. Bump the version in **both** `package.json` and the `McpServer` constructor in `src/index.ts`.
2. `npm run build && npm run lint && npm run typecheck && npm test` — all green.
3. `npm run count-tokens` and update the token cost table in `README.md` if tools changed.
4. `npm publish` (runs `prepublishOnly` → `build`).

**Do not deprecate `better-email-mcp`.** It is a separately maintained package that stands on its own merits — a focused email/calendar/contacts MCP for people who don't want a memory layer. Betty is a sibling, not a replacement, and the two are published independently.

## Token cost table

`README.md` has a "Tool definition token cost" table in the Token efficiency section. Keep it updated when tools are added, removed, or renamed. Run `npm run count-tokens` to regenerate the numbers — it builds the project, loads the actual tool registrations with mock backends, and prints per-tool and per-configuration estimates (~3.5 chars/token heuristic for BPE on JSON Schema). The script lives at `scripts/count-tool-tokens.js`.
