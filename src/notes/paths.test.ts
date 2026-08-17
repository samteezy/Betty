import {
  NoteScopeError,
  assertWritable,
  isUnderPrefix,
  joinPath,
  normalizeRoot,
  relativeUnder,
  resolveSubRoot,
  safeRelPath,
} from "./paths";

describe("normalizeRoot()", () => {
  it("strips trailing slashes and collapses duplicates", () => {
    expect(normalizeRoot("/notes//sub/")).toBe("/notes/sub");
  });

  it("preserves a leading slash", () => {
    expect(normalizeRoot("/notes")).toBe("/notes");
  });

  it("keeps relative roots relative", () => {
    expect(normalizeRoot("notes/sub")).toBe("notes/sub");
  });

  it("resolves interior .. segments", () => {
    expect(normalizeRoot("/notes/a/../b")).toBe("/notes/b");
  });

  it("rejects a root that climbs above itself", () => {
    expect(() => normalizeRoot("../escape")).toThrow(NoteScopeError);
  });
});

describe("safeRelPath()", () => {
  it("normalizes a plain relative path", () => {
    expect(safeRelPath("memory/people/sam.md")).toBe("memory/people/sam.md");
  });

  it("collapses redundant segments", () => {
    expect(safeRelPath("memory/./people//sam.md")).toBe("memory/people/sam.md");
  });

  it("allows interior .. that stays inside the root", () => {
    expect(safeRelPath("memory/people/../sam.md")).toBe("memory/sam.md");
  });

  it("rejects paths that escape the root", () => {
    expect(() => safeRelPath("../etc/passwd")).toThrow(/escapes the notes root/);
  });

  it("rejects paths that escape via a deeper traversal", () => {
    expect(() => safeRelPath("memory/../../etc/passwd")).toThrow(/escapes the notes root/);
  });

  it("rejects absolute paths", () => {
    expect(() => safeRelPath("/etc/passwd")).toThrow(/must be relative/);
  });

  it("rejects backslash-separated absolute paths", () => {
    expect(() => safeRelPath("\\windows\\system32")).toThrow(/must be relative/);
  });

  it("rejects URLs", () => {
    expect(() => safeRelPath("https://example.com/evil.md")).toThrow(/not a URL/);
  });

  it("rejects null bytes", () => {
    expect(() => safeRelPath("memory/sam\0.md")).toThrow(/invalid character/);
  });

  it("uses the supplied label in the error", () => {
    expect(() => safeRelPath("../x", "dir")).toThrow(/^dir escapes/);
  });
});

describe("relativeUnder()", () => {
  it("returns the relative remainder", () => {
    expect(relativeUnder("/notes", "/notes/memory")).toBe("memory");
  });

  it("returns empty string for the root itself", () => {
    expect(relativeUnder("/notes", "/notes")).toBe("");
  });

  it("returns null for a sibling", () => {
    expect(relativeUnder("/notes", "/other")).toBeNull();
  });

  it("does not treat a shared name prefix as containment", () => {
    // "/notes/memory-old" must not count as inside "/notes/memory"
    expect(relativeUnder("/notes/memory", "/notes/memory-old")).toBeNull();
  });
});

