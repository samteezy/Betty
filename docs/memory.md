# Memory

Betty's memory is a folder of markdown files. No database, no embedding index, no
proprietary store — the entire mechanism is files you can open, grep, edit, and delete.

This document covers where memory lives, how recall works, what Betty writes and what she
refuses to write, and the two skills that make the system run. For the tools themselves
see [Tools](tools.md); for the environment variables that point Betty at your storage see
[Configuration](../README.md#notes-memory-and-skills).

## Where it lives, and what it isn't

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

That containment has a consequence worth stating plainly: **an index Betty maintains is an index of memories, not of your notes.** She can only write inside `betty/`, so the index covers what she has learned and written down — the people, projects, and preferences in `memory/`. Your own notes stay uncatalogued unless you index them yourself. Betty *searches* the whole vault; she only *catalogues* her own corner of it. See [index.md](#indexmd--the-part-worth-curating) for who actually writes that file.

## Recall

`search_notes` works outward from the strongest signal. It reads the markdown links inside any [`index.md`](#indexmd--the-part-worth-curating), then matches filenames straight off the directory listing — neither of which costs a file read. Pass `content: true` to also read bodies and frontmatter (one read per file, capped at 100). Every result carries `matchedOn` — `index`, `frontmatter`, `path`, or `body` — and results are ranked in that order, so the model can tell a curated hit from a coincidental filename match. `get_note` then reads the one that looked right, returning the body plus the list of headings available to `replace_memory_section`.

`matchedOn: "index"` covers two cases: a link inside an index whose text or target matched — reported against the *linked* file, not the index — and the index's own title or body matching. An index link is followed, not verified, so an entry pointing at a file that has since moved comes back as a top-ranked hit on a path that no longer exists. Draining the desk is what keeps that from accumulating; see [organize-desk](#organize-desk--the-maintenance-pass).

`desk/` and `trash/` are skipped. Pass `dir` pointing into either one to search it deliberately — so nothing is unreachable, it just isn't in the way.

When a search hits its bounds it says so — `truncated: true` with a reason — rather than returning a short list that looks complete.

## Storing

Three tools, all confined to `MEMORY_ROOT`, `DESK_ROOT`, and `TRASH_ROOT`:

- **`append_memory`** adds content to a memory, creating it with OKF frontmatter if it doesn't exist. Pass `heading` to append under an existing section instead of at the end of the file.
- **`replace_memory_section`** rewrites the content under a heading that already exists, leaving the rest of the file untouched. If the heading doesn't exist, the error lists the ones that do, so the model can retry instead of guessing.
- **`move_memory`** moves or renames a memory. It refuses to overwrite, so the destination must not already exist.

Skills have their own two tools — see [Betty can write skills too](../README.md#betty-can-write-skills-too). A memory tool cannot write a skill and a skill tool cannot write a memory, which is what keeps `DISABLED_TOOLS` able to freeze one without the other.

That is the entire write surface — see [read-wide, write-narrow](#read-wide-write-narrow) for why there is nothing else. In particular there is **no delete**. Retiring a memory means `move_memory` into `trash/`, where it stops appearing in searches but stays readable by path. Nothing Betty wrote is ever destroyed.

A write anywhere outside those directories is refused before it reaches storage, and the refusal names the roots so the model can retarget rather than give up.

## What a memory file looks like

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

## index.md — the part worth curating

`search_notes` reads `index.md` files before anything else and follows the markdown links inside them. Link *text* is matched as well as link target, so an index is how a note's subject gets stated without anyone having to read the note:

```markdown
# People

- [Priya Raman — billing, async-first](people/priya-raman.md)
- [Dan Whitfield — vendor contact at Acme](people/dan-whitfield.md)
```

A hit here outranks every other kind. One curated index turns a folder Betty has to scan into one she can navigate.

### Who writes it

**Nothing in Betty's code ever writes an index.** No startup step, no side effect of a
memory write, no tool that exists to maintain one. That is what keeps the ranking honest:
a top-ranked index hit always means something was filed on purpose. If code appended a
line here every time a memory was created, the index would be a running list of raw
entries wearing the authority of a curated one.

Two things do write it, and both are deliberate acts:

| Author | When |
|--------|------|
| **You** | Whenever you like. It's a markdown file in your own storage |
| **Betty, following [organize-desk](#organize-desk--the-maintenance-pass)** | On the maintenance pass, when you or a schedule runs it |

The distinction that matters is *automatic* versus *protected*, and this is the first, not
the second. `index.md` lives inside `MEMORY_ROOT`, so `append_memory` and
`replace_memory_section` can target it like any other memory — which is exactly how
organize-desk rebuilds it. Nothing special-cases the filename. The guarantee is only that
no code path reaches for it on its own.

So the index is the one file in `betty/` that is never written as a side effect of
anything. Every other automatic write lands in the [desk](#the-desk), which is excluded
from search — which is why a `matchedOn: "index"` result can be trusted to mean *filed*.

### Your own notes count too

Search reads **every** `index.md` under `NOTES_ROOT` (and `index.mdx`, case-insensitively,
at any depth), including ones you wrote for your own notes. If you want your wider vault
indexed, write that index yourself; Betty will read it and rank hits from it just as
highly. She will not maintain it for you — she only writes inside `betty/`.

## The desk

`betty/desk/` is where Betty keeps her working papers. None of it is searched.

| File | What it is | Who writes it |
|------|------------|---------------|
| `unfiled.md` | Memories not yet in the index, under an `## Unprocessed` heading | Betty, automatically |
| `backlog.md` | Things to raise with you next time | the organize-desk skill |
| `log.md` | Append-only change history | Betty, automatically |

The fourth file with a named owner is `memory/index.md`, and it is the one Betty's code
never touches — see [who writes it](#who-writes-it).

**`unfiled.md`** gets a line each time a memory is created or moved:

```markdown
## Unprocessed

- 2026-08-17T14:22:09Z `create` [betty/memory/people/priya-raman.md](…) — Priya Raman
- 2026-08-17T14:31:44Z `move` [betty/memory/projects/betty.md](…) — moved from betty/memory/betty.md
```

That is the whole automatic half of the system. Deciding what those entries *mean* — whether a memory needs merging, re-filing, retiring, or raising with you, and where it belongs in the index — is the [organize-desk skill's](#organize-desk--the-maintenance-pass) job, and it runs when you or your schedule tell it to.

**`log.md`** is the permanent record, distinct from `unfiled.md` because that list gets drained and the log never does:

```markdown
- 2026-08-17T14:22:09Z `create` [betty/memory/people/priya-raman.md](betty/memory/people/priya-raman.md)
- 2026-08-17T14:31:44Z `append` [betty/memory/projects/betty.md](betty/memory/projects/betty.md) — Open questions
- 2026-08-17T15:02:11Z `move` [betty/trash/old-note.md](betty/trash/old-note.md) — from betty/memory/old-note.md
```

Set `MEMORY_LOG=false` or `MEMORY_UNFILED=false` to turn either off. Both are deliberately best-effort: the memory write has already succeeded by that point, so a failure comes back as a `warning` on a successful write rather than as a failed one.

Nothing is hidden in a dot-prefixed folder. Obsidian ignores dot paths entirely, and memory you can't see isn't memory you can trust — which is also why trash is a visible folder rather than a delete.

## Telling Betty when to remember

Betty exposes the tools; she doesn't inject instructions into your host's prompt. Deciding *when* to search and *when* to write is the host model's call, and left to their own devices most models under-use both.

By default [the wake gate](tools.md#the-wake-gate) handles this for you: `wake_betty` is the only tool a client sees until it's called, and calling it hands the model your [wake-betty](#wake-betty--the-default) skill before it can touch anything else. No client-side configuration, on any platform.

With the gate turned off (`BETTY_WAKE_GATE=false`), you need a line in your client's instructions — `CLAUDE.md`, a system prompt, a project rule — to do the same job:

> If I mention Betty, `load_skill` **wake-betty** first.

Or, if you'd rather not depend on the skill at all:

> At the start of a session, `search_notes` for anything relevant to what I'm working on. When you learn something durable about me, my projects, or the people I work with, `append_memory` it under `betty/memory/`.

## The two skills Betty ships with

Both are installed the first time she connects, and never touched again.

### wake-betty — the default

This is what `wake_betty` hands back, and what your one-line client rule should point at if you've turned [the wake gate](tools.md#the-wake-gate) off:

> If I mention Betty, `load_skill` **wake-betty** first.

It tells the model who Betty is, that the first move is to *search before answering*, where memory lives, what is worth recording, and — importantly — what she refuses to do, so it expects the refusal instead of working around it. Keeping it in a skill rather than in your client config is the whole point: the substance lives in your storage and travels with you, and the config stays a single line on every platform — or no line at all, with the gate on.

`wake_betty` reads *your* copy of the file, not the bundled template. Edit it and you have edited Betty's boot prompt.

### organize-desk — the maintenance pass

The other half of the memory system: the tools capture, and this decides what the captures mean.

A pass over the desk drains `unfiled.md` — for each entry, merge it into an existing memory, re-file it, retire it into `trash/`, or add it to `backlog.md` to raise with you — then rebuilds `index.md` so every memory sits under a category heading, and finishes by reporting what's in the backlog.

It is written to be run on a schedule. Point your client's daily or weekly job at it:

> `load_skill` organize-desk and follow it.

If it never runs, nothing breaks — memories still get written and searched. You simply get no index and no triage, which is exactly where Betty was before it existed.

**Both files are seeded once and never revised**, so any edits you make survive upgrades — Betty never rewrites a skill she has handed over. Delete one and it comes back on the next start; set `BETTY_SEED_SKILLS=false` if you'd rather it didn't.

## Read-wide, write-narrow

Betty can **read** anything under `NOTES_ROOT` — your whole vault, if you point her at it. She can only **write** under `MEMORY_ROOT`, `DESK_ROOT`, `TRASH_ROOT`, and `SKILLS_ROOT`. That boundary is enforced in code, before any request reaches storage, not merely described in a tool description the model is free to ignore.

There is deliberately **no whole-file write or overwrite tool, and no delete**. Betty can create a memory, append to one, replace the content under a heading that already exists, and move one. She cannot replace a file wholesale, so the worst case for a note you wrote by hand is an unwanted paragraph at the end, not a vanished document.

`move_memory` refuses a destination that already exists, at every layer down to the `Overwrite: F` header on the WebDAV request — so a move can relocate a file but never consume one. Retiring a memory means moving it into `TRASH_ROOT`, which you can inspect and empty yourself.

Every write is conditional. Betty reads a note, edits it, and writes it back with an `If-Match` on the exact version she read. If you edited that note in Obsidian in the meantime, the write fails loudly and she re-reads instead of clobbering your edit.

**That header is not enough on its own, and Fastmail is the reason.** Fastmail Files accepts a `PUT` carrying a stale `If-Match`, a syntactically invalid one, or `If-None-Match: *` against a file that already exists — all three are discarded rather than honoured. Tested against the live service. So the WebDAV backend checks the precondition itself: a `PROPFIND` before every write compares the current ETag, or confirms nothing is there yet, and refuses locally if the server wouldn't. The headers are still sent, so a server that does enforce them keeps the stronger atomic guarantee.

This costs one extra round trip per write, and it narrows the race rather than closing it — another writer can still land in the gap between the `PROPFIND` and the `PUT`. It is the difference between a guarantee that usually holds and one that never did. `MOVE` needs no such help: Fastmail honours `Overwrite: F` correctly, so a move genuinely cannot consume a file.

