import {
  Backends,
  buildServer,
  connectAll,
  createEmailBackend,
  readWakeInstructions,
  registerAll,
} from "./server";
import { JmapBackend } from "./backends/jmap";
import { ImapBackend } from "./backends/imap";
import { harness } from "./test-support/mcp";
import { MemoryNotesBackend } from "./test-support/backends";
import { withEnv } from "./test-support/env";

/**
 * Composition-root tests.
 *
 * `registerAll` takes its environment as a parameter and every backend
 * constructor is I/O-free, so the whole gating matrix can be exercised with the
 * recording server stub and no network.
 */

const EMAIL_TOOLS = [
  "get_attachment",
  "get_message",
  "list_folders",
  "list_messages",
  "search_messages",
  "send_message",
];

const NOTES_TOOLS = [
  "append_memory",
  "get_note",
  "move_memory",
  "replace_memory_section",
  "search_notes",
];
const SKILL_TOOLS = ["append_skill", "list_skills", "load_skill", "replace_skill_section"];

/**
 * Register against the recording stub and return the harness.
 *
 * The wake gate is off by default here: these cases are about which tools a
 * given environment *registers*, which is a separate question from which of
 * them are visible before Betty wakes. The gate has its own describe block.
 */
function setup(env: NodeJS.ProcessEnv) {
  return harness((server) => {
    registerAll(server, { BETTY_WAKE_GATE: "false", ...env });
  });
}

/** The minimal viable config: notes only, no credentials of any kind. */
const NOTES_ONLY: NodeJS.ProcessEnv = {
  NOTES_BACKEND: "local",
  NOTES_ROOT: "/Users/you/Notes",
};

/** Notes plus every credentialed capability, for the disclosure tiers. */
const FULL_HOUSE: NodeJS.ProcessEnv = {
  JMAP_TOKEN: "token",
  CALDAV_URL: "https://caldav.fastmail.com/",
  CALDAV_USERNAME: "you@fastmail.com",
  CALDAV_PASSWORD: "pw",
};

describe("email is optional", () => {
  it("registers no email tools when nothing email-shaped is configured", () => {
    const { tools, names } = setup(NOTES_ONLY);

    for (const tool of EMAIL_TOOLS) {
      expect(tools.has(tool)).toBe(false);
    }
    // ...but the configured capability is still there — notes and skills
    // together, since both of Betty's roots now default under betty/.
    expect(names()).toEqual([...NOTES_TOOLS, ...SKILL_TOOLS].sort());
  });

  it("still defaults to jmap when only JMAP_TOKEN is set", () => {
    // The compatibility guarantee: configs written before email became optional
    // must behave exactly as they did.
    const { tools } = setup({ JMAP_TOKEN: "token" });

    for (const tool of EMAIL_TOOLS) {
      expect(tools.has(tool)).toBe(true);
    }
  });

  it("registers no email tools when EMAIL_BACKEND=none, even with a token", () => {
    const { tools } = setup({ ...NOTES_ONLY, EMAIL_BACKEND: "none", JMAP_TOKEN: "token" });

    for (const tool of EMAIL_TOOLS) {
      expect(tools.has(tool)).toBe(false);
    }
    expect(tools.has("get_note")).toBe(true);
  });

  it("treats an empty EMAIL_BACKEND as unset", () => {
    expect(createEmailBackend({ EMAIL_BACKEND: "   " })).toBeNull();
  });

  it("returns null rather than throwing when there is nothing to configure", () => {
    expect(createEmailBackend({})).toBeNull();
  });
});

