/**
 * Composition root.
 *
 * Every `process.env` read in the project happens here (the one exception is
 * `parseDisabledTools()`, called at registration time inside each tool module).
 * Environment comes in as a parameter rather than being reached for, so this is
 * importable and testable — `src/index.ts` is just the entrypoint that hands it
 * `process.env` and connects a transport.
 *
 * Every capability is opt-in and gated on its own trigger var. Email included:
 * Betty runs as a pure memory-and-skills layer with no email credentials at all.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JmapBackend } from "./backends/jmap.js";
import { JmapContactsBackend } from "./backends/jmap-contacts.js";
import { ImapBackend, SmtpConfig } from "./backends/imap.js";
import { CalDavBackend } from "./caldav/backend.js";
import { CardDavBackend } from "./carddav/backend.js";
import { registerEmailTools } from "./tools/register.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerNotesTools } from "./tools/notes.js";
import { registerSkillsTools } from "./tools/skills.js";
import { WebDavClient } from "./webdav/client.js";
import { LocalNotesBackend } from "./notes/local-backend.js";
import { WebDavNotesBackend } from "./notes/webdav-backend.js";
import { isUnderPrefix, normalizeRoot, resolveSubRoot } from "./notes/paths.js";
import { NoteConflictError } from "./notes/errors.js";
import { BUNDLED_SKILLS } from "./skills/bundled.js";
import { EmailBackend, ContactsBackend, NotesBackend } from "./types.js";

export const SERVER_NAME = "betty-mcp";
/** Keep in step with the version in package.json. */
export const SERVER_VERSION = "0.4.0";

/**
 * Betty's own roots live together under `betty/` inside the notes root, so a
 * user can point NOTES_ROOT at an existing vault and have everything Betty
 * writes land in one folder they can inspect, back up, or delete wholesale —
 * rather than two directories scattered among their own notes.
 */
const DEFAULT_MEMORY_ROOT = "betty/memory";
const DEFAULT_SKILLS_ROOT = "betty/skills";
const DEFAULT_DESK_ROOT = "betty/desk";
const DEFAULT_TRASH_ROOT = "betty/trash";

/** Betty's writable roots, resolved once here and passed down as config. */
export interface NotesPaths {
  notesRoot: string;
  memoryPrefix: string;
  skillsPrefix: string;
  deskPrefix: string;
  trashPrefix: string;
  seedSkills: boolean;
}

/** The backends a server instance ended up with. Each is null when unconfigured. */
export interface Backends {
  email: EmailBackend | null;
  calendar: CalDavBackend | null;
  contacts: ContactsBackend | null;
  notes: NotesBackend | null;
  /** Set whenever `notes` is — connectAll needs the roots to seed the skill. */
  notesPaths?: NotesPaths;
}

/**
 * Email — IMAP/SMTP or Fastmail JMAP, and optional like everything else.
 *
 * Returns null when nothing email-shaped is configured. A credential without an
 * explicit `EMAIL_BACKEND` still selects the historical `jmap` default, so
 * configs written before email became optional behave exactly as they did.
 * `EMAIL_BACKEND=none` turns email off even when a token is present.
 */
export function createEmailBackend(env: NodeJS.ProcessEnv): EmailBackend | null {
  const requested = env.EMAIL_BACKEND?.trim().toLowerCase();
  if (requested === "none") return null;

  // No backend named and no credential to infer one from: email is simply off.
  if (!requested && !env.JMAP_TOKEN && !env.IMAP_HOST) return null;

  // Infer the backend from whichever credential is present. JMAP wins when both
  // are, which preserves the historical `EMAIL_BACKEND` default.
  const backendType = requested ?? (env.IMAP_HOST && !env.JMAP_TOKEN ? "imap" : "jmap");

  if (backendType === "jmap") {
    const token = env.JMAP_TOKEN;
    if (!token) {
      throw new Error("JMAP_TOKEN environment variable is required");
    }
    return new JmapBackend({
      token,
      sessionUrl: env.JMAP_SESSION_URL,
    });
  }

  if (backendType === "imap") {
    const host = env.IMAP_HOST;
    const user = env.IMAP_USER;
    const password = env.IMAP_PASSWORD;
    if (!host || !user || !password) {
      throw new Error(
        "IMAP_HOST, IMAP_USER, and IMAP_PASSWORD environment variables are required"
      );
    }
    let smtpConfig: SmtpConfig | undefined;
    const smtpHost = env.SMTP_HOST;
    if (smtpHost) {
      const smtpUser = env.SMTP_USER;
      const smtpPassword = env.SMTP_PASSWORD;
      if (!smtpUser || !smtpPassword) {
        throw new Error(
          "SMTP_USER and SMTP_PASSWORD are required when SMTP_HOST is set"
        );
      }
      smtpConfig = {
        host: smtpHost,
        port: parseInt(env.SMTP_PORT ?? "587", 10),
        user: smtpUser,
        password: smtpPassword,
        tls: env.SMTP_TLS !== "false",
        from: env.SMTP_FROM,
      };
    }

    return new ImapBackend(
      {
        host,
        port: parseInt(env.IMAP_PORT ?? "993", 10),
        user,
        password,
        tls: env.IMAP_TLS !== "false",
      },
      smtpConfig
    );
  }

  // Report what the user actually typed, not the normalized form.
  throw new Error(`Unknown backend: ${env.EMAIL_BACKEND}`);
}

