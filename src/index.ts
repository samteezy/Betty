#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

function createBackend(): EmailBackend {
  const backendType = process.env.EMAIL_BACKEND ?? "jmap";

  if (backendType === "jmap") {
    const token = process.env.JMAP_TOKEN;
    if (!token) {
      throw new Error("JMAP_TOKEN environment variable is required");
    }
    return new JmapBackend({
      token,
      sessionUrl: process.env.JMAP_SESSION_URL,
    });
  }

  if (backendType === "imap") {
    const host = process.env.IMAP_HOST;
    const user = process.env.IMAP_USER;
    const password = process.env.IMAP_PASSWORD;
    if (!host || !user || !password) {
      throw new Error(
        "IMAP_HOST, IMAP_USER, and IMAP_PASSWORD environment variables are required"
      );
    }
    let smtpConfig: SmtpConfig | undefined;
    const smtpHost = process.env.SMTP_HOST;
    if (smtpHost) {
      const smtpUser = process.env.SMTP_USER;
      const smtpPassword = process.env.SMTP_PASSWORD;
      if (!smtpUser || !smtpPassword) {
        throw new Error(
          "SMTP_USER and SMTP_PASSWORD are required when SMTP_HOST is set"
        );
      }
      smtpConfig = {
        host: smtpHost,
        port: parseInt(process.env.SMTP_PORT ?? "587", 10),
        user: smtpUser,
        password: smtpPassword,
        tls: process.env.SMTP_TLS !== "false",
        from: process.env.SMTP_FROM,
      };
    }

    return new ImapBackend(
      {
        host,
        port: parseInt(process.env.IMAP_PORT ?? "993", 10),
        user,
        password,
        tls: process.env.IMAP_TLS !== "false",
      },
      smtpConfig
    );
  }

  throw new Error(`Unknown backend: ${backendType}`);
}

/**
 * Notes storage — WebDAV or a plain local folder. Betty's memory and skills
 * live here rather than inside any one agentic platform, so they travel with
 * the user.
 */
function createNotesBackend(backendType: string, notesRoot: string): NotesBackend {
  if (backendType === "local") {
    return new LocalNotesBackend(notesRoot);
  }

  if (backendType === "webdav") {
    const url = process.env.WEBDAV_URL;
    const username = process.env.WEBDAV_USERNAME;
    const password = process.env.WEBDAV_PASSWORD;
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

const server = new McpServer({
  name: "betty-mcp",
  version: "0.1.0",
});

const backend = createBackend();
registerEmailTools(server, backend);

// CalDAV — activates when CALDAV_URL is set
let calendarBackend: CalDavBackend | null = null;
if (process.env.CALDAV_URL) {
  const username = process.env.CALDAV_USERNAME;
  const password = process.env.CALDAV_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "CALDAV_USERNAME and CALDAV_PASSWORD are required when CALDAV_URL is set"
    );
  }
  calendarBackend = new CalDavBackend({
    url: process.env.CALDAV_URL,
    username,
    password,
  });
  registerCalendarTools(server, calendarBackend);
  registerTaskTools(server, calendarBackend);
}

// Contacts — CardDAV when CARDDAV_URL is set, otherwise JMAP contacts when using JMAP backend
let contactsBackend: ContactsBackend | null = null;
if (process.env.CARDDAV_URL) {
  const username = process.env.CARDDAV_USERNAME;
  const password = process.env.CARDDAV_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "CARDDAV_USERNAME and CARDDAV_PASSWORD are required when CARDDAV_URL is set"
    );
  }
  contactsBackend = new CardDavBackend({
    url: process.env.CARDDAV_URL,
    username,
    password,
  });
  registerContactTools(server, contactsBackend);
} else if (backend instanceof JmapBackend) {
  // JMAP contacts activate automatically — no extra config needed
  contactsBackend = new JmapContactsBackend(backend);
  registerContactTools(server, contactsBackend);
}

// Notes, memory, and skills — activate when NOTES_BACKEND is set
let notesBackend: NotesBackend | null = null;
if (process.env.NOTES_BACKEND) {
  const notesRootRaw = process.env.NOTES_ROOT;
  if (!notesRootRaw) {
    throw new Error("NOTES_ROOT is required when NOTES_BACKEND is set");
  }
  const notesRoot = normalizeRoot(notesRootRaw);

  // Read scope is the whole notes root; write scope is narrower. Both are
  // resolved here, at the composition root, so tool handlers never touch env.
  const memoryPrefix = resolveSubRoot(
    notesRoot,
    process.env.MEMORY_ROOT ?? "memory",
    "MEMORY_ROOT"
  );

  notesBackend = createNotesBackend(process.env.NOTES_BACKEND, notesRoot);
  registerNotesTools(server, notesBackend, {
    notesRoot,
    memoryPrefix,
    writeLog: process.env.MEMORY_LOG !== "false",
  });

  // Skills are opt-in: without SKILLS_ROOT there is nothing to list, and two
  // tools that always return an empty array would just cost context.
  if (process.env.SKILLS_ROOT) {
    const skillsPrefix = resolveSubRoot(notesRoot, process.env.SKILLS_ROOT, "SKILLS_ROOT");
    registerSkillsTools(server, notesBackend, { skillsPrefix });
  }
}

async function main() {
  await backend.connect();
  if (calendarBackend) await calendarBackend.connect();
  if (contactsBackend) await contactsBackend.connect();
  if (notesBackend) await notesBackend.connect();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
