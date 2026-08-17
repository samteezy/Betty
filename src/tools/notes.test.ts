import { registerNotesTools, NotesToolConfig } from "./notes";
import { harness } from "../test-support/mcp";
import { MemoryNotesBackend } from "../test-support/backends";
import { withEnv } from "../test-support/env";

const CONFIG: NotesToolConfig = {
  notesRoot: "/notes",
  memoryPrefix: "memory",
  deskPrefix: "desk",
  trashPrefix: "trash",
  writeLog: false,
  writeUnfiled: false,
  now: () => new Date("2026-08-17T10:00:00.000Z"),
};

function setup(config: Partial<NotesToolConfig> = {}) {
  const backend = new MemoryNotesBackend();
  const h = harness((server) =>
    registerNotesTools(server, backend, { ...CONFIG, ...config })
  );
  return { backend, ...h };
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
  it("registers all five memory tools", () => {
    const { tools } = setup();
    expect([...tools.keys()].sort()).toEqual([
      "append_memory",
      "get_note",
      "move_memory",
      "replace_memory_section",
      "search_notes",
    ]);
  });

  it("registers no whole-file write or delete tool", () => {
    // The absence is the safety mechanism — don't add one. move_memory does
    // not weaken it: nothing is destroyed, retiring a memory means moving it
    // into trash, and a move refuses a destination that already exists.
    const { tools } = setup();
    for (const name of [
      "write_note",
      "put_note",
      "create_note",
      "delete_note",
      "save_note",
      "remove_note",
      "delete_memory",
    ]) {
      expect(tools.has(name)).toBe(false);
    }
  });

  it("registers no skill tool — skills are a separate write scope", () => {
    const { tools } = setup();
    expect(tools.has("append_skill")).toBe(false);
    expect(tools.has("replace_skill_section")).toBe(false);
  });

  it("honours DISABLED_TOOLS", () => {
    const { tools } = withEnv(
      { DISABLED_TOOLS: "append_memory, move_memory" },
      () => setup()
    );

    expect(tools.has("append_memory")).toBe(false);
    expect(tools.has("move_memory")).toBe(false);
    expect(tools.has("get_note")).toBe(true);
  });

  it("ignores an unrecognized DISABLED_TOOLS entry that names an Object property", () => {
    // The rename table is a Map, not an object literal: a plain object would
    // resolve "constructor" off Object.prototype, and iterating a function
    // throws — at registration time, so the server would fail to start.
    for (const name of ["constructor", "toString", "valueOf", "__proto__"]) {
      const { tools } = withEnv({ DISABLED_TOOLS: name }, () => setup());
      expect(tools.has("append_memory")).toBe(true);
    }
  });

  it("honours the pre-0.4 tool names in DISABLED_TOOLS", () => {
    // A config written against append_note must keep disabling writes across
    // the rename, rather than silently re-enabling them.
    const { tools } = withEnv(
      { DISABLED_TOOLS: "append_note, replace_section" },
      () => setup()
    );

    expect(tools.has("append_memory")).toBe(false);
    expect(tools.has("replace_memory_section")).toBe(false);
    expect(tools.has("get_note")).toBe(true);
  });
});