describe("createEmailBackend", () => {
  it("selects JMAP from a token", () => {
    expect(createEmailBackend({ JMAP_TOKEN: "token" })).toBeInstanceOf(JmapBackend);
  });

  it("selects IMAP when asked", () => {
    const backend = createEmailBackend({
      EMAIL_BACKEND: "imap",
      IMAP_HOST: "imap.example.com",
      IMAP_USER: "you",
      IMAP_PASSWORD: "pw",
    });
    expect(backend).toBeInstanceOf(ImapBackend);
  });

  it("infers IMAP from IMAP_HOST when no backend is named", () => {
    const backend = createEmailBackend({
      IMAP_HOST: "imap.example.com",
      IMAP_USER: "you",
      IMAP_PASSWORD: "pw",
    });
    expect(backend).toBeInstanceOf(ImapBackend);
  });

  it("prefers JMAP when both credentials are present", () => {
    const backend = createEmailBackend({
      JMAP_TOKEN: "token",
      IMAP_HOST: "imap.example.com",
      IMAP_USER: "you",
      IMAP_PASSWORD: "pw",
    });
    expect(backend).toBeInstanceOf(JmapBackend);
  });

  it("reports the IMAP vars when IMAP is inferred but incomplete", () => {
    // Previously this died with "JMAP_TOKEN is required", which named the wrong
    // protocol entirely.
    expect(() => createEmailBackend({ IMAP_HOST: "imap.example.com" })).toThrow(
      /IMAP_HOST, IMAP_USER, and IMAP_PASSWORD/
    );
  });

  it("matches EMAIL_BACKEND case-insensitively", () => {
    expect(createEmailBackend({ EMAIL_BACKEND: "JMAP", JMAP_TOKEN: "t" })).toBeInstanceOf(
      JmapBackend
    );
  });

  it("still fails loudly on a partial config", () => {
    // EMAIL_BACKEND named explicitly but no credential — a misconfiguration,
    // not a request to run without email.
    expect(() => createEmailBackend({ EMAIL_BACKEND: "jmap" })).toThrow(/JMAP_TOKEN/);
    expect(() => createEmailBackend({ EMAIL_BACKEND: "imap" })).toThrow(/IMAP_HOST/);
  });

  it("reports the unnormalized name for an unknown backend", () => {
    expect(() => createEmailBackend({ EMAIL_BACKEND: "PoP3" })).toThrow(
      "Unknown backend: PoP3"
    );
  });

  it("omits send_message when IMAP has no SMTP configured", () => {
    const { tools } = setup({
      EMAIL_BACKEND: "imap",
      IMAP_HOST: "imap.example.com",
      IMAP_USER: "you",
      IMAP_PASSWORD: "pw",
    });

    expect(tools.has("send_message")).toBe(false);
    expect(tools.has("list_messages")).toBe(true);
  });
});

describe("nothing configured", () => {
  it("throws rather than starting with an empty toolbox", () => {
    expect(() => setup({})).toThrow(/No capabilities configured/);
  });

  it("names every trigger var so the message is actionable", () => {
    expect(() => setup({})).toThrow(/NOTES_BACKEND/);
    expect(() => setup({})).toThrow(/CALDAV_URL/);
    expect(() => setup({})).toThrow(/CARDDAV_URL/);
  });
});

describe("contacts gating", () => {
  it("activates JMAP contacts alongside JMAP email", () => {
    const { tools } = setup({ JMAP_TOKEN: "token" });
    expect(tools.has("list_contacts")).toBe(true);
  });

  it("does not activate JMAP contacts for an IMAP backend", () => {
    const { tools } = setup({
      EMAIL_BACKEND: "imap",
      IMAP_HOST: "imap.example.com",
      IMAP_USER: "you",
      IMAP_PASSWORD: "pw",
    });
    expect(tools.has("list_contacts")).toBe(false);
  });

  it("activates CardDAV contacts with no email backend at all", () => {
    const { tools } = setup({
      CARDDAV_URL: "https://carddav.fastmail.com/",
      CARDDAV_USERNAME: "you@fastmail.com",
      CARDDAV_PASSWORD: "pw",
    });

    expect(tools.has("list_contacts")).toBe(true);
    expect(tools.has("list_messages")).toBe(false);
  });
});

