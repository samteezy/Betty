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
import { normalizeRoot, resolveSubRoot } from "./notes/paths.js";
import { EmailBackend, ContactsBackend, NotesBackend } from "./types.js";

export const SERVER_NAME = "betty-mcp";
/** Keep in step with the version in package.json. */
export const SERVER_VERSION = "0.2.0";

/** The backends a server instance ended up with. Each is null when unconfigured. */
export interface Backends {
  email: EmailBackend | null;
  calendar: CalDavBackend | null;
  contacts: ContactsBackend | null;
  notes: NotesBackend | null;
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
  if (env.NOTES_BACKEND) {
    const notesRootRaw = env.NOTES_ROOT;
    if (!notesRootRaw) {
      throw new Error("NOTES_ROOT is required when NOTES_BACKEND is set");
    }
    const notesRoot = normalizeRoot(notesRootRaw);

    // Read scope is the whole notes root; write scope is narrower. Both are
    // resolved here, at the composition root, so tool handlers never touch env.
    const memoryPrefix = resolveSubRoot(
      notesRoot,
      env.MEMORY_ROOT ?? "memory",
      "MEMORY_ROOT"
    );

    notes = createNotesBackend(env, env.NOTES_BACKEND, notesRoot);
    registerNotesTools(server, notes, {
      notesRoot,
      memoryPrefix,
      writeLog: env.MEMORY_LOG !== "false",
    });

    // Skills are opt-in: without SKILLS_ROOT there is nothing to list, and two
    // tools that always return an empty array would just cost context.
    if (env.SKILLS_ROOT) {
      const skillsPrefix = resolveSubRoot(notesRoot, env.SKILLS_ROOT, "SKILLS_ROOT");
      registerSkillsTools(server, notes, { skillsPrefix });
    }
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

  return { email, calendar, contacts, notes };
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
  if (backends.notes) await backends.notes.connect();
}
