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
import { describeWakeTool, registerWakeTool, WAKE_TOOL } from "./tools/wake.js";
import { describeOpenTool, deferredGroups, registerOpenTool } from "./tools/open.js";
import { parseDisabledTools, toolEnabled } from "./tools/helpers.js";
import { ToolGate, parseRearmMs } from "./gate.js";
import { WebDavClient } from "./webdav/client.js";
import { LocalNotesBackend } from "./notes/local-backend.js";
import { WebDavNotesBackend } from "./notes/webdav-backend.js";
import { isUnderPrefix, normalizeRoot, resolveSubRoot } from "./notes/paths.js";
import { NoteConflictError, NoteNotFoundError } from "./notes/errors.js";
import { parseNote } from "./notes/okf.js";
import { BUNDLED_SKILLS } from "./skills/bundled.js";
import { WAKE_BETTY_SKILL, wakeBettySkill } from "./skills/wake-betty.js";
import { EmailBackend, ContactsBackend, NotesBackend } from "./types.js";

export const SERVER_NAME = "betty-mcp";
/** Keep in step with the version in package.json. */
export const SERVER_VERSION = "0.7.2";

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
  /**
   * Set when the wake gate is active. connectAll starts its idle sweep; the
   * timer lives there rather than in registerAll, which stays free of I/O and
   * timers so the gating matrix can be tested without either.
   */
  gate?: ToolGate;
  /**
   * Take a capability out of service because its backend never authenticated.
   *
   * Registration happens before any connect — it has to, since registerAll is
   * I/O-free — so this is how a startup that got as far as "credentials are
   * present" reports back that they were not accepted. It hides the tools *and*
   * rewrites what `wake_betty` and `open_drawer` say, so a mail token the
   * user revoked leaves nothing behind that would offer them mail.
   *
   * Only set when the gate is active: without it the tools are plainly
   * registered and there are no handles to take back.
   */
  withdrawCapability?: (capability: string, reason: string) => void;
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
  // The wake gate. Tools register normally but start disabled, leaving
  // `wake_betty` as the only thing a client's first tools/list returns. It is
  // tied to the memory layer: with no NOTES_BACKEND there is no wake-betty
  // skill to wake into, and gating a pure mail-and-calendar server would be
  // ceremony with nothing behind it.
  // Read once and shared with registerWakeTool below: the gate decision and the
  // wake tool's own registration must never come from two different reads.
  const disabledTools = parseDisabledTools(env.DISABLED_TOOLS ?? "");
  const gate = wakeGateFor(server, env, disabledTools);
  // Everything below registers through `wrap(capability)`, so the gate collects
  // a handle for each tool and knows which capability it belongs to — that
  // grouping is what `wake_betty` reads back to a model whose tool list has not
  // caught up yet. The labels are the ones describeCapabilities() uses, so the
  // wake description and the wake reply name the same things. `wake_betty`
  // itself goes on the bare server.
  //
  // A `deferred` capability registers exactly as the others do but stays hidden
  // when Betty wakes, until something calls `open_drawer` for it by name.
  // Memory and skills are never deferred — they are what waking is *for*, and a
  // model that has to ask twice before it can search would search less.
  //
  // Opt-in, because the second tier is the one that does not pay for itself by
  // default. Waking already cuts a full configuration from ~2,166 schema tokens
  // to ~104 asleep; holding mail and calendar back takes the awake tier to
  // ~1,105, saving a further ~1,061 — and charges a second mid-conversation
  // `tools/list_changed` for it. On a client that fetches the new list
  // synchronously that is a fair trade. On one that defers
  // tool schemas behind its own search index — Claude Code, and anything else
  // that hands the model a search tool instead of the definitions — it is a bad
  // one twice over: the client is already doing the withholding, so the ~1,061
  // is not saved at all, and the extra list change is another turn the model spends
  // discovering that a tool it was just promised is not callable yet. The
  // failure mode is the expensive one, too — a model that decides Betty cannot
  // read mail. Users on a synchronous client can still have the tokens back.
  const defer = env.BETTY_PROGRESSIVE_TOOLS === "true";
  const wrap = (capability: string, deferred = false): McpServer =>
    gate ? gate.wrap(server, capability, { deferred: deferred && defer }) : server;

  // Email — activates when EMAIL_BACKEND, JMAP_TOKEN, or IMAP_HOST is set
  const email = createEmailBackend(env);
  if (email) registerEmailTools(wrap("mail", true), email);

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
    registerCalendarTools(wrap("calendar", true), calendar, { defaultCalendar });
    registerTaskTools(wrap("tasks", true), calendar, { defaultCalendar });
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
    registerContactTools(wrap("contacts", true), contacts, { defaultAddressBook });
  } else if (email instanceof JmapBackend) {
    // JMAP contacts activate automatically — no extra config needed. They ride
    // on the email backend's session, so they need JMAP email to be configured;
    // CARDDAV_URL is the way to get contacts without it.
    contacts = new JmapContactsBackend(email);
    registerContactTools(wrap("contacts", true), contacts, { defaultAddressBook });
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
    registerNotesTools(wrap("memory"), notes, {
      notesRoot,
      memoryPrefix: roots.MEMORY_ROOT,
      deskPrefix: roots.DESK_ROOT,
      trashPrefix: roots.TRASH_ROOT,
      writeLog: env.MEMORY_LOG !== "false",
      writeUnfiled: env.MEMORY_UNFILED !== "false",
    });
    registerSkillsTools(wrap("skills"), notes, { skillsPrefix: roots.SKILLS_ROOT });
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

  // Close the gate now, before the transport connects, so the client's very
  // first tools/list already shows nothing but wake_betty. `notes` is always
  // set when the gate is — wakeGateFor only returns one for NOTES_BACKEND — but
  // the check is what tells the compiler that too.
  let withdrawCapability: Backends["withdrawCapability"];
  if (gate && notes && notesPaths) {
    // Bound to consts so the narrowing survives into the closures below.
    const activeGate = gate;
    const notesBackend = notes;
    const paths = notesPaths;

    // Registered *before* arm(), so the gate holds it like any other tool and
    // it is hidden while Betty sleeps. It sits in its own group so that opening
    // a drawer can never take away the means of opening the next one.
    const openTool = registerOpenTool(wrap("betty"), {
      gate: activeGate,
      disabled: disabledTools,
    });

    activeGate.arm();
    const wakeTool = registerWakeTool(server, {
      gate: activeGate,
      capabilities: describeCapabilities({ email, calendar, contacts }),
      instructions: () =>
        readWakeInstructions(
          notesBackend,
          paths,
          describeCapabilities({ email, calendar, contacts })
        ),
      // Read at call time, not now: this runs mid-registration in a direct
      // caller's hands, and a snapshot taken here could miss a later tool.
      inventory: () => activeGate.inventory,
      disabled: disabledTools,
    });

    withdrawCapability = (capability, reason) => {
      if (!activeGate.withdraw(capability)) return;
      process.stderr.write(
        `betty-mcp: ${capability} is configured but did not authenticate (${reason}) — ` +
          `its tools stay hidden for this session.\n`
      );
      // Rewrite what the two always-visible descriptions claim. Both were
      // written when the capability still looked live, and a description that
      // offers mail Betty cannot reach is worse than no mention at all — the
      // model promises the user something, then finds no tool to do it with.
      const live = activeGate.inventory.map((group) => group.group);
      wakeTool?.update({
        description: describeWakeTool(
          describeCapabilities({ email, calendar, contacts }).filter((name) => live.includes(name))
        ),
      });
      const openable = deferredGroups(activeGate).map((group) => group.group);
      if (openable.length > 0) {
        openTool?.update({ description: describeOpenTool(openable) });
      } else {
        // Nothing left to open. Withdraw the tool through the gate rather than
        // disabling the handle, or the next wake would enable it again along
        // with everything else.
        activeGate.withdraw("betty");
      }
    };
  }

  return {
    email,
    calendar,
    contacts,
    notes,
    notesPaths,
    gate: gate ?? undefined,
    withdrawCapability,
  };
}

