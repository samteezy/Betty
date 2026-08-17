import { buildServer, createEmailBackend, registerAll } from "./server";
import { JmapBackend } from "./backends/jmap";
import { ImapBackend } from "./backends/imap";
import { harness } from "./test-support/mcp";

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

const NOTES_TOOLS = ["append_note", "get_note", "replace_section", "search_notes"];
const SKILL_TOOLS = ["list_skills", "load_skill"];

/** Register against the recording stub and return the harness. */
function setup(env: NodeJS.ProcessEnv) {
  return harness((server) => {
    registerAll(server, env);
  });
}

/** The minimal viable config: notes only, no credentials of any kind. */
const NOTES_ONLY: NodeJS.ProcessEnv = {
  NOTES_BACKEND: "local",
  NOTES_ROOT: "/Users/you/Notes",
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

  it("refuses to point memory and skills at the same directory", () => {
    expect(() =>
      setup({ ...NOTES_ONLY, MEMORY_ROOT: "betty", SKILLS_ROOT: "betty" })
    ).toThrow(/must be different directories/);
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
    const result = await call("append_note", { path: "journal/today.md", content: "x" });
    expect(result.isError).toBe(true);
    return result.content[0].text as string;
  }

  it("defaults both of Betty's roots under betty/", async () => {
    expect(await refusalFor(NOTES_ONLY)).toMatch(
      /"betty\/memory\/" or "betty\/skills\/"/
    );
  });

  it("no longer treats a bare memory/ as writable", async () => {
    // The 0.2.x default. Anyone who relied on it must now set MEMORY_ROOT.
    const { call } = setup(NOTES_ONLY);
    const result = await call("append_note", { path: "memory/sam.md", content: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Refusing to write outside Betty's own roots/);
  });

  it("honours explicit roots over the defaults", async () => {
    const text = await refusalFor({
      ...NOTES_ONLY,
      MEMORY_ROOT: "memory",
      SKILLS_ROOT: "skills",
    });

    expect(text).toMatch(/"memory\/" or "skills\/"/);
    expect(text).not.toMatch(/betty\//);
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
