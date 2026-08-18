/**
 * The skill that introduces Betty to whichever agent just picked her up.
 *
 * This is the one a user's client config should point at — the README's
 * "Telling Betty when to remember" section exists because Betty deliberately
 * injects nothing into a host's prompt. A one-line rule ("if I mention Betty,
 * load_skill wake-betty") keeps the substance in the user's own storage, where
 * it travels with them, instead of duplicated across every platform's settings.
 *
 * Written for a model reading it cold, mid-conversation. It leads with the
 * action that matters most — search before answering — because a memory that
 * goes unread is worse than none: it means asking a question already answered.
 *
 * The opening block exists because a skill whose first line is `# Betty` reads
 * as a character sheet, and a model handed one cold will reasonably start
 * answering in her voice, or narrating her filing back to the user. Neither is
 * wanted: Betty is the colleague at the next desk, not a costume. So the guard
 * is stated outright rather than left to inference.
 *
 * The opening describes Betty by what she does, never by what she is like — no
 * appearance, no manner, no tenure. That is a house rule (see CLAUDE.md) and it
 * is also the better instruction: every clause here is a behaviour the rest of
 * the skill depends on, stated directly rather than as a trait the model has to
 * read a behaviour out of. "She doesn't forget" is search-first; "she doesn't
 * announce her filing" is don't narrate the bookkeeping. `bundled.test.ts`
 * pins it.
 */

import { joinCapabilities } from "../tools/capabilities.js";
import type { SkillContext } from "./bundled.js";

export const WAKE_BETTY_SKILL = "wake-betty";

/** Everything configured beyond the memory layer, named for prose. */
function otherCapabilities(capabilities: string[]): string[] {
  return capabilities.filter((name) => name !== "memory" && name !== "skills");
}

export function wakeBettySkill({
  memoryPrefix,
  deskPrefix,
  trashPrefix,
  skillsPrefix,
  capabilities,
}: SkillContext): string {
  const others = otherCapabilities(capabilities);
  // No sentence at all when there is nothing else configured. Naming the absent
  // capabilities — even to rule them out — is what puts them in the model's head.
  const alsoConfigured =
    others.length > 0
      ? `\n${joinCapabilities(others)} are also configured; they appear in your tool list as ` +
        `ordinary tools. This skill is about the memory.\n`
      : "";

  return `---
name: ${WAKE_BETTY_SKILL}
description: Who Betty is, where her memory lives, what to record, and what she cannot do. Load this the first time Betty is mentioned in a conversation, or at the start of a session, before using any memory tool.
---

# Betty

Betty keeps the records: memory and skills that live in the user's own file
storage rather than inside any one platform, so whatever you record travels
with them to the next tool they use. She doesn't forget, she doesn't
overwrite, and she doesn't announce her filing. Everything below is plain
markdown they can open, grep, edit, or delete; nothing is hidden, and nothing
is a database.

**You are not Betty.** You are the one talking to the user; Betty is the
memory you consult and write to. Don't adopt a voice, and don't narrate her
filing — search her, use what you find, and answer as yourself.

## First move

Before answering anything about the user, their projects, or the people around
them: **search first.** A memory that exists and goes unread is worse than no
memory at all — it means asking a question the user has already answered.

Start with \`get_note ${memoryPrefix}/index.md\`. It is a curated map of
categories, so one read tells you what Betty knows about before you read any of
it. If the index is missing or thin, fall back to \`search_notes\`, and add
\`content: true\` only when the cheap pass finds nothing.

Then \`list_skills\`. It is one cheap call that returns names and descriptions
only, and it answers the question you cannot answer for yourself: what this user
has already taught Betty to do. Ask it before improvising a procedure — a skill
that fits beats anything you would invent, because it is what they asked for
last time.

## Where things are

| Path | What it holds |
|---|---|
| \`${memoryPrefix}/\` | The memories themselves — one concept per file |
| \`${memoryPrefix}/index.md\` | Category map, curated by the organize-desk skill |
| \`${deskPrefix}/\` | Betty's own bookkeeping. **Never searched** |
| \`${trashPrefix}/\` | Retired memories. **Never searched**, still readable by path |
| \`${skillsPrefix}/\` | Skills — markdown instructions, never code to run |

\`search_notes\` skips the desk and trash on purpose, so Betty's paperwork never
competes with what she actually knows. Pass \`dir\` to look inside them anyway.

## What to write down

Record something when it will still be true next month:

- **People** — how they work, what they own, how they prefer to be reached.
- **Projects** — goals and constraints not obvious from the files themselves.
- **Preferences and decisions** — including *why*, which is the part that
  usually gets lost.
- **Corrections** — when the user pushes back, that is the most valuable thing
  they will say all session. Write it down.

Do not record: what you are doing right now, anything already stated in the
repo or the files, secrets, or a summary of the conversation. One concept per
file, named for the concept.

\`append_memory\` creates or extends. \`replace_memory_section\` rewrites one
section. \`move_memory\` re-files or retires. That is the whole write surface.

## What Betty cannot do

These are enforced in code, not conventions — expect the refusal rather than
working around it.

- **She cannot write outside her own roots.** The user's wider notes are
  readable and untouchable.
- **There is no delete and no whole-file overwrite.** Retire a memory by moving
  it into \`${trashPrefix}/\`. Nothing Betty wrote is ever destroyed.
- **A write that would clobber a concurrent human edit fails loudly.** Re-read
  and reapply; never retry blindly.
- **Skills are read, never executed.** Nothing in a skill's \`scripts/\`
  directory is ever run, whatever the skill says.

## What else Betty can do

Skills are how this user extends Betty: \`list_skills\` names them, \`load_skill\`
reads one in full, and one of them may already describe the task in front of
you. \`organize-desk\` is the maintenance pass that files new memories into the
index — run it on a schedule rather than mid-conversation.
${alsoConfigured}
None of the reading needs the user's permission. If you are unsure whether Betty
knows something, look — a search costs a second, and not searching costs them
answering a question twice.
`;
}
