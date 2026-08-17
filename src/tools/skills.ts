import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NotesBackend } from "../types.js";
import { errorResult, jsonResult, parseDisabledTools, toolEnabled } from "./helpers.js";
import {
  SKILL_FRONTMATTER,
  appendToBody,
  appendToSection,
  buildSkillFrontmatter,
  findSection,
  parseNote,
  replaceSection,
  serializeNote,
} from "../notes/okf.js";
import { NoteNotFoundError } from "../notes/errors.js";
import { assertWritable, safeRelPath } from "../notes/paths.js";

/**
 * Skills are markdown Betty reads, never code Betty runs.
 *
 * The standard SKILL.md layout allows a `scripts/` directory alongside the
 * instructions. Betty does not read it, resolve paths into it, or execute
 * anything from it — a skill loaded off someone's file storage is untrusted
 * input, and the only safe thing to do with it is read it as text.
 */

export interface SkillsToolConfig {
  /**
   * Skills directory, relative to the notes root. It is the entire write scope
   * of the two authoring tools below — a skill tool cannot reach memory, and
   * the memory tools cannot reach skills.
   */
  skillsPrefix: string;
  /** Cap on skill folders enumerated. Default 200. */
  maxSkills?: number;
  /** Injectable clock, so tests get deterministic timestamps. */
  now?: () => Date;
}

const DEFAULT_MAX_SKILLS = 200;
const SKILL_FILE = "SKILL.md";

interface SkillSummary {
  name: string;
  description: string;
  /** Path to the SKILL.md, relative to the notes root. */
  path: string;
  folder: string;
}

function asString(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}