describe("notes and skills gating", () => {
  it("registers the skill tools alongside notes, with no SKILLS_ROOT set", () => {
    // Both of Betty's roots default under betty/, so NOTES_BACKEND alone is
    // enough for memory and skills together.
    const { tools } = setup(NOTES_ONLY);
    expect(tools.has("list_skills")).toBe(true);
    expect(tools.has("load_skill")).toBe(true);
  });

  it("still honours an explicit SKILLS_ROOT", () => {
    const { tools } = setup({ ...NOTES_ONLY, SKILLS_ROOT: "skills" });
    expect(tools.has("list_skills")).toBe(true);
    expect(tools.has("load_skill")).toBe(true);
  });

  it("requires NOTES_ROOT alongside NOTES_BACKEND", () => {
    expect(() => setup({ NOTES_BACKEND: "local" })).toThrow(/NOTES_ROOT is required/);
  });

  it("rejects a MEMORY_ROOT outside NOTES_ROOT", () => {
    expect(() =>
      setup({ ...NOTES_ONLY, MEMORY_ROOT: "/Users/you/Elsewhere" })
    ).toThrow(/must be inside NOTES_ROOT/);
  });

  it("rejects a SKILLS_ROOT outside NOTES_ROOT", () => {
    expect(() =>
      setup({ ...NOTES_ONLY, SKILLS_ROOT: "/Users/you/Elsewhere" })
    ).toThrow(/must be inside NOTES_ROOT/);
  });

  it("rejects a DESK_ROOT or TRASH_ROOT outside NOTES_ROOT", () => {
    expect(() => setup({ ...NOTES_ONLY, DESK_ROOT: "/Users/you/Elsewhere" })).toThrow(
      /must be inside NOTES_ROOT/
    );
    expect(() => setup({ ...NOTES_ONLY, TRASH_ROOT: "/Users/you/Elsewhere" })).toThrow(
      /must be inside NOTES_ROOT/
    );
  });

  it.each([
    ["memory and skills", { MEMORY_ROOT: "betty", SKILLS_ROOT: "betty" }],
    ["memory and desk", { MEMORY_ROOT: "betty", DESK_ROOT: "betty" }],
    // Values outside betty/ so these exercise exact equality rather than
    // tripping the nesting check on the other two roots' defaults.
    ["desk and trash", { DESK_ROOT: "shared", TRASH_ROOT: "shared" }],
    ["skills and trash", { SKILLS_ROOT: "shared", TRASH_ROOT: "shared" }],
  ])("refuses to point %s at the same directory", (_label, roots) => {
    // Two roots at one path would make list_skills enumerate memories as
    // skills, or hide the desk among the memories it exists to be separate
    // from. Fail at startup rather than unpick it at runtime.
    expect(() => setup({ ...NOTES_ONLY, ...roots })).toThrow(/must be different directories/);
  });

  it.each([
    ["skills inside memory", { MEMORY_ROOT: "betty" }],
    ["desk inside memory", { MEMORY_ROOT: "betty", SKILLS_ROOT: "elsewhere/skills" }],
    ["memory inside skills", { SKILLS_ROOT: "betty" }],
    ["trash inside desk", { DESK_ROOT: "betty", MEMORY_ROOT: "m", SKILLS_ROOT: "s" }],
  ])("refuses overlapping roots — %s", (_label, roots) => {
    // Distinct strings are not enough. assertWritable is a prefix check, so a
    // memory root containing the skills root would let append_memory write a
    // SKILL.md with OKF frontmatter — a skill list_skills silently skips, which
    // is exactly what separate memory and skill tools exist to prevent.
    expect(() => setup({ ...NOTES_ONLY, ...roots })).toThrow(/must not sit inside/);
  });

  it("accepts four sibling roots", () => {
    expect(() =>
      setup({
        ...NOTES_ONLY,
        MEMORY_ROOT: "a/memory",
        SKILLS_ROOT: "a/skills",
        DESK_ROOT: "a/desk",
        TRASH_ROOT: "a/trash",
      })
    ).not.toThrow();
  });

  it("registers the same tools when the desk writers are turned off", () => {
    // A behaviour flag must not quietly become a registration gate.
    const { names } = setup({ ...NOTES_ONLY, MEMORY_LOG: "false", MEMORY_UNFILED: "false" });
    expect(names()).toEqual([...NOTES_TOOLS, ...SKILL_TOOLS].sort());
  });

  it("requires the WebDAV triple for NOTES_BACKEND=webdav", () => {
    expect(() => setup({ NOTES_BACKEND: "webdav", NOTES_ROOT: "/Notes" })).toThrow(
      /WEBDAV_URL/
    );
  });
});