/**
 * The wake gate, or null when it should not be armed.
 *
 * Three ways to turn it off, and the last two matter: `BETTY_WAKE_GATE=false`
 * for a user whose client does not act on `tools/list_changed`,
 * `DISABLED_TOOLS=wake_betty` because a gate whose only key is disabled would
 * strand every other tool, and no `NOTES_BACKEND` because there would be
 * nothing to wake into.
 */
function wakeGateFor(
  server: McpServer,
  env: NodeJS.ProcessEnv,
  disabledTools: Set<string>
): ToolGate | null {
  if (!env.NOTES_BACKEND) return null;
  if (env.BETTY_WAKE_GATE === "false") return null;
  if (!toolEnabled(WAKE_TOOL, disabledTools)) return null;
  // parseRearmMs throws on a malformed value — a startup error, rather than a
  // gate that silently never re-arms.
  return new ToolGate(server, { rearmMs: parseRearmMs(env.BETTY_WAKE_REARM_MINUTES) });
}

/**
 * What `wake_betty` says is behind it. Memory and skills are always there — the
 * gate only exists when NOTES_BACKEND is set — and the rest is named only when
 * configured, so the description never advertises a tool that isn't registered.
 */
function describeCapabilities(backends: {
  email: EmailBackend | null;
  calendar: CalDavBackend | null;
  contacts: ContactsBackend | null;
}): string[] {
  const capabilities = ["memory", "skills"];
  if (backends.email) capabilities.push("mail");
  if (backends.calendar) capabilities.push("calendar", "tasks");
  if (backends.contacts) capabilities.push("contacts");
  return capabilities;
}