/**
 * Notes storage — WebDAV or a plain local folder. Betty's memory and skills
 * live here rather than inside any one agentic platform, so they travel with
 * the user.
 */
function createNotesBackend(
  env: NodeJS.ProcessEnv,
  backendType: string,
  notesRoot: string
): NotesBackend {
  if (backendType === "local") {
    return new LocalNotesBackend(notesRoot);
  }

  if (backendType === "webdav") {
    const url = env.WEBDAV_URL;
    const username = env.WEBDAV_USERNAME;
    const password = env.WEBDAV_PASSWORD;
    if (!url || !username || !password) {
      throw new Error(
        "WEBDAV_URL, WEBDAV_USERNAME, and WEBDAV_PASSWORD are required when NOTES_BACKEND=webdav"
      );
    }
    const client = new WebDavClient({ baseUrl: url, username, password });
    return new WebDavNotesBackend(client, { baseUrl: url, root: notesRoot });
  }

  throw new Error(`Unknown notes backend: ${backendType} (expected "webdav" or "local")`);
}

/**
 * Wire every configured capability onto `server` and return the backends, which
 * the caller still has to connect.
 *
 * Takes the server as a parameter so tests can drive it with the recording stub
 * from `src/test-support/mcp.ts` instead of a real McpServer and transport.
 */
export function registerAll(server: McpServer, env: NodeJS.ProcessEnv): Backends {
  // Email — activates when EMAIL_BACKEND, JMAP_TOKEN, or IMAP_HOST is set
  const email = createEmailBackend(env);
  if (email) registerEmailTools(server, email);

  // CalDAV — activates when CALDAV_URL is set
  let calendar: CalDavBackend | null = null;
  if (env.CALDAV_URL) {
    const username = env.CALDAV_USERNAME;
    const password = env.CALDAV_PASSWORD;
    if (!username || !password) {
      throw new Error(
        "CALDAV_USERNAME and CALDAV_PASSWORD are required when CALDAV_URL is set"
      );
    }
    calendar = new CalDavBackend({
      url: env.CALDAV_URL,
      username,
      password,
    });
    // Resolved here, at the composition root, so tool handlers never touch env.
    const defaultCalendar = env.CALDAV_DEFAULT_CALENDAR?.trim() || undefined;
    registerCalendarTools(server, calendar, { defaultCalendar });
    registerTaskTools(server, calendar, { defaultCalendar });
  }

  // Contacts — CardDAV when CARDDAV_URL is set, otherwise JMAP contacts when using JMAP backend
  let contacts: ContactsBackend | null = null;
  const defaultAddressBook = env.CARDDAV_DEFAULT_ADDRESS_BOOK?.trim() || undefined;
  if (env.CARDDAV_URL) {
    const username = env.CARDDAV_USERNAME;
    const password = env.CARDDAV_PASSWORD;
    if (!username || !password) {
      throw new Error(
        "CARDDAV_USERNAME and CARDDAV_PASSWORD are required when CARDDAV_URL is set"
      );
    }
    contacts = new CardDavBackend({
      url: env.CARDDAV_URL,
      username,
      password,
    });
    registerContactTools(server, contacts, { defaultAddressBook });
  } else if (email instanceof JmapBackend) {
    // JMAP contacts activate automatically — no extra config needed. They ride
    // on the email backend's session, so they need JMAP email to be configured;
    // CARDDAV_URL is the way to get contacts without it.
    contacts = new JmapContactsBackend(email);
    registerContactTools(server, contacts, { defaultAddressBook });
  }

  // Notes, memory, and skills — activate when NOTES_BACKEND is set
  let notes: NotesBackend | null = null;
  let notesPaths: NotesPaths | undefined;
  if (env.NOTES_BACKEND) {
    const notesRootRaw = env.NOTES_ROOT;
    if (!notesRootRaw) {
      throw new Error("NOTES_ROOT is required when NOTES_BACKEND is set");
    }
    const notesRoot = normalizeRoot(notesRootRaw);

    // Read scope is the whole notes root; write scope is the four roots below.
    // All are resolved here, at the composition root, so tool handlers never
    // touch env.
    const roots = {
      MEMORY_ROOT: resolveSubRoot(notesRoot, env.MEMORY_ROOT ?? DEFAULT_MEMORY_ROOT, "MEMORY_ROOT"),
      SKILLS_ROOT: resolveSubRoot(notesRoot, env.SKILLS_ROOT ?? DEFAULT_SKILLS_ROOT, "SKILLS_ROOT"),
      DESK_ROOT: resolveSubRoot(notesRoot, env.DESK_ROOT ?? DEFAULT_DESK_ROOT, "DESK_ROOT"),
      TRASH_ROOT: resolveSubRoot(notesRoot, env.TRASH_ROOT ?? DEFAULT_TRASH_ROOT, "TRASH_ROOT"),
    };

    // The four roots must be disjoint, not merely distinct. Nesting is the
    // subtler failure: MEMORY_ROOT=betty with the default SKILLS_ROOT=betty/skills
    // resolves to two different strings, but assertWritable is a prefix check,
    // so append_memory would then reach a SKILL.md and write OKF `title`/`type`
    // frontmatter into it — producing a skill list_skills silently skips. The
    // whole point of separate memory and skill tools is that this is
    // unreachable, so enforce it here rather than discover it at runtime.
    const entries = Object.entries(roots);
    for (const [name, path] of entries) {
      for (const [otherName, otherPath] of entries) {
        if (name === otherName) continue;
        if (!isUnderPrefix(otherPath, path)) continue;
        throw new Error(
          path === otherPath
            ? `${otherName} and ${name} must be different directories (both resolved to "${path}")`
            : `${name} ("${path}") must not sit inside ${otherName} ("${otherPath}") — Betty's roots must not overlap, or a memory write could reach a skill`
        );
      }
    }

    notesPaths = {
      notesRoot,
      memoryPrefix: roots.MEMORY_ROOT,
      skillsPrefix: roots.SKILLS_ROOT,
      deskPrefix: roots.DESK_ROOT,
      trashPrefix: roots.TRASH_ROOT,
      seedSkills: env.BETTY_SEED_SKILLS !== "false",
    };

    notes = createNotesBackend(env, env.NOTES_BACKEND, notesRoot);
    registerNotesTools(server, notes, {
      notesRoot,
      memoryPrefix: roots.MEMORY_ROOT,
      deskPrefix: roots.DESK_ROOT,
      trashPrefix: roots.TRASH_ROOT,
      writeLog: env.MEMORY_LOG !== "false",
      writeUnfiled: env.MEMORY_UNFILED !== "false",
    });
    registerSkillsTools(server, notes, { skillsPrefix: roots.SKILLS_ROOT });
  }

  // Now that email is optional, "nothing configured" is reachable for the first
  // time. A server with no tools can only be a misconfiguration, so say so at
  // startup rather than handing the model an empty toolbox.
  if (!email && !calendar && !contacts && !notes) {
    throw new Error(
      "No capabilities configured — Betty would start with no tools. Set at least one of: " +
        "EMAIL_BACKEND (or JMAP_TOKEN / IMAP_HOST) for email, CALDAV_URL for calendar and " +
        "tasks, CARDDAV_URL for contacts, or NOTES_BACKEND (with NOTES_ROOT) for notes, " +
        "memory, and skills."
    );
  }

  return { email, calendar, contacts, notes, notesPaths };
}