describe("resolveSubRoot()", () => {
  it("accepts a full path under the notes root", () => {
    expect(resolveSubRoot("/notes", "/notes/memory", "MEMORY_ROOT")).toBe("memory");
  });

  it("accepts a path already relative to the notes root", () => {
    expect(resolveSubRoot("/notes", "memory", "MEMORY_ROOT")).toBe("memory");
  });

  it("accepts a nested sub-root", () => {
    expect(resolveSubRoot("/notes", "/notes/betty/memory", "MEMORY_ROOT")).toBe("betty/memory");
  });

  it("rejects a sub-root outside the notes root", () => {
    expect(() => resolveSubRoot("/notes", "/elsewhere/memory", "MEMORY_ROOT")).toThrow(
      /must be inside NOTES_ROOT/
    );
  });

  it("rejects a sub-root equal to the notes root", () => {
    expect(() => resolveSubRoot("/notes", "/notes", "MEMORY_ROOT")).toThrow(
      /must be a subdirectory of NOTES_ROOT/
    );
  });

  it("rejects an empty sub-root", () => {
    expect(() => resolveSubRoot("/notes", "  ", "MEMORY_ROOT")).toThrow(/must not be empty/);
  });

  it("rejects a relative sub-root that traverses out", () => {
    expect(() => resolveSubRoot("/notes", "../memory", "MEMORY_ROOT")).toThrow(NoteScopeError);
  });

  it("names the offending variable in the error", () => {
    expect(() => resolveSubRoot("/notes", "/elsewhere", "SKILLS_ROOT")).toThrow(/SKILLS_ROOT/);
  });
});

describe("isUnderPrefix()", () => {
  it("matches the prefix directory itself", () => {
    expect(isUnderPrefix("memory", "memory")).toBe(true);
  });

  it("matches a descendant", () => {
    expect(isUnderPrefix("memory", "memory/people/sam.md")).toBe(true);
  });

  it("does not match a name-prefixed sibling", () => {
    expect(isUnderPrefix("memory", "memory-old/sam.md")).toBe(false);
  });

  it("treats an empty prefix as unrestricted", () => {
    expect(isUnderPrefix("", "anything/at/all.md")).toBe(true);
  });
});

describe("assertWritable()", () => {
  const SCOPES = ["betty/memory", "betty/skills"];

  it("allows a write inside the memory root", () => {
    expect(() => assertWritable(SCOPES, "betty/memory/people/sam.md")).not.toThrow();
  });

  it("allows a write inside the skills root", () => {
    expect(() => assertWritable(SCOPES, "betty/skills/inbox-triage/SKILL.md")).not.toThrow();
  });

  it("rejects a write elsewhere in the notes root", () => {
    // The interesting case: readable (inside NOTES_ROOT) but not writable.
    expect(() => assertWritable(SCOPES, "journal/2026-08-17.md")).toThrow(
      /Refusing to write outside Betty's own roots/
    );
  });

  it("rejects a write to the parent of both roots", () => {
    // betty/ itself is not a write scope — only the two directories inside it.
    expect(() => assertWritable(SCOPES, "betty/scratch.md")).toThrow(NoteScopeError);
  });

  it("rejects a write to a name-prefixed sibling directory", () => {
    expect(() => assertWritable(SCOPES, "betty/memory-old/sam.md")).toThrow(NoteScopeError);
  });

  it("rejects a write to the skills root when skills are not in scope", () => {
    expect(() => assertWritable(["betty/memory"], "betty/skills/research/SKILL.md")).toThrow(
      NoteScopeError
    );
  });

  it("names both roots in the error so the model can retarget", () => {
    expect(() => assertWritable(SCOPES, "elsewhere.md")).toThrow(
      /"betty\/memory\/" or "betty\/skills\/"/
    );
  });

  it("mentions the variables so the user knows what to change", () => {
    expect(() => assertWritable(SCOPES, "elsewhere.md")).toThrow(/MEMORY_ROOT or SKILLS_ROOT/);
  });

  it("refuses everything when no prefix is in scope", () => {
    // An empty prefix means "unrestricted" to isUnderPrefix — never to a write.
    expect(() => assertWritable([""], "anything.md")).toThrow(/no writable root is configured/);
    expect(() => assertWritable([], "anything.md")).toThrow(/no writable root is configured/);
  });
});

describe("joinPath()", () => {
  it("joins root and relative path", () => {
    expect(joinPath("/notes", "memory/sam.md")).toBe("/notes/memory/sam.md");
  });

  it("returns the root when the relative path is empty", () => {
    expect(joinPath("/notes", "")).toBe("/notes");
  });

  it("does not double the separator", () => {
    expect(joinPath("/notes/", "memory")).toBe("/notes/memory");
  });
});
