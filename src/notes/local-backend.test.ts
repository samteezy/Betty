import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalNotesBackend } from "./local-backend";
import { NoteConflictError, NoteNotFoundError } from "./errors";

let root: string;
let backend: LocalNotesBackend;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "betty-notes-"));
  backend = new LocalNotesBackend(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("connect()", () => {
  it("accepts an existing directory", async () => {
    await expect(backend.connect()).resolves.toBeUndefined();
  });

  it("rejects a missing root with an actionable message", async () => {
    await expect(new LocalNotesBackend(join(root, "nope")).connect()).rejects.toThrow(
      /NOTES_ROOT does not exist/
    );
  });

  it("rejects a root that is a file", async () => {
    await writeFile(join(root, "file.md"), "x");
    await expect(new LocalNotesBackend(join(root, "file.md")).connect()).rejects.toThrow(
      /not a directory/
    );
  });
});

describe("list()", () => {
  it("lists files and directories one level deep", async () => {
    await mkdir(join(root, "memory"));
    await writeFile(join(root, "index.md"), "# Index");

    const entries = await backend.list("");

    expect(entries.map((e) => [e.path, e.isDirectory])).toEqual([
      ["index.md", false],
      ["memory", true],
    ]);
  });

  it("reports size, modified, and etag for files", async () => {
    await writeFile(join(root, "note.md"), "hello");
    const [entry] = await backend.list("");

    expect(entry.size).toBe(5);
    expect(entry.etag).toMatch(/^W\/"\d+-5"$/);
    expect(entry.modified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("skips dot-prefixed entries", async () => {
    await mkdir(join(root, ".obsidian"));
    await writeFile(join(root, "real.md"), "x");

    expect((await backend.list("")).map((e) => e.name)).toEqual(["real.md"]);
  });

  it("returns an empty listing for a missing directory", async () => {
    await expect(backend.list("nope")).resolves.toEqual([]);
  });

  it("returns nested paths relative to the root", async () => {
    await mkdir(join(root, "memory", "people"), { recursive: true });
    await writeFile(join(root, "memory", "people", "sam.md"), "x");

    expect((await backend.list("memory/people"))[0].path).toBe("memory/people/sam.md");
  });
});

describe("read()", () => {
  it("returns text and an etag", async () => {
    await writeFile(join(root, "note.md"), "# Note");
    const result = await backend.read("note.md");

    expect(result.text).toBe("# Note");
    expect(result.etag).toBeDefined();
  });

  it("throws NoteNotFoundError for a missing file", async () => {
    await expect(backend.read("nope.md")).rejects.toBeInstanceOf(NoteNotFoundError);
  });

  it("throws NoteNotFoundError for a directory", async () => {
    await mkdir(join(root, "dir"));
    await expect(backend.read("dir")).rejects.toBeInstanceOf(NoteNotFoundError);
  });

  it("refuses to read outside the root", async () => {
    // The tool layer validates first; this is the backend's own backstop.
    await expect(backend.read("../escape.md")).rejects.toThrow(/escapes NOTES_ROOT/);
  });
});

describe("write() — create", () => {
  it("creates a new file", async () => {
    await backend.write("memory/sam.md", "# Sam");

    expect(await readFile(join(root, "memory", "sam.md"), "utf8")).toBe("# Sam");
  });

  it("creates missing parent directories", async () => {
    await backend.write("memory/people/deep/sam.md", "x");
    await expect(backend.read("memory/people/deep/sam.md")).resolves.toMatchObject({ text: "x" });
  });

  it("returns an etag usable for the next conditional write", async () => {
    const { etag } = await backend.write("note.md", "one");
    await expect(backend.write("note.md", "two!", etag)).resolves.toBeDefined();
  });

  it("refuses to overwrite an existing file", async () => {
    await backend.write("note.md", "original");

    await expect(backend.write("note.md", "clobbered")).rejects.toBeInstanceOf(NoteConflictError);
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("original");
  });

  it("points at get_note when the file already exists", async () => {
    await backend.write("note.md", "original");
    await expect(backend.write("note.md", "x")).rejects.toThrow(/Read it with get_note first/);
  });
});

describe("write() — conditional update", () => {
  it("succeeds when the etag still matches", async () => {
    await backend.write("note.md", "one");
    const current = await backend.read("note.md");

    await backend.write("note.md", "two!", current.etag);

    expect(await readFile(join(root, "note.md"), "utf8")).toBe("two!");
  });

  it("throws NoteConflictError when the file changed underneath", async () => {
    await backend.write("note.md", "one");
    const stale = await backend.read("note.md");

    // Simulate a human editing the note in Obsidian. Different length, so the
    // synthesized mtime+size etag differs regardless of clock resolution.
    await writeFile(join(root, "note.md"), "edited by a human");

    await expect(backend.write("note.md", "betty's version", stale.etag)).rejects.toBeInstanceOf(
      NoteConflictError
    );
  });

  it("leaves the human's edit intact after a conflict", async () => {
    await backend.write("note.md", "one");
    const stale = await backend.read("note.md");
    await writeFile(join(root, "note.md"), "edited by a human");

    await expect(backend.write("note.md", "betty's version", stale.etag)).rejects.toThrow();

    expect(await readFile(join(root, "note.md"), "utf8")).toBe("edited by a human");
  });

  it("throws NoteNotFoundError when updating something that is gone", async () => {
    await expect(backend.write("gone.md", "x", 'W/"1-1"')).rejects.toBeInstanceOf(
      NoteNotFoundError
    );
  });

  it("leaves no temp files behind", async () => {
    await backend.write("note.md", "one");
    const current = await backend.read("note.md");
    await backend.write("note.md", "two!", current.etag);

    const names = (await backend.list("")).map((e) => e.name);
    expect(names.some((n) => n.includes(".tmp"))).toBe(false);
  });

  it("refuses to write outside the root", async () => {
    await expect(backend.write("../escape.md", "x")).rejects.toThrow(/escapes NOTES_ROOT/);
  });
});

describe("move()", () => {
  it("moves a file and leaves nothing at the source", async () => {
    await writeFile(join(root, "sam.md"), "# Sam");

    await backend.move("sam.md", "people/sam.md");

    expect(await readFile(join(root, "people/sam.md"), "utf8")).toBe("# Sam");
    await expect(readFile(join(root, "sam.md"), "utf8")).rejects.toThrow();
  });

  it("creates missing parent directories", async () => {
    await writeFile(join(root, "sam.md"), "# Sam");

    await backend.move("sam.md", "trash/2026/sam.md");

    expect(await readFile(join(root, "trash/2026/sam.md"), "utf8")).toBe("# Sam");
  });

  it("refuses an existing destination and leaves its bytes intact", async () => {
    // rename(2) silently replaces the destination, so asserting only that it
    // threw would miss a clobber. The surviving bytes are the real assertion.
    await writeFile(join(root, "sam.md"), "# Sam");
    await writeFile(join(root, "other.md"), "# Someone else");

    await expect(backend.move("sam.md", "other.md")).rejects.toThrow(NoteConflictError);

    expect(await readFile(join(root, "other.md"), "utf8")).toBe("# Someone else");
    expect(await readFile(join(root, "sam.md"), "utf8")).toBe("# Sam");
  });

  it("leaves no placeholder behind when it refuses", async () => {
    await writeFile(join(root, "sam.md"), "# Sam");
    await writeFile(join(root, "other.md"), "# Someone else");

    await expect(backend.move("sam.md", "other.md")).rejects.toThrow();

    expect((await backend.list("")).map((e) => e.name).sort()).toEqual(["other.md", "sam.md"]);
  });

  it("throws NoteNotFoundError for a missing source", async () => {
    await expect(backend.move("nope.md", "trash/nope.md")).rejects.toThrow(NoteNotFoundError);
  });

  it("throws NoteNotFoundError when the source is a directory", async () => {
    await mkdir(join(root, "folder"));

    await expect(backend.move("folder", "trash/folder")).rejects.toThrow(NoteNotFoundError);
  });

  it("refuses a move onto itself", async () => {
    await writeFile(join(root, "sam.md"), "# Sam");

    await expect(backend.move("sam.md", "sam.md")).rejects.toThrow(NoteConflictError);
    expect(await readFile(join(root, "sam.md"), "utf8")).toBe("# Sam");
  });

  it("refuses to move outside the root", async () => {
    await writeFile(join(root, "sam.md"), "# Sam");

    await expect(backend.move("sam.md", "../escape.md")).rejects.toThrow(/escapes NOTES_ROOT/);
    await expect(backend.move("../escape.md", "sam2.md")).rejects.toThrow(/escapes NOTES_ROOT/);
  });

  it("moves the etag with the file", async () => {
    await writeFile(join(root, "sam.md"), "# Sam");
    const before = (await backend.read("sam.md")).etag;

    await backend.move("sam.md", "people/sam.md");

    expect((await backend.read("people/sam.md")).etag).toBe(before);
  });
});

describe("move() when both paths are the same file", () => {
  it("renames rather than reporting a conflict", async () => {
    // Stands in for a case-only rename on APFS/NTFS, where the destination
    // resolves to the same inode as the source and the exclusive-create
    // placeholder would otherwise report "already exists". A hard link
    // reproduces that condition on any filesystem.
    const { link } = await import("node:fs/promises");
    await writeFile(join(root, "Priya.md"), "# Priya");
    await link(join(root, "Priya.md"), join(root, "priya.md"));

    await expect(backend.move("Priya.md", "priya.md")).resolves.toBeUndefined();
    expect(await readFile(join(root, "priya.md"), "utf8")).toBe("# Priya");
  });

  it("still refuses a genuinely different file at the destination", async () => {
    await writeFile(join(root, "a.md"), "# A");
    await writeFile(join(root, "b.md"), "# B");

    await expect(backend.move("a.md", "b.md")).rejects.toThrow(NoteConflictError);
    expect(await readFile(join(root, "b.md"), "utf8")).toBe("# B");
  });
});
