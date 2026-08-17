#!/usr/bin/env node
/**
 * Estimates the context-window token cost of all MCP tool definitions.
 *
 * Run after build:  npm run count-tokens
 *
 * Creates a mock McpServer that captures tool() calls, converts Zod schemas
 * to JSON Schema (same as the MCP SDK does), then counts characters and
 * estimates tokens (~3.5 chars/token for JSON with BPE).
 */

"use strict";

const { zodToJsonSchema } = require("zod-to-json-schema");
const { registerEmailTools } = require("../dist/tools/register.js");
const { registerCalendarTools } = require("../dist/tools/calendar.js");
const { registerTaskTools } = require("../dist/tools/tasks.js");
const { registerContactTools } = require("../dist/tools/contacts.js");
const { registerNotesTools } = require("../dist/tools/notes.js");
const { registerSkillsTools } = require("../dist/tools/skills.js");
const { registerWakeTool } = require("../dist/tools/wake.js");
const { registerOpenTool } = require("../dist/tools/open.js");

// ── Mock McpServer ───────────────────────────────────────────────────────

function createCapturingServer() {
  const tools = [];

  const server = {
    tool(name, description, schema, _handler) {
      const jsonProps = {};
      const required = [];

      for (const [key, val] of Object.entries(schema)) {
        const jsonSchema = zodToJsonSchema(val, { target: "openApi3" });
        delete jsonSchema.$schema;
        jsonProps[key] = jsonSchema;

        // Detect required (not ZodOptional)
        if (val._def?.typeName !== "ZodOptional") {
          required.push(key);
        }
      }

      const inputSchema = { type: "object", properties: jsonProps };
      if (required.length > 0) inputSchema.required = required;

      tools.push({ name, description, inputSchema });
    },
  };

  return { server, tools };
}

// ── Mock backends ────────────────────────────────────────────────────────

const noop = async () => { throw new Error("mock"); };
const noopArr = async () => [];
const noopNull = async () => null;

const emailBackend = {
  connect: noop, disconnect: noop,
  listFolders: noopArr, listMessages: noopArr,
  getMessage: noopNull, searchMessages: noopArr,
  sendMessage: noop, getAttachment: noop,
};

const calendarBackend = {
  connect: noop, listCalendars: noopArr,
  listEvents: noopArr, getEvent: noopNull, searchEvents: noopArr,
  listTasks: noopArr, getTask: noopNull, searchTasks: noopArr,
  createTask: noop, updateTask: noop, completeTask: noop,
};

const contactsBackend = {
  connect: noop, listAddressBooks: noopArr,
  listContacts: noopArr, getContact: noopNull, searchContacts: noopArr,
};

const notesBackend = {
  connect: noop, list: noopArr, read: noop, write: noop, move: noop,
};

// ── Token estimation ─────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 3.5;

function estimateTokens(jsonStr) {
  return Math.round(jsonStr.length / CHARS_PER_TOKEN);
}

// ── Per-protocol breakdown ───────────────────────────────────────────────

console.log("# MCP Tool Token Estimates\n");
console.log("Estimated using ~3.5 chars/token (BPE on JSON Schema).\n");

// IMAP (plain text, no htmlBody)
delete process.env.EMAIL_FORMAT;
delete process.env.DISABLED_TOOLS;
const { server: imapServer, tools: imapTools } = createCapturingServer();
registerEmailTools(imapServer, emailBackend);

// JMAP (html format adds htmlBody param to send_email)
process.env.EMAIL_FORMAT = "html";
const { server: jmapServer, tools: jmapTools } = createCapturingServer();
registerEmailTools(jmapServer, emailBackend);

// CalDAV (calendar tools)
const { server: calServer, tools: calTools } = createCapturingServer();
registerCalendarTools(calServer, calendarBackend);

// Tasks (CalDAV VTODO)
const { server: taskServer, tools: taskTools } = createCapturingServer();
registerTaskTools(taskServer, calendarBackend);

// CardDAV (contacts)
const { server: cardServer, tools: cardTools } = createCapturingServer();
registerContactTools(cardServer, contactsBackend);