describe("write scope guard", () => {
  it("rejects append_note outside Betty's own roots", async () => {
    const { call, backend } = setup();
    const result = await call("append_memory", { path: "journal/today.md", content: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Refusing to write outside Betty's own roots/);
    expect(backend.files.size).toBe(0);
  });

  it("rejects a write to the skills root — that is append_skill's job", async () => {
    // A tool named for memory must not be able to silently produce a skill.
    const { call, backend } = setup();
    const result = await call("append_memory", {
      path: "skills/inbox-triage/SKILL.md",
      content: "x",
      description: "y",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Refusing to write outside Betty's own roots/);
    expect(backend.files.size).toBe(0);
  });

  it("allows writes to the desk and trash roots", async () => {
    const { json, backend } = setup();

    await json("append_memory", { path: "desk/backlog.md", content: "Ask about the migration." });
    await json("append_memory", { path: "trash/old.md", content: "x" });

    expect(backend.files.has("desk/backlog.md")).toBe(true);
    expect(backend.files.has("trash/old.md")).toBe(true);
  });

  it("rejects replace_section outside the memory root", async () => {
    const { call, backend } = setup();
    backend.seed("journal/today.md", "# T\n\n## Notes\n\nold\n");

    const result = await call("replace_memory_section", {
      path: "journal/today.md",
      heading: "Notes",
      content: "new",
    });

    expect(result.isError).toBe(true);
    expect(backend.files.get("journal/today.md")).toContain("old");
  });

  it("rejects a traversal that lands outside Betty's own roots", async () => {
    // Normalizes to "journal/x.md" — the guard runs after normalization.
    const { call } = setup();
    const result = await call("append_memory", { path: "memory/../journal/x.md", content: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Refusing to write outside Betty's own roots/);
  });

  it("rejects a traversal that escapes the notes root entirely", async () => {
    const { call } = setup();
    const result = await call("append_memory", { path: "../../etc/passwd.md", content: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/escapes the notes root/);
  });

  it("rejects an absolute path", async () => {
    const { call } = setup();
    const result = await call("append_memory", { path: "/etc/passwd.md", content: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/must be relative/);
  });

  it("rejects a name-prefixed sibling of the memory root", async () => {
    const { call } = setup();
    const result = await call("append_memory", { path: "memory-old/sam.md", content: "x" });

    expect(result.isError).toBe(true);
  });

  it("allows a write inside the memory root", async () => {
    const { json, backend } = setup();
    const result = await json("append_memory", { path: "memory/people/sam.md", content: "hello" });

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
    const result = await call("append_memory", { path: "memory/data.json", content: "{}" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/should end in \.md/);
  });

  it("adds .md when the path has no extension", async () => {
    const { json } = setup();
    const result = await json("append_memory", { path: "memory/sam", content: "x" });

    expect(result.path).toBe("memory/sam.md");
  });
});

describe("append_memory", () => {
  it("creates a note with all four required OKF keys", async () => {
    const { json, backend } = setup();
    await json("append_memory", { path: "memory/sam.md", content: "Likes tea." });

    const text = backend.files.get("memory/sam.md")!;
    expect(text).toContain("type: note");
    expect(text).toContain("title: Sam");
    expect(text).toContain("description: Sam");
    expect(text).toContain("timestamp: 2026-08-17T10:00:00Z");
  });

  it("tags created notes with source: betty for bulk grep and delete", async () => {
    const { json, backend } = setup();
    await json("append_memory", { path: "memory/sam.md", content: "x" });

    expect(backend.files.get("memory/sam.md")).toContain("source: betty");
  });

  it("derives a readable title from the filename", async () => {
    const { json, backend } = setup();
    await json("append_memory", { path: "memory/people/sam-taylor.md", content: "x" });

    expect(backend.files.get("memory/people/sam-taylor.md")).toContain("title: Sam taylor");
  });

  it("uses an explicit title when given", async () => {
    const { json, backend } = setup();
    await json("append_memory", { path: "memory/sam.md", content: "x", title: "Sam Taylor" });

    expect(backend.files.get("memory/sam.md")).toContain("title: Sam Taylor");
  });

  it("appends to an existing note", async () => {
    const { json, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    const result = await json("append_memory", { path: "memory/sam.md", content: "New fact." });

    expect(result.created).toBe(false);
    expect(backend.files.get("memory/sam.md")).toContain("New fact.");
    expect(backend.files.get("memory/sam.md")).toContain("Met in 2024.");
  });

  it("leaves existing frontmatter byte-for-byte untouched", async () => {
    const { json, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    await json("append_memory", { path: "memory/sam.md", content: "New fact." });

    const updated = backend.files.get("memory/sam.md")!;
    expect(updated.startsWith(SAM_NOTE.slice(0, SAM_NOTE.indexOf("\n\n# Sam")))).toBe(true);
  });

  it("appends under a named heading", async () => {
    const { json, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    await json("append_memory", {
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

    const result = await call("append_memory", {
      path: "memory/sam.md",
      content: "x",
      heading: "Nope",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Existing headings/);
  });

  it("creates a note with the heading when one is requested", async () => {
    const { json, backend } = setup();
    await json("append_memory", { path: "memory/sam.md", content: "Tea.", heading: "Preferences" });

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

    const result = await call("append_memory", { path: "memory/sam.md", content: "Betty's line." });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/changed since Betty last read it/);
    expect(backend.files.get("memory/sam.md")).toContain("Edited by a human.");
    expect(backend.files.get("memory/sam.md")).not.toContain("Betty's line.");
  });
});

describe("replace_memory_section", () => {
  it("replaces only the targeted section", async () => {
    const { json, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    const result = await json("replace_memory_section", {
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

    const result = await call("replace_memory_section", {
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
    const result = await call("replace_memory_section", {
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

    const result = await call("replace_memory_section", {
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
  function seedTree(backend: MemoryNotesBackend) {
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

    await json("append_memory", { path: "memory/sam.md", content: "one" });
    await json("append_memory", { path: "memory/sam.md", content: "two" });

    const log = backend.files.get("desk/log.md")!;
    expect(log).toContain("`create` [memory/sam.md]");
    expect(log).toContain("`append` [memory/sam.md]");
  });

  it("puts the log on the desk, out of the searchable memory root", async () => {
    // log.md is bookkeeping. Under MEMORY_ROOT it would compete with real
    // memories on every content search — thousands of path strings that match
    // almost anything.
    const { json, backend } = setup({ writeLog: true });
    await json("append_memory", { path: "memory/sam.md", content: "one" });

    expect(backend.files.has("desk/log.md")).toBe(true);
    expect(backend.files.has("memory/log.md")).toBe(false);
  });

  it("puts the log in a visible folder, not a hidden one", async () => {
    // A dot-prefixed folder would be invisible to the user in Obsidian.
    const { json, backend } = setup({ writeLog: true });
    await json("append_memory", { path: "memory/sam.md", content: "one" });

    expect([...backend.files.keys()].some((k) => k.split("/").some((s) => s.startsWith(".")))).toBe(
      false
    );
  });

  it("records moves against the destination", async () => {
    const { json, backend } = setup({ writeLog: true });
    backend.seed("memory/sam.md", SAM_NOTE);

    await json("move_memory", { from: "memory/sam.md", to: "trash/sam.md" });

    // The link should point at a file that still exists.
    expect(backend.files.get("desk/log.md")).toContain("`move` [trash/sam.md]");
  });

  it("can be turned off", async () => {
    const { json, backend } = setup({ writeLog: false });
    await json("append_memory", { path: "memory/sam.md", content: "one" });

    expect(backend.files.has("desk/log.md")).toBe(false);
  });

  it("reports a log failure as a warning without failing the note write", async () => {
    const { json, backend } = setup({ writeLog: true });
    jest.spyOn(backend, "write").mockImplementation(async (path: string, text: string, ifMatch?: string) => {
      if (path.endsWith("log.md")) throw new Error("log storage is full");
      return MemoryNotesBackend.prototype.write.call(backend, path, text, ifMatch);
    });

    const result = await json("append_memory", { path: "memory/sam.md", content: "one" });

    expect(result.created).toBe(true);
    expect(result.warning).toMatch(/change log could not be updated/);
  });
});

describe("move_memory", () => {
  it("moves a memory and leaves nothing behind", async () => {
    const { json, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    const result = await json("move_memory", {
      from: "memory/sam.md",
      to: "memory/people/sam.md",
    });

    expect(result).toMatchObject({ from: "memory/sam.md", to: "memory/people/sam.md", moved: true });
    expect(backend.files.has("memory/sam.md")).toBe(false);
    expect(backend.files.get("memory/people/sam.md")).toBe(SAM_NOTE);
    expect(backend.moves).toEqual([{ from: "memory/sam.md", to: "memory/people/sam.md" }]);
  });

  it("retires a memory into trash", async () => {
    const { json, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    await json("move_memory", { from: "memory/sam.md", to: "trash/sam.md" });

    expect(backend.files.get("trash/sam.md")).toBe(SAM_NOTE);
  });

  it("refuses a destination outside Betty's own roots", async () => {
    // The exfiltration guard. Checking only the source would let a memory be
    // moved out into the user's own vault.
    const { call, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    const result = await call("move_memory", { from: "memory/sam.md", to: "journal/sam.md" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Refusing to write outside Betty's own roots/);
    expect(backend.files.has("memory/sam.md")).toBe(true);
    expect(backend.moves).toEqual([]);
  });

  it("refuses a source outside Betty's own roots", async () => {
    // And checking only the destination would let one of the user's own notes
    // be relocated into Betty's storage.
    const { call, backend } = setup();
    backend.seed("journal/today.md", "# Today\n");

    const result = await call("move_memory", { from: "journal/today.md", to: "memory/today.md" });

    expect(result.isError).toBe(true);
    expect(backend.files.has("journal/today.md")).toBe(true);
    expect(backend.moves).toEqual([]);
  });

  it("refuses to move into the skills root", async () => {
    const { call, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    const result = await call("move_memory", {
      from: "memory/sam.md",
      to: "skills/sam/SKILL.md",
    });

    expect(result.isError).toBe(true);
    expect(backend.moves).toEqual([]);
  });

  it("refuses to overwrite an existing destination", async () => {
    const { call, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);
    backend.seed("memory/people/sam.md", "# Someone else\n");

    const result = await call("move_memory", {
      from: "memory/sam.md",
      to: "memory/people/sam.md",
    });

    expect(result.isError).toBe(true);
    expect(backend.files.get("memory/people/sam.md")).toBe("# Someone else\n");
    expect(backend.files.has("memory/sam.md")).toBe(true);
  });

  it("refuses a move to where it already is", async () => {
    const { call, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    const result = await call("move_memory", { from: "memory/sam.md", to: "memory/sam" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/already where it is/);
  });

  it("errors for a source that does not exist", async () => {
    const { call } = setup();
    const result = await call("move_memory", { from: "memory/nope.md", to: "trash/nope.md" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Note not found/);
  });

  it("names which argument was bad", async () => {
    const { call } = setup();

    const badFrom = await call("move_memory", { from: "/etc/passwd.md", to: "trash/x.md" });
    expect(badFrom.content[0].text).toMatch(/from must be relative/);

    const badTo = await call("move_memory", { from: "memory/sam.md", to: "/etc/passwd.md" });
    expect(badTo.content[0].text).toMatch(/to must be relative/);
  });

  it("adds .md to both paths", async () => {
    const { json, backend } = setup();
    backend.seed("memory/sam.md", SAM_NOTE);

    const result = await json("move_memory", { from: "memory/sam", to: "trash/sam" });

    expect(result).toMatchObject({ from: "memory/sam.md", to: "trash/sam.md" });
  });
});

describe("unfiled list", () => {
  it("records a created memory as unfiled", async () => {
    const { json, backend } = setup({ writeUnfiled: true });

    await json("append_memory", { path: "memory/sam.md", content: "x", title: "Sam Taylor" });

    const unfiled = backend.files.get("desk/unfiled.md")!;
    expect(unfiled).toContain("## Unprocessed");
    expect(unfiled).toContain("`create` [memory/sam.md]");
    expect(unfiled).toContain("Sam Taylor");
  });

  it("does not record an append to an existing memory", async () => {
    // The unfiled list names memories to file, not a second change log.
    const { json, backend } = setup({ writeUnfiled: true });
    backend.seed("memory/sam.md", SAM_NOTE);

    await json("append_memory", { path: "memory/sam.md", content: "another fact" });

    expect(backend.files.has("desk/unfiled.md")).toBe(false);
  });

  it("records a move so the skill knows to reconcile the index", async () => {
    const { json, backend } = setup({ writeUnfiled: true });
    backend.seed("memory/sam.md", SAM_NOTE);

    await json("move_memory", { from: "memory/sam.md", to: "memory/people/sam.md" });

    expect(backend.files.get("desk/unfiled.md")).toContain("`move` [memory/people/sam.md]");
  });

  it("appends a second entry under the existing heading", async () => {
    const { json, backend } = setup({ writeUnfiled: true });

    await json("append_memory", { path: "memory/a.md", content: "x" });
    await json("append_memory", { path: "memory/b.md", content: "x" });

    const unfiled = backend.files.get("desk/unfiled.md")!;
    expect(unfiled.match(/## Unprocessed/g)).toHaveLength(1);
    expect(unfiled).toContain("memory/a.md");
    expect(unfiled).toContain("memory/b.md");
  });

  it("re-adds the heading rather than erroring when a human removed it", async () => {
    const { json, backend } = setup({ writeUnfiled: true });
    backend.seed("desk/unfiled.md", "---\ntype: log\ntitle: Unfiled\n---\n\n# Unfiled\n\nAll clear.\n");

    const result = await json("append_memory", { path: "memory/sam.md", content: "x" });

    expect(result.warning).toBeUndefined();
    expect(backend.files.get("desk/unfiled.md")).toContain("## Unprocessed");
  });

  it("does not record the desk's own files", async () => {
    // Bookkeeping does not list itself as unfiled.
    const { json, backend } = setup({ writeUnfiled: true });

    await json("append_memory", { path: "desk/backlog.md", content: "Ask about the migration." });

    expect(backend.files.get("desk/unfiled.md")).toBeUndefined();
  });

  it("does not record a memory being retired", async () => {
    const { json, backend } = setup({ writeUnfiled: true });
    backend.seed("memory/sam.md", SAM_NOTE);

    await json("move_memory", { from: "memory/sam.md", to: "trash/sam.md" });

    expect(backend.files.has("desk/unfiled.md")).toBe(false);
  });

  it("can be turned off", async () => {
    const { json, backend } = setup({ writeUnfiled: false });
    await json("append_memory", { path: "memory/sam.md", content: "x" });

    expect(backend.files.has("desk/unfiled.md")).toBe(false);
  });

  it("reports an unfiled-list failure as a warning without failing the memory write", async () => {
    const { json, backend } = setup({ writeUnfiled: true });
    jest.spyOn(backend, "write").mockImplementation(async (path: string, text: string, ifMatch?: string) => {
      if (path.endsWith("unfiled.md")) throw new Error("unfiled storage is full");
      return MemoryNotesBackend.prototype.write.call(backend, path, text, ifMatch);
    });

    const result = await json("append_memory", { path: "memory/sam.md", content: "x" });

    expect(result.created).toBe(true);
    expect(result.warning).toMatch(/the unfiled list could not be updated/);
    expect(backend.files.has("memory/sam.md")).toBe(true);
  });
});

describe("desk and trash are not searched", () => {
  function seedDesk(backend: MemoryNotesBackend) {
    backend.seed("memory/sam.md", "# Sam\n\nEspresso enthusiast.\n");
    backend.seed("desk/log.md", "# Change log\n\n- espresso\n");
    backend.seed("trash/old.md", "# Old\n\nEspresso, retired.\n");
  }

  it("omits desk and trash from an unscoped search", async () => {
    const { json, backend } = setup();
    seedDesk(backend);

    const result = await json("search_notes", { query: "espresso", content: true });

    expect(result.results.map((r: { path: string }) => r.path)).toEqual(["memory/sam.md"]);
  });

  it("searches them when dir points into them", async () => {
    const { json, backend } = setup();
    seedDesk(backend);

    const result = await json("search_notes", { query: "espresso", dir: "trash", content: true });

    expect(result.results.map((r: { path: string }) => r.path)).toEqual(["trash/old.md"]);
  });

  it("still reads a retired memory by path", async () => {
    // Hidden from recall, not unreadable — that is what makes trash a
    // retirement rather than a delete.
    const { json, backend } = setup();
    seedDesk(backend);

    await expect(json("get_note", { path: "trash/old.md" })).resolves.toMatchObject({
      path: "trash/old.md",
    });
  });
});
