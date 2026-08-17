/**
 * The maintenance pass over Betty's own storage. See `bundled.ts` for how the
 * shipped skills are packaged and seeded.
 *
 * Deliberately says nothing about email: "inbox" is the mail inbox in a product
 * that ships `list_messages`, and `list_skills` shows only names and
 * descriptions — so a description overlapping a user's own mail-triage skill
 * would make "catch up on my inbox" ambiguous, with one answer rewriting the
 * memory index. A test enforces the absence.
 */

import type { SkillContext } from "./bundled.js";

export const ORGANIZE_DESK_SKILL = "organize-desk";

export function organizeDeskSkill({
  memoryPrefix,
  deskPrefix,
  trashPrefix,
}: SkillContext): string {
  return `---
name: ${ORGANIZE_DESK_SKILL}
description: Tidy Betty's memory — file newly captured memories into the category index, merge or retire stale ones, and surface the backlog. Use on a schedule (daily or weekly), or when asked to organize or tidy memory. Not for email.
---

# Organize desk

A maintenance pass over Betty's own storage. Nothing here touches the user's
notes — every write lands under \`${memoryPrefix}/\`, \`${deskPrefix}/\`, or
\`${trashPrefix}/\`.

## The desk

| File | What it is | Who writes it |
|---|---|---|
| \`${memoryPrefix}/index.md\` | Category index of everything Betty knows | **only this skill** |
| \`${deskPrefix}/unfiled.md\` | Memories not yet in the index, under \`## Unprocessed\` | Betty automatically, on every memory created or moved |
| \`${deskPrefix}/backlog.md\` | Things to raise with the user | this skill |
| \`${deskPrefix}/log.md\` | Append-only history | Betty automatically. **Never edit it.** |
| \`${trashPrefix}/\` | Retired memories | \`move_memory\` |

\`${deskPrefix}/\` and \`${trashPrefix}/\` are skipped by \`search_notes\`. Read
them with \`get_note\`, or search them by passing \`dir\`.

## 1. File what is unfiled

\`get_note\` \`${deskPrefix}/unfiled.md\`. For each line under \`## Unprocessed\`,
decide one of:

- **Already good** — the memory exists and says the right thing. Nothing to do.
- **Merge** — it duplicates an existing memory. \`append_memory\` or
  \`replace_memory_section\` the survivor, then \`move_memory\` the duplicate into
  \`${trashPrefix}/\`.
- **Re-file** — right content, wrong place. \`move_memory\` it under the folder
  matching its category.
- **Raise it** — it needs the user's input. Add a line to
  \`${deskPrefix}/backlog.md\` and say why.
- **Retire** — it is stale or wrong. \`move_memory\` it into \`${trashPrefix}/\`.
  There is no delete, and that is deliberate: nothing Betty wrote is ever
  destroyed.

Then clear the queue with \`replace_memory_section\` on \`## Unprocessed\`,
leaving only the items you did not resolve.

## 2. Rebuild the index

\`${memoryPrefix}/index.md\` is a map of **categories**, not a list of
everything. If a category grows past roughly a dozen entries, split it. If it
holds one entry, fold it into a neighbour.

\`\`\`markdown
# Memory index

## People
- [Priya Raman — engineering manager, billing, async-first](people/priya-raman.md)

## Projects
- [Betty — the MCP server, memory and skills](projects/betty.md)
\`\`\`

Two rules that matter more than they look:

1. **Link targets are relative to \`${memoryPrefix}/\`** — write
   \`people/priya-raman.md\`, never \`${memoryPrefix}/people/priya-raman.md\`.
   The root-relative form resolves to a path that doesn't exist, and because
   index hits outrank every other kind of search hit, a broken one becomes the
   *top* result for that query.
2. **Never link \`${trashPrefix}/\`.** Retired means gone from recall.

Link text is matched as well as the target, so the description after the em
dash is what lets Betty find a memory without reading it. Write it for recall.

Check for entries pointing at files that no longer exist — a \`move\` line in
\`unfiled.md\` is the usual cause — and repoint or drop them.

## 3. Report

Finish by reading \`${deskPrefix}/backlog.md\` and summarising it for the user:
what you filed, what you retired, and what needs their input. Keep the summary
to what changed — an unremarkable pass should say so in a sentence.
`;
}