// Notes / memory (WebDAV or local)
const { server: notesServer, tools: notesTools } = createCapturingServer();
registerNotesTools(notesServer, notesBackend, {
  notesRoot: "/notes", memoryPrefix: "betty/memory",
  deskPrefix: "betty/desk", trashPrefix: "betty/trash",
});

// Skills (same storage as notes)
const { server: skillsServer, tools: skillsTools } = createCapturingServer();
registerSkillsTools(skillsServer, notesBackend, { skillsPrefix: "betty/skills" });

// The wake gate: what a client sees before Betty is woken. Costed against the
// widest capability list, since the description names what is configured.
const { server: wakeServer, tools: wakeTools } = createCapturingServer();
registerWakeTool(wakeServer, {
  gate: { wake: () => true },
  capabilities: ["memory", "skills", "mail", "calendar", "tasks", "contacts"],
  instructions: async () => "",
  disabled: new Set(),
});

// The second tier: what a model sees once Betty is awake, before it opens a
// drawer. Costed against every deferred group, which is the widest its
// description ever gets.
const { server: openServer, tools: openTools } = createCapturingServer();
registerOpenTool(openServer, {
  gate: {
    openGroup: () => "opened",
    inventory: ["mail", "calendar", "tasks", "contacts"].map((group) => ({
      group,
      tools: [],
      open: false,
      deferred: true,
    })),
  },
  disabled: new Set(),
});

const protocols = [
  { label: "IMAP", tools: imapTools, note: "plain text" },
  { label: "JMAP", tools: jmapTools, note: "EMAIL_FORMAT=html adds htmlBody to send_email" },
  { label: "CalDAV (calendar)", tools: calTools, note: "" },
  { label: "CalDAV (tasks)", tools: taskTools, note: "" },
  { label: "CardDAV", tools: cardTools, note: "" },
  { label: "Notes / memory", tools: notesTools, note: "NOTES_BACKEND=webdav|local" },
  { label: "Skills", tools: skillsTools, note: "NOTES_BACKEND=webdav|local" },
  { label: "Wake gate", tools: wakeTools, note: "all a client sees until wake_betty is called" },
  { label: "Drawer opener", tools: openTools, note: "visible while awake, when a drawer is held shut" },
];

for (const proto of protocols) {
  const json = JSON.stringify(proto.tools);
  const tokens = estimateTokens(json);
  const noteStr = proto.note ? `  # ${proto.note}` : "";
  console.log(`## ${proto.label}  (${proto.tools.length} tools, ~${tokens.toLocaleString()} tokens)${noteStr}\n`);
  const maxNameLen = Math.max(...proto.tools.map(t => t.name.length));
  for (const tool of proto.tools) {
    const t = estimateTokens(JSON.stringify(tool));
    console.log(`  ${tool.name.padEnd(maxNameLen)}  ${String(t).padStart(4)} tokens`);
  }
  console.log();
}

// Combined totals for common setups
console.log("## Common configurations\n");
const configs = [
  { label: "IMAP only", groups: [imapTools] },
  { label: "JMAP only", groups: [jmapTools] },
  { label: "IMAP + CalDAV + Tasks", groups: [imapTools, calTools, taskTools] },
  { label: "Notes + Skills only", groups: [notesTools, skillsTools] },
  { label: "No email (CalDAV + Tasks + Notes + Skills)", groups: [calTools, taskTools, notesTools, skillsTools] },
  { label: "JMAP + CalDAV + Tasks + CardDAV", groups: [jmapTools, calTools, taskTools, cardTools] },
  {
    label: "Everything (JMAP + CalDAV + Tasks + CardDAV + Notes + Skills)",
    groups: [jmapTools, calTools, taskTools, cardTools, notesTools, skillsTools],
  },
  { label: "Everything, gated (before wake_betty)", groups: [wakeTools] },
  {
    label: "Everything, awake w/ BETTY_PROGRESSIVE_TOOLS=true",
    groups: [notesTools, skillsTools, openTools, wakeTools],
  },
];

for (const cfg of configs) {
  const allTools = cfg.groups.flat();
  const tokens = estimateTokens(JSON.stringify(allTools));
  console.log(`  ${cfg.label.padEnd(44)} ${allTools.length} tools  ~${String(tokens).padStart(5)} tokens`);
}