/**
 * The body of the user's own wake-betty skill, falling back to the bundled text
 * when it isn't there (seeding turned off, or they deleted it).
 *
 * Reading the user's copy rather than the template is the point: whatever they
 * have edited it into is Betty's boot prompt, and it travels with them.
 */
export async function readWakeInstructions(
  notes: NotesBackend,
  paths: NotesPaths,
  capabilities: string[] = []
): Promise<string> {
  const path = `${paths.skillsPrefix}/${WAKE_BETTY_SKILL}/SKILL.md`;
  try {
    return parseNote((await notes.read(path)).text).body;
  } catch (err) {
    if (!(err instanceof NoteNotFoundError)) throw err;
    // The bundled text still names the roots and capabilities this server is
    // actually running with, so it is a real fallback rather than a generic
    // apology.
    return parseNote(wakeBettySkill({ ...paths, capabilities })).body;
  }
}

/**
 * The capabilities a running server actually has — configured, and still
 * standing after connect.
 *
 * The gate's inventory is the authority once there is one, because it is the
 * only thing that knows a capability was withdrawn for failing to authenticate.
 * Its own control group ("betty") is not a capability anyone should be told
 * about, so it drops out with everything else the caller did not configure.
 */
function liveCapabilities(backends: Backends): string[] {
  const configured = describeCapabilities(backends);
  if (!backends.gate) return configured;
  const live = new Set(backends.gate.inventory.map((group) => group.group));
  return configured.filter((name) => live.has(name));
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

/**
 * Connect every configured backend.
 *
 * A credential that is present but not accepted takes its own capability out of
 * service rather than the whole server: the tools stay hidden, the descriptions
 * stop mentioning it, and a warning goes to stderr. A revoked mail token is a
 * reason to have no mail, not a reason to have no memory.
 *
 * That degradation needs the gate — it owns the handles, and without one the
 * tools are plainly registered with no way to take them back. So on an ungated
 * server a failed connect is still fatal, which is exactly how it behaved
 * before, and how `better-email-mcp` behaves today.
 *
 * Notes are the exception in the other direction: still fatal, gate or no gate.
 * A notes root that cannot be reached is a configuration error the user has to
 * fix, and Betty with no memory is not a smaller Betty — she is a mail client.
 */
export async function connectAll(backends: Backends): Promise<void> {
  const withdraw = backends.withdrawCapability;

  const attempt = async (capabilities: string[], connect: () => Promise<void>) => {
    try {
      await connect();
      return true;
    } catch (err) {
      if (!withdraw) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      for (const capability of capabilities) withdraw(capability, reason);
      return false;
    }
  };

  // Email goes first: JmapContactsBackend rides on the email backend's session
  // and throws if that connect() hasn't run yet.
  const jmapContacts = backends.contacts instanceof JmapContactsBackend;
  let emailOk = true;
  if (backends.email) {
    const email = backends.email;
    // JMAP contacts have no session of their own, so they fall with mail.
    emailOk = await attempt(["mail", ...(jmapContacts ? ["contacts"] : [])], () =>
      email.connect()
    );
  }
  if (backends.calendar) {
    const calendar = backends.calendar;
    // One CalDAV backend serves both, so they stand or fall together.
    await attempt(["calendar", "tasks"], () => calendar.connect());
  }
  if (backends.contacts && !(jmapContacts && !emailOk)) {
    const contacts = backends.contacts;
    await attempt(["contacts"], () => contacts.connect());
  }
  // The gate's idle timer starts here rather than at registration, so
  // server.test.ts never leaves one running.
  backends.gate?.startSweeping();
  if (backends.notes) {
    await backends.notes.connect();
    if (backends.notesPaths) {
      // Read after the connects above, so a capability that failed to
      // authenticate is not written into the skill as something Betty offers.
      await seedBundledSkills(backends.notes, backends.notesPaths, liveCapabilities(backends));
    }
  }
}

/**
 * Let go of everything {@link connectAll} took hold of.
 *
 * Stdio never needs this — one Betty lives for the life of the process, and the
 * process ending is the release. The HTTP host is why it exists: it builds a
 * Betty per client session, so a session that ends has to give back its mail
 * connection and its gate timer or a day of phone reconnects would accumulate
 * both. Never fatal: a backend that is already gone is exactly the state wanted.
 */
export async function disconnectAll(backends: Backends): Promise<void> {
  backends.gate?.stopSweeping();
  if (backends.email) {
    try {
      await backends.email.disconnect();
    } catch {
      // Already disconnected, or the socket died first. Nothing to do.
    }
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
async function seedBundledSkills(
  notes: NotesBackend,
  paths: NotesPaths,
  capabilities: string[]
): Promise<void> {
  if (!paths.seedSkills) return;
  for (const skill of BUNDLED_SKILLS) {
    const path = `${paths.skillsPrefix}/${skill.name}/SKILL.md`;
    try {
      await notes.write(path, skill.build({ ...paths, capabilities }));
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