export function registerSkillsTools(
  server: McpServer,
  backend: NotesBackend,
  config: SkillsToolConfig
): void {
  const disabled = parseDisabledTools();
  const skillsPrefix = config.skillsPrefix;
  const maxSkills = config.maxSkills ?? DEFAULT_MAX_SKILLS;
  const now = config.now ?? (() => new Date());
  const stamp = () => now().toISOString().replace(/\.\d{3}Z$/, "Z");

  /**
   * Resolve a skill name to its SKILL.md path, for a skill being created.
   *
   * Taking a name rather than a path is what removes the whole class of
   * wrong-depth errors: list_skills looks exactly one level below the skills
   * root, so a SKILL.md written any deeper — or at the root itself — would
   * look saved and never load. A name cannot express either mistake.
   */
  function newSkillPath(name: string): string {
    const folder = safeRelPath(name.trim(), "name");
    if (!folder || folder.includes("/")) {
      throw new Error(
        `Skill name must be a single folder name, not a path: "${name}". It becomes ${skillsPrefix}/<name>/${SKILL_FILE}.`
      );
    }
    const path = `${skillsPrefix}/${folder}/${SKILL_FILE}`;
    // Constructed from skillsPrefix, so this cannot fail — it is here so the
    // write scope is enforced in code on this path too, not just by
    // construction, if the prefix logic is ever changed.
    assertWritable([skillsPrefix], path);
    return path;
  }

  /**
   * Find the SKILL.md an existing skill name refers to, matching the way
   * load_skill does: frontmatter `name` first, then folder name.
   *
   * Deriving the path from the argument alone would be wrong, because
   * list_skills reports the *frontmatter* name. A hand-written skill at
   * `meeting-prep/` whose manifest says `name: Meeting Prep` is listed as
   * "Meeting Prep" — and writing to `<root>/Meeting Prep/SKILL.md` would fail
   * to find it on replace, and on append would silently create a second folder
   * with a duplicate name instead of extending the skill that exists.
   */
  async function existingSkillPath(name: string): Promise<string | null> {
    const wanted = name.trim().toLowerCase();
    const { skills } = await loadSkills();
    const match =
      skills.find((s) => s.name.toLowerCase() === wanted) ??
      skills.find((s) => s.folder.toLowerCase() === wanted);
    return match?.path ?? null;
  }

  /**
   * Enumerate skill folders. One directory level: a folder per skill, each
   * holding a SKILL.md. Frontmatter keys other than name/description are
   * ignored rather than rejected, so richer skill formats still load.
   */
  async function loadSkills(): Promise<{
    skills: SkillSummary[];
    invalid: Array<{ folder: string; reason: string }>;
    truncated: boolean;
  }> {
    const entries = await backend.list(skillsPrefix);
    const folders = entries.filter((e) => e.isDirectory);
    const truncated = folders.length > maxSkills;

    const skills: SkillSummary[] = [];
    const invalid: Array<{ folder: string; reason: string }> = [];

    for (const folder of folders.slice(0, maxSkills)) {
      const path = `${folder.path}/${SKILL_FILE}`;
      let text: string;
      try {
        text = (await backend.read(path)).text;
      } catch (err) {
        // A folder without a SKILL.md simply isn't a skill — not an error.
        if (!(err instanceof NoteNotFoundError)) {
          invalid.push({ folder: folder.name, reason: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }

      const parsed = parseNote(text);
      const name = asString(parsed.frontmatter.name)?.trim();
      const description = asString(parsed.frontmatter.description)?.trim();

      if (!name || !description) {
        invalid.push({
          folder: folder.name,
          reason: `${SKILL_FILE} frontmatter must set both "name" and "description"`,
        });
        continue;
      }

      skills.push({ name, description, path, folder: folder.name });
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));
    return { skills, invalid, truncated };
  }

  if (toolEnabled("list_skills", disabled)) {
    server.tool(
      "list_skills",
      "List available skills by name and description only. Call load_skill to read the full instructions for one.",
      {
        verbose: z
          .boolean()
          .optional()
          .describe("Include the path of each skill and any folders that failed to load"),
      },
      async ({ verbose }) => {
        try {
          const { skills, invalid, truncated } = await loadSkills();

          // Progressive disclosure: name + description is all that goes into
          // the context by default. Bodies load on demand via load_skill.
          const payload: Record<string, unknown> = {
            skills: skills.map((s) =>
              verbose
                ? { name: s.name, description: s.description, path: s.path }
                : { name: s.name, description: s.description }
            ),
          };
          if (verbose && invalid.length > 0) payload.invalid = invalid;
          else if (invalid.length > 0) payload.skippedFolders = invalid.length;
          if (truncated) {
            payload.truncated = true;
            payload.truncatedReason = `More than ${maxSkills} skill folders found; only the first ${maxSkills} were listed.`;
          }
          return jsonResult(payload);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("load_skill", disabled)) {
    server.tool(
      "load_skill",
      "Load the full instructions for one skill by name, as listed by list_skills.",
      {
        name: z.string().describe("Skill name, exactly as returned by list_skills"),
      },
      async ({ name }) => {
        try {
          const { skills } = await loadSkills();
          const wanted = name.trim().toLowerCase();
          const skill =
            skills.find((s) => s.name.toLowerCase() === wanted) ??
            skills.find((s) => s.folder.toLowerCase() === wanted);

          if (!skill) {
            const available = skills.map((s) => s.name).join(", ");
            return {
              content: [
                {
                  type: "text" as const,
                  text: available
                    ? `Skill not found: "${name}". Available skills: ${available}`
                    : `Skill not found: "${name}". No skills are configured.`,
                },
              ],
              isError: true,
            };
          }

          const parsed = parseNote((await backend.read(skill.path)).text);
          return jsonResult({
            name: skill.name,
            description: skill.description,
            path: skill.path,
            instructions: parsed.body,
          });
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("append_skill", disabled)) {
    server.tool(
      "append_skill",
      `Append instructions to a skill, creating it if it does not exist. Writes only to "${skillsPrefix}/<name>/${SKILL_FILE}" — a skill is markdown instructions, never code.`,
      {
        name: z
          .string()
          .describe("Skill name — a single folder name, e.g. \"meeting-prep\". Becomes the skill's folder and its frontmatter name."),
        content: z.string().describe("Markdown instructions to append"),
        heading: z
          .string()
          .optional()
          .describe("Append under this existing heading instead of at the end"),
        description: z
          .string()
          .optional()
          .describe(
            "One-line description, required when creating. list_skills shows only this, so it decides whether the skill ever gets loaded — say when to use the skill, not merely what it is."
          ),
      },
      async ({ name, content, heading, description }) => {
        try {
          // An existing skill is extended wherever it actually lives; only a
          // genuinely new one gets a folder named after the argument.
          const found = await existingSkillPath(name);
          const path = found ?? newSkillPath(name);
          const existing = found
            ? await backend.read(path)
            : await backend.read(path).catch((err) => {
                if (err instanceof NoteNotFoundError) return null;
                throw err;
              });

          let text: string;
          let created: boolean;

          if (existing === null) {
            const skillName = name.trim();
            if (!description?.trim()) {
              throw new Error(
                "A new skill needs a description — it is the only thing list_skills shows, and how the model decides whether to load the skill."
              );
            }
            const frontmatter = buildSkillFrontmatter({
              name: skillName,
              description: description.trim(),
              timestamp: stamp(),
            });
            const body = heading
              ? `# ${skillName}\n\n## ${heading}\n\n${content.trim()}\n`
              : `# ${skillName}\n\n${content.trim()}\n`;
            text = serializeNote(frontmatter, body, SKILL_FRONTMATTER);
            await backend.write(path, text);
            created = true;
          } else {
            const parsed = parseNote(existing.text);
            const body =
              heading && findSection(parsed.body, heading)
                ? appendToSection(parsed.body, heading, content)
                : heading
                  ? appendToBody(parsed.body, `## ${heading}\n\n${content}`)
                  : appendToBody(parsed.body, content);
            text = parsed.raw + body;
            await backend.write(path, text, existing.etag);
            created = false;
          }

          const payload: Record<string, unknown> = { name: name.trim(), path, created, bytes: text.length };
          if (heading) payload.heading = heading;
          return jsonResult(payload);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("replace_skill_section", disabled)) {
    server.tool(
      "replace_skill_section",
      "Replace the content under an existing heading in a skill, leaving the rest untouched. The heading must already exist — use append_skill to add new content.",
      {
        name: z.string().describe("Skill name, as returned by list_skills"),
        heading: z
          .string()
          .describe(
            "Exact text of an existing heading. The section runs to the next heading of the same or higher level."
          ),
        content: z.string().describe("Markdown content to put under the heading"),
      },
      async ({ name, heading, content }) => {
        try {
          const path = (await existingSkillPath(name)) ?? newSkillPath(name);
          const existing = await backend.read(path);
          const parsed = parseNote(existing.text);
          // Throws with the list of headings that do exist, so the model can retry.
          const body = replaceSection(parsed.body, heading, content);
          const text = parsed.raw + body;
          await backend.write(path, text, existing.etag);

          return jsonResult({ name: name.trim(), path, heading, replaced: true, bytes: text.length });
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }
}
