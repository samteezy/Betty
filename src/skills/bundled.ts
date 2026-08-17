/**
 * The skills Betty ships with.
 *
 * They exist as string templates compiled into `dist/` rather than committed
 * `.md` files because `package.json`'s `files` is `["dist"]` — a template needs
 * no packaging change, no build step, and no runtime path resolution. Each is
 * rendered against the user's resolved roots, so the instructions name the
 * folders that actually exist rather than the defaults.
 *
 * Seeding is create-only and happens in `connectAll()` (see `server.ts`): if a
 * file is already there, whatever the user has made of it wins, forever. That
 * is the whole update policy — Betty never revises a skill she has handed over.
 */

import { ORGANIZE_DESK_SKILL, organizeDeskSkill } from "./organize-desk.js";
import { WAKE_BETTY_SKILL, wakeBettySkill } from "./wake-betty.js";

/** Betty's resolved roots, relative to the notes root. */
export interface BettyPaths {
  memoryPrefix: string;
  deskPrefix: string;
  trashPrefix: string;
  skillsPrefix: string;
}

/** What a skill is rendered against: where things are, and what Betty can do. */
export interface SkillContext extends BettyPaths {
  /**
   * The capabilities this server actually has, e.g. `["memory", "skills"]` or
   * `["memory", "skills", "mail", "calendar"]`.
   *
   * Passed in so a skill never volunteers something Betty cannot do. A
   * memory-only install that mentions mail in passing has told the model Betty
   * handles email — and the model will offer it, on a server with no mail tools
   * and no mail credentials. Silence is the correct amount to say about a
   * capability that is not there.
   */
  capabilities: string[];
}

export interface BundledSkill {
  /** Folder name under SKILLS_ROOT, and the frontmatter `name`. */
  name: string;
  build(context: SkillContext): string;
}

/**
 * `wake-betty` first because it is the one a user's client config should point
 * at: it explains the rest. The order is only documentation — seeding writes
 * them all, independently.
 */
export const BUNDLED_SKILLS: readonly BundledSkill[] = [
  { name: WAKE_BETTY_SKILL, build: wakeBettySkill },
  { name: ORGANIZE_DESK_SKILL, build: organizeDeskSkill },
];
