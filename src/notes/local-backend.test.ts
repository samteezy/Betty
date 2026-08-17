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