/** Build a real McpServer with every configured capability registered on it. */
export function buildServer(env: NodeJS.ProcessEnv): {
  server: McpServer;
  backends: Backends;
} {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  const backends = registerAll(server, env);
  return { server, backends };
}

/** Connect every configured backend. */
export async function connectAll(backends: Backends): Promise<void> {
  // Email goes first: JmapContactsBackend rides on the email backend's session
  // and throws if that connect() hasn't run yet.
  if (backends.email) await backends.email.connect();
  if (backends.calendar) await backends.calendar.connect();
  if (backends.contacts) await backends.contacts.connect();
  if (backends.notes) {
    await backends.notes.connect();
    if (backends.notesPaths) await seedBundledSkills(backends.notes, backends.notesPaths);
  }
}

/**
 * Write the bundled skills into the skills root, once each.
 *
 * A create-only write is the whole mechanism: it succeeds the first time and
 * throws NoteConflictError on every start after, so the user's edits survive
 * upgrades and there is no read to pay for. This lives in connectAll rather
 * than registerAll because registerAll is deliberately I/O-free.
 *
 * Each skill is seeded independently: one that fails, or one the user has
 * deleted on purpose and does not want back, must not stop the others.
 */
async function seedBundledSkills(notes: NotesBackend, paths: NotesPaths): Promise<void> {
  if (!paths.seedSkills) return;
  for (const skill of BUNDLED_SKILLS) {
    const path = `${paths.skillsPrefix}/${skill.name}/SKILL.md`;
    try {
      await notes.write(path, skill.build(paths));
    } catch (err) {
      if (err instanceof NoteConflictError) continue; // already there — leave it alone
      // Seeding a skill is a convenience, never a reason to refuse to start.
      process.stderr.write(
        `betty-mcp: could not install the ${skill.name} skill at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }\n`
      );
    }
  }
}
