import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NotesBackend } from "../types.js";
import { errorResult, jsonResult, parseDisabledTools, toolEnabled } from "./helpers.js";
import { parseNote } from "../notes/okf.js";
import { NoteNotFoundError } from "../notes/errors.js";

/**
 * Skills are markdown Betty reads, never code Betty runs.
 *
 * The standard SKILL.md layout allows a `scripts/` directory alongside the
 * instructions. Betty does not read it, resolve paths into it, or execute
 * anything from it — a skill loaded off someone's file storage is untrusted
 * input, and the only safe thing to do with it is read it as text.
 */

export interface SkillsToolConfig {
  /** Skills directory, relative to the notes root. Read-only. */
  skillsPrefix: string;
  /** Cap on skill folders enumerated. Default 200. */
  maxSkills?: number;
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
}
