import { registerNotesTools, NotesToolConfig } from "./notes";
import { NoteEntry, NoteRead, NotesBackend, NoteWriteResult } from "../types";
import { NoteConflictError, NoteNotFoundError, conflictMessage, existsMessage } from "../notes/errors";

// --- Test harness ---

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Duck-typed McpServer that just records registrations, as in count-tool-tokens.js. */
function captureServer() {
  const tools = new Map<string, { description: string; handler: Handler }>();
  const server = {
    tool: (name: string, description: string, _schema: unknown, handler: Handler) => {
      tools.set(name, { description, handler });
    },
  };
  return { server: server as never, tools };
}

/** In-memory NotesBackend with real etag semantics. */
class MemoryBackend implements NotesBackend {
  files = new Map<string, string>();
  private versions = new Map<string, number>();

  seed(path: string, text: string): void {
    this.files.set(path, text);
    this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
  }

  private etag(path: string): string {
    return `"v${this.versions.get(path) ?? 0}"`;
  }

  async connect(): Promise<void> {}

  async list(dir: string): Promise<NoteEntry[]> {
    const prefix = dir ? `${dir}/` : "";
    const seen = new Map<string, NoteEntry>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest) continue;
      const [head, ...tail] = rest.split("/");
      const childPath = `${prefix}${head}`;
      if (seen.has(childPath)) continue;
      seen.set(childPath, {
        path: childPath,
        name: head,
        isDirectory: tail.length > 0,
        etag: tail.length > 0 ? undefined : this.etag(childPath),
      });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(path: string): Promise<NoteRead> {
    const text = this.files.get(path);
    if (text === undefined) throw new NoteNotFoundError(path);
    return { text, etag: this.etag(path) };
  }

  async write(path: string, text: string, ifMatch?: string): Promise<NoteWriteResult> {
    const exists = this.files.has(path);
    if (ifMatch === undefined) {
      if (exists) throw new NoteConflictError(existsMessage(path));
    } else {
      if (!exists) throw new NoteNotFoundError(path);
      if (ifMatch !== this.etag(path)) throw new NoteConflictError(conflictMessage(path));
    }
    this.seed(path, text);
    return { etag: this.etag(path) };
  }
}

const CONFIG: NotesToolConfig = {
  notesRoot: "/notes",
  memoryPrefix: "memory",
  writeLog: false,
  now: () => new Date("2026-08-17T10:00:00.000Z"),
};

function setup(config: Partial<NotesToolConfig> = {}) {
  const backend = new MemoryBackend();
  const { server, tools } = captureServer();
  registerNotesTools(server, backend, { ...CONFIG, ...config });
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    return tool.handler(args);
  };
  const json = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(name, args);
    return JSON.parse(result.content[0].text);
  };
  return { backend, tools, call, json };
}

// --- Test fixtures ---

const SAM_NOTE = `---
type: person
title: Sam Taylor
description: Notes about Sam
timestamp: 2026-01-01T00:00:00Z
---

# Sam Taylor

## Preferences

Tea, not coffee.

## History

Met in 2024.
`;

describe("registration", () => {
  it("registers all four memory tools", () => {
    const { tools } = setup();
    expect([...tools.keys()].sort()).toEqual([
      "append_note",
      "get_note",
      "replace_section",
      "search_notes",
    ]);
  });

  it("registers no whole-file write tool", () => {
    // The absence is the safety mechanism — don't add one.
    const { tools } = setup();
    for (const name of ["write_note", "put_note", "create_note", "delete_note", "save_note"]) {
      expect(tools.has(name)).toBe(false);
    }
  });

  it("honours DISABLED_TOOLS", () => {
    const original = process.env.DISABLED_TOOLS;
    process.env.DISABLED_TOOLS = "append_note, replace_section";
    try {
      const { tools } = setup();
      expect(tools.has("append_note")).toBe(false);
      expect(tools.has("replace_section")).toBe(false);
      expect(tools.has("get_note")).toBe(true);
    } finally {
      if (original === undefined) delete process.env.DISABLED_TOOLS;
      else process.env.DISABLED_TOOLS = original;
    }
  });
});