describe("default roots", () => {
  /**
   * The write guard runs before the tool touches the backend, so a rejected
   * write reports the configured scopes without any filesystem access — which
   * is what lets this suite pin the defaults down while staying I/O-free.
   */
  async function refusalFor(env: NodeJS.ProcessEnv) {
    const { call } = setup(env);
    const result = await call("append_memory", { path: "journal/today.md", content: "x" });
    expect(result.isError).toBe(true);
    return result.content[0].text as string;
  }

  it("defaults Betty's memory-side roots under betty/", async () => {
    expect(await refusalFor(NOTES_ONLY)).toMatch(
      /"betty\/memory\/" or "betty\/desk\/" or "betty\/trash\/"/
    );
  });

  it("keeps the skills root out of the memory write scope", async () => {
    // append_memory must not be able to silently produce a skill; that is what
    // append_skill is for.
    expect(await refusalFor(NOTES_ONLY)).not.toMatch(/betty\/skills/);
  });

  it("no longer treats a bare memory/ as writable", async () => {
    // The 0.2.x default. Anyone who relied on it must now set MEMORY_ROOT.
    const { call } = setup(NOTES_ONLY);
    const result = await call("append_memory", { path: "memory/sam.md", content: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Refusing to write outside Betty's own roots/);
  });

  it("honours explicit roots over the defaults", async () => {
    const text = await refusalFor({
      ...NOTES_ONLY,
      MEMORY_ROOT: "memory",
      DESK_ROOT: "desk",
      TRASH_ROOT: "bin",
    });

    expect(text).toMatch(/"memory\/" or "desk\/" or "bin\/"/);
    expect(text).not.toMatch(/betty\//);
  });
});

describe("wake gate", () => {
  /** Register with the gate left at its default: on. */
  function gated(env: NodeJS.ProcessEnv = {}) {
    return harness((server) => registerAll(server, { ...NOTES_ONLY, ...env }));
  }

  it("shows nothing but wake_betty before Betty is woken", () => {
    const h = gated();
    expect(h.names()).toEqual(["wake_betty"]);
  });

  it("still registers everything — the tools are hidden, not absent", () => {
    expect(gated().allNames()).toEqual(
      [...NOTES_TOOLS, ...SKILL_TOOLS, "wake_betty"].sort()
    );
  });

  it("refuses a gated tool until it is woken", () => {
    const h = gated();
    expect(() => h.call("get_note", { path: "betty/memory/index.md" })).toThrow(
      /get_note disabled/
    );
  });

  it("reveals every tool on wake, with one list_changed for the batch", async () => {
    const h = gated();
    await h.call("wake_betty", { loaded: true });

    expect(h.names()).toEqual([...NOTES_TOOLS, ...SKILL_TOOLS, "wake_betty"].sort());
    expect(h.listChangedCount()).toBe(1);
  });

  it("gates the mail and calendar tools too", async () => {
    const h = gated({ ...FULL_HOUSE });

    expect(h.names()).toEqual(["wake_betty"]);
    await h.call("wake_betty", { loaded: true });
    // Waking reveals memory, skills, and the means to ask for the rest — mail
    // and calendar are configured but deliberately still hidden.
    expect(h.names()).toEqual(
      [...NOTES_TOOLS, ...SKILL_TOOLS, "open_drawer", "wake_betty"].sort()
    );

    await h.call("open_drawer", { drawer: "mail" });
    expect(h.names()).toEqual(expect.arrayContaining(["list_messages"]));
    expect(h.names()).not.toContain("list_events");

    await h.call("open_drawer", { drawer: "calendar" });
    expect(h.names()).toEqual(expect.arrayContaining(["list_events"]));
  });

  it("reveals everything at once when progressive disclosure is off", async () => {
    const h = gated({ ...FULL_HOUSE, BETTY_PROGRESSIVE_TOOLS: "false" });

    await h.call("wake_betty", { loaded: true });

    expect(h.names()).toEqual(expect.arrayContaining(["list_messages", "list_events"]));
    // Nothing left to open, so the tool that opens things never registers.
    expect(h.allNames()).not.toContain("open_drawer");
  });

  it("lists the held-back tools by name in the wake reply", async () => {
    // A capability a model cannot name is a capability it will not ask for.
    const body = await gated({ ...FULL_HOUSE }).text("wake_betty");

    expect(body).toContain("- **mail**: ");
    expect(body).toContain("list_messages");
    expect(body).toContain("open_drawer");
  });

  it("names the configured capabilities, and only those", () => {
    const notesOnly = gated().tools.get("wake_betty")?.description ?? "";
    expect(notesOnly).toContain("memory and skills");
    expect(notesOnly).not.toContain("mail");

    const withMail = gated({ JMAP_TOKEN: "token" }).tools.get("wake_betty")?.description;
    expect(withMail).toContain("mail");
    expect(withMail).toContain("contacts"); // JMAP contacts ride along
  });

  it("names the real tools it revealed, grouped by capability", async () => {
    // The reported failure: Betty wakes, and the model carries on as if the
    // only tool it has is wake_betty — because that is still what its tool list
    // says until the client acts on the notification. The reply has to name
    // them, and it has to name the ones that actually registered.
    const h = gated({ JMAP_TOKEN: "token" });

    // No `loaded`, so this is the cold path. NOTES_ROOT does not exist, so the
    // skill read falls back to the bundled text — the listing is unaffected.
    const body = await h.text("wake_betty");

    // Registration order, not alphabetical — compare as sets.
    const memoryLine = body.match(/- \*\*memory\*\*: (.+)/)?.[1] ?? "";
    expect(memoryLine.split(", ").sort()).toEqual(NOTES_TOOLS);
    expect(body).toContain("- **skills**: list_skills");
    expect(body).toContain("- **mail**: ");
    expect(body).not.toContain("**calendar**"); // not configured, not advertised
    // And the second half of "what can Betty do" — the skills this user wrote.
    expect(body).toContain("list_skills");
  });

  describe("a capability that does not authenticate", () => {
    /**
     * Register for real, then swap in backends that fail (or succeed) on
     * command. The point under test is what the composition root does with a
     * connect that throws, not how any one protocol client fails.
     */
    function boot(env: NodeJS.ProcessEnv = {}) {
      let backends!: Backends;
      const h = harness((server) => {
        backends = registerAll(server, {
          ...NOTES_ONLY,
          JMAP_TOKEN: "revoked",
          // No sweep timer, and no filesystem: this test connects for real.
          BETTY_WAKE_REARM_MINUTES: "0",
          ...env,
        });
      });
      backends.notes = new MemoryNotesBackend();
      backends.email = {
        connect: async () => {
          throw new Error("401 Unauthorized");
        },
      } as unknown as NonNullable<Backends["email"]>;
      return { h, backends };
    }

    let stderr: jest.SpyInstance;
    beforeEach(() => {
      stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    });
    afterEach(() => stderr.mockRestore());

    it("starts anyway, and says why on stderr", async () => {
      const { backends } = boot();
      await expect(connectAll(backends)).resolves.toBeUndefined();
      expect(stderr.mock.calls.join("")).toMatch(/mail.*did not authenticate.*401/);
    });

    it("leaves nothing behind that would offer the user mail", async () => {
      const { h, backends } = boot();
      await connectAll(backends);
      await h.call("wake_betty", { loaded: true });

      // Not in the always-visible description...
      expect(h.tools.get("wake_betty")?.description).not.toContain("mail");
      // ...not in the tool list...
      expect(h.names()).not.toContain("list_messages");
      // ...and not nameable: with mail and JMAP contacts both gone there is
      // nothing left to open, so the tool that opens things goes too.
      expect(h.names()).not.toContain("open_drawer");
    });

    it("takes JMAP contacts down with it — they ride on the mail session", async () => {
      const { h, backends } = boot();
      await connectAll(backends);
      await h.call("wake_betty", { loaded: true });
      expect(h.tools.get("wake_betty")?.description).not.toContain("contacts");
    });

    it("keeps the capabilities that did authenticate", async () => {
      const { h, backends } = boot({
        CALDAV_URL: "https://caldav.example/",
        CALDAV_USERNAME: "you",
        CALDAV_PASSWORD: "pw",
      });
      backends.calendar = { connect: async () => {} } as unknown as Backends["calendar"];

      await connectAll(backends);
      await h.call("wake_betty", { loaded: true });

      const reply = await h.text("open_drawer", { drawer: "calendar" });
      expect(reply).toContain("list_events");
      expect(await h.text("open_drawer", { drawer: "mail" })).toContain(
        'no drawer called "mail"'
      );
    });

    it("does not write the failed capability into the seeded skill", async () => {
      // Seeding happens after connect for exactly this reason: the skill is
      // Betty's boot prompt, and it should not describe mail she cannot reach.
      const { backends } = boot();
      const notes = backends.notes as MemoryNotesBackend;

      await connectAll(backends);

      expect(notes.files.get("betty/skills/wake-betty/SKILL.md")).not.toContain("mail");
    });

    it("is still fatal when there is no gate to take the tools back", async () => {
      // An ungated server has no handles to disable, so a half-working toolbox
      // would be worse than a loud failure — and this is how better-email-mcp
      // behaves too.
      let backends!: Backends;
      harness((server) => {
        backends = registerAll(server, {
          ...NOTES_ONLY,
          JMAP_TOKEN: "revoked",
          BETTY_WAKE_GATE: "false",
        });
      });
      backends.notes = new MemoryNotesBackend();
      backends.email = {
        connect: async () => {
          throw new Error("401 Unauthorized");
        },
      } as unknown as NonNullable<Backends["email"]>;

      await expect(connectAll(backends)).rejects.toThrow(/401/);
    });
  });

  it("stays off when BETTY_WAKE_GATE=false", () => {
    const h = gated({ BETTY_WAKE_GATE: "false" });
    expect(h.names()).not.toContain("wake_betty");
    expect(h.names()).toEqual([...NOTES_TOOLS, ...SKILL_TOOLS].sort());
  });

  it("stays off with no notes backend — there would be nothing to wake into", () => {
    // A mail-and-calendar-only server is better-email-mcp's shape. Gating it
    // would be ceremony with no skill behind it, and would break that config
    // on upgrade.
    const h = setup({
      BETTY_WAKE_GATE: undefined,
      JMAP_TOKEN: "token",
    });
    expect(h.names()).toContain("list_messages");
    expect(h.names()).not.toContain("wake_betty");
  });

  it("refuses to arm when DISABLED_TOOLS names wake_betty", () => {
    // Otherwise the gate would have no key and every other tool would be
    // unreachable for the life of the process.
    const h = gated({ DISABLED_TOOLS: "wake_betty" });
    expect(h.names()).toEqual([...NOTES_TOOLS, ...SKILL_TOOLS].sort());
  });

  it("arms from the passed environment, not process.env", () => {
    // registerAll takes its environment as a parameter, so the two can differ.
    // When they did, the gate armed from the parameter while the wake tool
    // skipped itself on process.env — leaving a gate with no key and every
    // tool stranded for the life of the connection.
    withEnv({ DISABLED_TOOLS: "wake_betty" }, () => {
      const h = gated();
      expect(h.names()).toEqual(["wake_betty"]);
    });
  });

  it("rejects a malformed BETTY_WAKE_REARM_MINUTES at startup", () => {
    expect(() => gated({ BETTY_WAKE_REARM_MINUTES: "soon" })).toThrow(
      /BETTY_WAKE_REARM_MINUTES/
    );
  });

  it("hands connectAll a gate to sweep", () => {
    const { backends } = buildServer(NOTES_ONLY);
    expect(backends.gate).toBeDefined();
    expect(backends.gate?.awake).toBe(false);
  });
});

describe("readWakeInstructions", () => {
  const paths = {
    notesRoot: "/Notes",
    memoryPrefix: "betty/memory",
    skillsPrefix: "betty/skills",
    deskPrefix: "betty/desk",
    trashPrefix: "betty/trash",
    seedSkills: true,
  };

  it("returns the user's own copy, without its frontmatter", async () => {
    // Whatever they have edited the skill into is Betty's boot prompt.
    const notes = new MemoryNotesBackend();
    notes.seed(
      "betty/skills/wake-betty/SKILL.md",
      "---\nname: wake-betty\ndescription: d\n---\n\n# Mine\n\nDo it my way.\n"
    );

    const text = await readWakeInstructions(notes, paths);

    expect(text).toContain("Do it my way.");
    expect(text).not.toContain("description: d");
  });

  it("falls back to the bundled text when the skill is missing", async () => {
    // BETTY_SEED_SKILLS=false, or the user deleted it. The fallback still names
    // the roots this server is running with.
    const text = await readWakeInstructions(new MemoryNotesBackend(), {
      ...paths,
      memoryPrefix: "vault/brain",
    });

    expect(text).toContain("vault/brain");
  });

  it("propagates a real storage failure rather than papering over it", async () => {
    const notes = new MemoryNotesBackend();
    notes.read = async () => {
      throw new Error("storage unreachable");
    };

    await expect(readWakeInstructions(notes, paths)).rejects.toThrow(
      "storage unreachable"
    );
  });
});

describe("buildServer", () => {
  it("reports which backends it built", () => {
    const { backends } = buildServer({
      ...NOTES_ONLY,
      JMAP_TOKEN: "token",
      CALDAV_URL: "https://caldav.fastmail.com/",
      CALDAV_USERNAME: "you@fastmail.com",
      CALDAV_PASSWORD: "pw",
    });

    expect(backends.email).toBeInstanceOf(JmapBackend);
    expect(backends.calendar).not.toBeNull();
    expect(backends.contacts).not.toBeNull();
    expect(backends.notes).not.toBeNull();
  });

  it("builds a notes-only server with no email backend", () => {
    const { backends } = buildServer(NOTES_ONLY);

    expect(backends.email).toBeNull();
    expect(backends.calendar).toBeNull();
    expect(backends.contacts).toBeNull();
    expect(backends.notes).not.toBeNull();
  });
});
