import { DEFAULT_MAX_DEPTH, isMarkdown, walkNotes } from "./walk";
import { NoteEntry, NotesBackend } from "../types";

/** Backend whose tree is derived from a flat list of file paths. */
function treeBackend(paths: string[]): NotesBackend & { listCalls: string[] } {
  const listCalls: string[] = [];
  return {
    listCalls,
    async connect() {},
    async read() {
      throw new Error("not used");
    },
    async write() {
      throw new Error("not used");
    },
    async list(dir: string): Promise<NoteEntry[]> {
      listCalls.push(dir);
      const prefix = dir ? `${dir}/` : "";
      const seen = new Map<string, NoteEntry>();
      for (const path of paths) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (!rest) continue;
        const [head, ...tail] = rest.split("/");
        const childPath = `${prefix}${head}`;
        if (!seen.has(childPath)) {
          seen.set(childPath, { path: childPath, name: head, isDirectory: tail.length > 0 });
        }
      }
      return [...seen.values()];
    },
  };
}

describe("walkNotes()", () => {
  it("collects files across the whole tree", async () => {
    const backend = treeBackend(["index.md", "memory/sam.md", "memory/people/alex.md"]);

    const result = await walkNotes(backend, "");

    expect(result.files.map((f) => f.path).sort()).toEqual([
      "index.md",
      "memory/people/alex.md",
      "memory/sam.md",
    ]);
    expect(result.truncated).toBe(false);
  });

  it("records directories separately from files", async () => {
    const backend = treeBackend(["memory/sam.md"]);

    expect((await walkNotes(backend, "")).directories).toEqual(["memory"]);
  });

  it("starts from the given subdirectory", async () => {
    const backend = treeBackend(["journal/a.md", "memory/sam.md"]);

    const result = await walkNotes(backend, "memory");

    expect(result.files.map((f) => f.path)).toEqual(["memory/sam.md"]);
    expect(backend.listCalls).toEqual(["memory"]);
  });

  it("reports truncation when the directory budget runs out", async () => {
    // A bounded walk must never read as an exhaustive one.
    const backend = treeBackend(["a/1.md", "b/2.md", "c/3.md"]);

    const result = await walkNotes(backend, "", { maxDirectories: 2 });

    expect(result.truncated).toBe(true);
    expect(backend.listCalls).toHaveLength(2);
  });

  it("reports truncation when the depth budget runs out", async () => {
    const backend = treeBackend(["a/b/c/deep.md"]);

    const result = await walkNotes(backend, "", { maxDepth: 1 });

    expect(result.truncated).toBe(true);
    expect(result.files).toEqual([]);
  });

  it("does not truncate a tree that fits", async () => {
    const backend = treeBackend(["a/b/c/deep.md"]);

    expect((await walkNotes(backend, "", { maxDepth: DEFAULT_MAX_DEPTH })).truncated).toBe(false);
  });

  it("visits each directory once", async () => {
    const backend = treeBackend(["memory/a.md", "memory/b.md", "memory/sub/c.md"]);

    await walkNotes(backend, "");

    expect(backend.listCalls).toEqual(["", "memory", "memory/sub"]);
  });
});

describe("isMarkdown()", () => {
  const entry = (name: string, isDirectory = false): NoteEntry => ({
    path: name,
    name,
    isDirectory,
  });

  it("accepts .md and .mdx", () => {
    expect(isMarkdown(entry("a.md"))).toBe(true);
    expect(isMarkdown(entry("a.mdx"))).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isMarkdown(entry("A.MD"))).toBe(true);
  });

  it("rejects other extensions and directories", () => {
    expect(isMarkdown(entry("a.txt"))).toBe(false);
    expect(isMarkdown(entry("memory", true))).toBe(false);
  });
});