describe("write scope guard", () => {
  it("rejects append_note outside the memory root", async () => {
    const { call, backend } = setup();
    const result = await call("append_note", { path: "journal/today.md", content: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Refusing to write outside the memory root/);
    expect(backend.files.size).toBe(0);
  });

  it("rejects replace_section outside the memory root", async () => {
    const { call, backend } = setup();
    backend.seed("journal/today.md", "# T\n\n## Notes\n\nold\n");

    const result = await call("replace_section", {
      path: "journal/today.md",
      heading: "Notes",
      content: "new",
    });

    expect(result.isError).toBe(true);
    expect(backend.files.get("journal/today.md")).toContain("old");
  });

  it("rejects a traversal that lands outside the memory root", async () => {
    // Normalizes to "journal/x.md" — the guard runs after normalization.
    const { call } = setup();
    const result = await call("append_note", { path: "memory/../journal/x.md", content: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Refusing to write outside the memory root/);
  });

  it("rejects a traversal that escapes the notes root entirely", async () => {
    const { call } = setup();
    const result = await call("append_note", { path: "../../etc/passwd.md", content: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/escapes the notes root/);
  });

  it("rejects an absolute path", async () => {
    const { call } = setup();
    const result = await call("append_note", { path: "/etc/passwd.md", content: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/must be relative/);
  });

  it("rejects a name-prefixed sibling of the memory root", async () => {
    const { call } = setup();
    const result = await call("append_note", { path: "memory-old/sam.md", content: "x" });

    expect(result.isError).toBe(true);
  });

  it("allows a write inside the memory root", async () => {
    const { json, backend } = setup();
    const result = await json("append_note", { path: "memory/people/sam.md", content: "hello" });

    expect(result.created).toBe(true);
    expect(backend.files.has("memory/people/sam.md")).toBe(true);
  });

  it("still allows reads outside the memory root", async () => {
    // Read-wide, write-narrow: journal/ is readable but not writable.
    const { json, backend } = setup();
    backend.seed("journal/today.md", "# Today\n\nStuff.\n");

    await expect(json("get_note", { path: "journal/today.md" })).resolves.toMatchObject({
      path: "journal/today.md",
    });
  });

  it("rejects a non-markdown extension", async () => {
    const { call } = setup();
    const result = await call("append_note", { path: "memory/data.json", content: "{}" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/should end in \.md/);
  });

  it("adds .md when the path has no extension", async () => {
    const { json } = setup();
    const result = await json("append_note", { path: "memory/sam", content: "x" });

    expect(result.path).toBe("memory/sam.md");
  });
});

describe("append_note", () => {
  it("creates a note with all four required OKF keys", async () => {
    const { json, backend } = setup();
    await json("append_note", { path: "memory/sam.md", content: "Likes tea." });

    const text = backend.files.get("memory/sam.md")!;
    expect(text).toContain("type: note");
    expect(text).toContain("title: Sam");
    expect(text).toContain("description: Sam");
    expect(text).toContain("timestamp: 2026-08-17T10:00:00Z");
  });

  it("tags created notes with source: betty for bulk grep and delete", async () => {
    const { json, backend } = setup();
    await json("append_note", { path: "memory/sam.md", content: "x" });

    expect(backend.files.get("memory/sam.md")).toContain("source: betty");
  });

  it("derives a readable title from the filename", async () => {
    const { json, backend } = setup();
    await json("append_note", { path: "memory/people/sam-taylor.md", content: "x" });

    expect(backend.files.get("memory/people/sam-taylor.md")).toContain("title: Sam taylor");
  });

  it("uses an explicit title when given", async () => {
    const { json, backend } = setup();
    await json("append_note", { path: "memory/sam.md", content: "x", title: "Sam Taylor" });

    expect(backend.files.get("memory/sam.md")).toContain("title: Sam Taylor");
  });

  it("appends to an existing note", async () => {
    const { json, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    const result = await json("append_note", { path: "memory/sam.md", content: "New fact." });

    expect(result.created).toBe(false);
    expect(backend.files.get("memory/sam.md")).toContain("New fact.");
    expect(backend.files.get("memory/sam.md")).toContain("Met in 2024.");
  });

  it("leaves existing frontmatter byte-for-byte untouched", async () => {
    const { json, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    await json("append_note", { path: "memory/sam.md", content: "New fact." });

    const updated = backend.files.get("memory/sam.md")!;
    expect(updated.startsWith(SAM_NOTE.slice(0, SAM_NOTE.indexOf("\n\n# Sam")))).toBe(true);
  });

  it("appends under a named heading", async () => {
    const { json, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    await json("append_note", {
      path: "memory/sam.md",
      content: "Also: no sugar.",
      heading: "Preferences",
    });

    const updated = backend.files.get("memory/sam.md")!;
    expect(updated.indexOf("Also: no sugar.")).toBeLessThan(updated.indexOf("## History"));
  });

  it("errors helpfully when the named heading does not exist", async () => {
    const { call, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    const result = await call("append_note", {
      path: "memory/sam.md",
      content: "x",
      heading: "Nope",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Existing headings/);
  });

  it("creates a note with the heading when one is requested", async () => {
    const { json, backend } = setup();
    await json("append_note", { path: "memory/sam.md", content: "Tea.", heading: "Preferences" });

    expect(backend.files.get("memory/sam.md")).toContain("## Preferences");
  });

  it("surfaces a write conflict as a loud error", async () => {
    const { call, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    // A human edits the note between Betty's read and her write.
    const original = backend.read.bind(backend);
    jest.spyOn(backend, "read").mockImplementationOnce(async (path: string) => {
      const snapshot = await original(path);
      backend.seed(path, `${SAM_NOTE}\nEdited by a human.\n`);
      return snapshot;
    });

    const result = await call("append_note", { path: "memory/sam.md", content: "Betty's line." });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/changed since Betty last read it/);
    expect(backend.files.get("memory/sam.md")).toContain("Edited by a human.");
    expect(backend.files.get("memory/sam.md")).not.toContain("Betty's line.");
  });
});

describe("replace_section", () => {
  it("replaces only the targeted section", async () => {
    const { json, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    const result = await json("replace_section", {
      path: "memory/sam.md",
      heading: "History",
      content: "Met in 2023.",
    });

    expect(result.replaced).toBe(true);
    const updated = backend.files.get("memory/sam.md")!;
    expect(updated).toContain("Met in 2023.");
    expect(updated).not.toContain("Met in 2024.");
    expect(updated).toContain("Tea, not coffee.");
  });

  it("refuses a heading that does not exist and lists the ones that do", async () => {
    const { call, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    const result = await call("replace_section", {
      path: "memory/sam.md",
      heading: "Nonexistent",
      content: "x",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/"Preferences"/);
    expect(result.content[0].text).toMatch(/"History"/);
    expect(backend.files.get("memory/sam.md")).toBe(SAM_NOTE);
  });

  it("does not create a note that is missing", async () => {
    const { call, backend } = setup();
    const result = await call("replace_section", {
      path: "memory/nope.md",
      heading: "H",
      content: "x",
    });

    expect(result.isError).toBe(true);
    expect(backend.files.size).toBe(0);
  });

  it("surfaces a write conflict rather than clobbering", async () => {
    const { call, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    const original = backend.read.bind(backend);
    jest.spyOn(backend, "read").mockImplementationOnce(async (path: string) => {
      const snapshot = await original(path);
      backend.seed(path, SAM_NOTE.replace("Met in 2024.", "Met in 2025, per the user."));
      return snapshot;
    });

    const result = await call("replace_section", {
      path: "memory/sam.md",
      heading: "History",
      content: "Met in 2023.",
    });

    expect(result.isError).toBe(true);
    expect(backend.files.get("memory/sam.md")).toContain("Met in 2025, per the user.");
  });
});

describe("get_note", () => {
  it("returns body, title, type and headings", async () => {
    const { json, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    const result = await json("get_note", { path: "memory/sam.md" });

    expect(result.title).toBe("Sam Taylor");
    expect(result.type).toBe("person");
    // Headings are returned so the model can call replace_section without guessing.
    expect(result.headings).toEqual(["Sam Taylor", "Preferences", "History"]);
    expect(result.body).toContain("Tea, not coffee.");
  });

  it("omits the etag from the lean response", async () => {
    const { json, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    expect(await json("get_note", { path: "memory/sam.md" })).not.toHaveProperty("etag");
  });

  it("includes frontmatter and etag when verbose", async () => {
    const { json, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    const result = await json("get_note", { path: "memory/sam.md", verbose: true });

    expect(result.frontmatter.type).toBe("person");
    expect(result.etag).toBeDefined();
  });

  it("errors for a missing note", async () => {
    const { call } = setup();
    const result = await call("get_note", { path: "memory/nope.md" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Note not found/);
  });
});

describe("search_notes", () => {
  function seedTree(backend: MemoryBackend) {
    backend.seed(
      "index.md",
      "# Notes\n\n- [Sam Taylor](memory/people/sam.md)\n- [Project Betty](projects/betty.md)\n"
    );
    backend.seed("memory/people/sam.md", SAM_NOTE);
    backend.seed(
      "projects/betty.md",
      "---\ntype: project\ntitle: Betty\ndescription: The assistant layer\n---\n\n# Betty\n\nShips memory over WebDAV.\n"
    );
    backend.seed("journal/2026-08-17.md", "# Today\n\nDiscussed espresso machines.\n");
  }

  it("finds notes linked from index.md and marks them as curated hits", async () => {
    const { json, backend } = setup();
    seedTree(backend);

    const result = await json("search_notes", { query: "Sam Taylor" });

    expect(result.results).toContainEqual(
      expect.objectContaining({ path: "memory/people/sam.md", matchedOn: "index" })
    );
  });

  it("matches on filename without reading bodies", async () => {
    const { json, backend } = setup();
    seedTree(backend);

    const result = await json("search_notes", { query: "betty" });

    expect(result.results.some((r: { path: string }) => r.path === "projects/betty.md")).toBe(true);
  });

  it("reports that bodies were not searched by default", async () => {
    const { json, backend } = setup();
    seedTree(backend);

    expect(await json("search_notes", { query: "espresso" })).toMatchObject({
      searchedBodies: false,
      results: [],
    });
  });

  it("finds body text when content is requested", async () => {
    const { json, backend } = setup();
    seedTree(backend);

    const result = await json("search_notes", { query: "espresso", content: true });

    expect(result.results).toContainEqual(
      expect.objectContaining({ path: "journal/2026-08-17.md", matchedOn: "body" })
    );
    expect(result.results[0].snippet).toContain("espresso");
  });

  it("matches frontmatter description when content is requested", async () => {
    const { json, backend } = setup();
    seedTree(backend);

    const result = await json("search_notes", { query: "assistant layer", content: true });

    expect(result.results).toContainEqual(
      expect.objectContaining({ path: "projects/betty.md", matchedOn: "frontmatter" })
    );
  });

  it("requires every term to match", async () => {
    const { json, backend } = setup();
    seedTree(backend);

    const result = await json("search_notes", { query: "espresso unicorn", content: true });
    expect(result.results).toEqual([]);
  });

  it("scopes to a subdirectory", async () => {
    const { json, backend } = setup();
    seedTree(backend);

    const result = await json("search_notes", { query: "e", dir: "journal", content: true });

    expect(result.results.every((r: { path: string }) => r.path.startsWith("journal/"))).toBe(true);
  });

  it("flags truncation instead of silently returning a partial answer", async () => {
    const { json, backend } = setup({ maxContentFiles: 1 });
    seedTree(backend);

    const result = await json("search_notes", { query: "e", content: true });

    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toMatch(/Stopped after reading 1 files/);
  });

  it("reports how many results were held back by the limit", async () => {
    const { json, backend } = setup();
    seedTree(backend);

    const result = await json("search_notes", { query: "e", content: true, limit: 1 });

    expect(result.results).toHaveLength(1);
    expect(result.moreResults).toBeGreaterThan(0);
  });

  it("ranks curated index hits above filename matches", async () => {
    const { json, backend } = setup();
    backend.seed("index.md", "- [betty](projects/betty.md)\n");
    backend.seed("projects/betty.md", "# Betty\n");
    backend.seed("betty-notes.md", "# Other\n");

    const result = await json("search_notes", { query: "betty" });

    expect(result.results[0].matchedOn).toBe("index");
  });

  it("ignores external links in an index", async () => {
    const { json, backend } = setup();
    backend.seed("index.md", "- [betty](https://example.com/betty)\n");

    const result = await json("search_notes", { query: "betty" });
    expect(
      result.results.every((r: { path: string }) => !r.path.startsWith("https"))
    ).toBe(true);
  });
});

describe("change log", () => {
  it("records creates and appends in log.md", async () => {
    const { json, backend } = setup({ writeLog: true });

    await json("append_note", { path: "memory/sam.md", content: "one" });
    await json("append_note", { path: "memory/sam.md", content: "two" });

    const log = backend.files.get("memory/log.md")!;
    expect(log).toContain("`create` [memory/sam.md]");
    expect(log).toContain("`append` [memory/sam.md]");
  });

  it("puts the log inside the memory root, not a hidden folder", async () => {
    // A dot-prefixed folder would be invisible to the user in Obsidian.
    const { json, backend } = setup({ writeLog: true });
    await json("append_note", { path: "memory/sam.md", content: "one" });

    expect([...backend.files.keys()].some((k) => k.split("/").some((s) => s.startsWith(".")))).toBe(
      false
    );
  });

  it("can be turned off", async () => {
    const { json, backend } = setup({ writeLog: false });
    await json("append_note", { path: "memory/sam.md", content: "one" });

    expect(backend.files.has("memory/log.md")).toBe(false);
  });

  it("reports a log failure as a warning without failing the note write", async () => {
    const { json, backend } = setup({ writeLog: true });
    jest.spyOn(backend, "write").mockImplementation(async (path: string, text: string, ifMatch?: string) => {
      if (path.endsWith("log.md")) throw new Error("log storage is full");
      return MemoryBackend.prototype.write.call(backend, path, text, ifMatch);
    });

    const result = await json("append_note", { path: "memory/sam.md", content: "one" });

    expect(result.created).toBe(true);
    expect(result.warning).toMatch(/change log could not be updated/);
  });
});
