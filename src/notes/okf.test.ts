import {
  SKILL_FRONTMATTER,
  appendToBody,
  appendToSection,
  buildFrontmatter,
  buildSkillFrontmatter,
  extractLinks,
  findSection,
  listHeadings,
  logLine,
  missingRequiredKeys,
  parseNote,
  replaceSection,
  serializeNote,
} from "./okf";

// --- Test fixtures ---

const NOTE_WITH_FRONTMATTER = `---
type: person
title: Sam Taylor
description: Notes about Sam
timestamp: 2026-08-17T10:00:00Z
source: betty
tags:
  - colleague
  - fastmail
---

# Sam Taylor

Prefers email over calls.

## Preferences

Tea, not coffee.

### Detail

Earl grey.

## History

Met in 2024.
`;

const NOTE_WITHOUT_FRONTMATTER = `# Plain note

Just markdown, no frontmatter.
`;

describe("parseNote()", () => {
  it("splits frontmatter from body", () => {
    const parsed = parseNote(NOTE_WITH_FRONTMATTER);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.frontmatter.type).toBe("person");
    expect(parsed.frontmatter.title).toBe("Sam Taylor");
    expect(parsed.body.startsWith("\n# Sam Taylor")).toBe(true);
  });

  it("parses block lists", () => {
    const parsed = parseNote(NOTE_WITH_FRONTMATTER);
    expect(parsed.frontmatter.tags).toEqual(["colleague", "fastmail"]);
  });

  it("parses inline lists", () => {
    const parsed = parseNote(`---\ntype: note\ntags: [a, b, c]\n---\nbody\n`);
    expect(parsed.frontmatter.tags).toEqual(["a", "b", "c"]);
  });

  it("strips surrounding quotes", () => {
    const parsed = parseNote(`---\ntitle: "Quoted: with colon"\n---\nbody\n`);
    expect(parsed.frontmatter.title).toBe("Quoted: with colon");
  });

  it("handles a note with no frontmatter", () => {
    const parsed = parseNote(NOTE_WITHOUT_FRONTMATTER);
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe(NOTE_WITHOUT_FRONTMATTER);
    expect(parsed.raw).toBe("");
  });

  it("does not treat a horizontal rule mid-document as frontmatter", () => {
    const parsed = parseNote(`# Title\n\n---\n\nMore.\n`);
    expect(parsed.hasFrontmatter).toBe(false);
  });

  it("captures the raw frontmatter block verbatim", () => {
    // Edits reattach `raw` untouched, so a human's formatting survives.
    const parsed = parseNote(NOTE_WITH_FRONTMATTER);
    expect(parsed.raw + parsed.body).toBe(NOTE_WITH_FRONTMATTER);
  });
});

describe("serializeNote()", () => {
  it("round-trips frontmatter values", () => {
    const original = parseNote(NOTE_WITH_FRONTMATTER);
    const reparsed = parseNote(serializeNote(original.frontmatter, original.body));
    expect(reparsed.frontmatter).toEqual(original.frontmatter);
  });

  it("orders required OKF keys first", () => {
    const text = serializeNote(
      { source: "betty", timestamp: "t", type: "note", title: "T", description: "D" },
      "body"
    );
    const keys = text
      .split("\n")
      .slice(1)
      .filter((l) => /^[a-z]+:/.test(l))
      .map((l) => l.split(":")[0]);
    expect(keys.slice(0, 4)).toEqual(["type", "title", "description", "timestamp"]);
  });

  it("quotes values that would otherwise break the parse", () => {
    const text = serializeNote({ title: "Has: a colon" }, "body");
    expect(text).toContain('title: "Has: a colon"');
    expect(parseNote(text).frontmatter.title).toBe("Has: a colon");
  });

  it("serializes lists as block items", () => {
    const text = serializeNote({ tags: ["a", "b"] }, "body");
    expect(text).toContain("tags:\n  - a\n  - b");
  });

  it("takes a different leading-key order for skill manifests", () => {
    const text = serializeNote(
      { timestamp: "t", source: "betty", description: "D", name: "inbox-triage" },
      "body",
      SKILL_FRONTMATTER
    );
    const keys = text
      .split("\n")
      .slice(1)
      .filter((l) => /^[a-z]+:/.test(l))
      .map((l) => l.split(":")[0]);

    // description is an OKF required key, so the default order would hoist it
    // above name — a skill manifest leads with name instead.
    expect(keys).toEqual(["name", "description", "source", "timestamp"]);
  });
});

describe("buildSkillFrontmatter()", () => {
  it("emits the two keys list_skills reads", () => {
    const fm = buildSkillFrontmatter({
      name: "inbox-triage",
      description: "Sort the inbox.",
      timestamp: "t",
    });

    expect(fm.name).toBe("inbox-triage");
    expect(fm.description).toBe("Sort the inbox.");
  });

  it("writes no OKF note keys, which would make it load as a note", () => {
    const fm = buildSkillFrontmatter({ name: "n", description: "d", timestamp: "t" });

    expect(fm.type).toBeUndefined();
    expect(fm.title).toBeUndefined();
  });

  it("still tags the file as Betty's", () => {
    const fm = buildSkillFrontmatter({ name: "n", description: "d", timestamp: "t" });
    expect(fm.source).toBe("betty");
  });
});

describe("buildFrontmatter()", () => {
  it("always emits all four keys Google's reference parser expects", () => {
    const fm = buildFrontmatter({ title: "Sam", timestamp: "2026-08-17T10:00:00Z" });
    expect(missingRequiredKeys(fm)).toEqual([]);
  });

  it("tags everything Betty wrote with source: betty", () => {
    const fm = buildFrontmatter({ title: "Sam", timestamp: "t" });
    expect(fm.source).toBe("betty");
  });

  it("falls back to the title for description", () => {
    const fm = buildFrontmatter({ title: "Sam", timestamp: "t" });
    expect(fm.description).toBe("Sam");
  });

  it("defaults type to note", () => {
    expect(buildFrontmatter({ title: "Sam", timestamp: "t" }).type).toBe("note");
  });
});

describe("missingRequiredKeys()", () => {
  it("reports absent keys", () => {
    expect(missingRequiredKeys({ type: "note" })).toEqual(["title", "description", "timestamp"]);
  });

  it("treats blank values as missing", () => {
    expect(missingRequiredKeys({ type: "note", title: "  " })).toContain("title");
  });
});

describe("listHeadings()", () => {
  it("finds headings with their levels", () => {
    const headings = listHeadings(parseNote(NOTE_WITH_FRONTMATTER).body);
    expect(headings.map((h) => [h.level, h.text])).toEqual([
      [1, "Sam Taylor"],
      [2, "Preferences"],
      [3, "Detail"],
      [2, "History"],
    ]);
  });

  it("ignores # inside fenced code blocks", () => {
    const body = "# Real\n\n```bash\n# not a heading\n```\n\n## Also real\n";
    expect(listHeadings(body).map((h) => h.text)).toEqual(["Real", "Also real"]);
  });

  it("ignores tilde-fenced blocks too", () => {
    const body = "# Real\n\n~~~\n# not a heading\n~~~\n";
    expect(listHeadings(body).map((h) => h.text)).toEqual(["Real"]);
  });

  it("strips closing hashes from setext-style ATX headings", () => {
    expect(listHeadings("## Middle ##\n")[0].text).toBe("Middle");
  });
});

describe("findSection()", () => {
  const body = parseNote(NOTE_WITH_FRONTMATTER).body;

  it("matches a heading case-insensitively", () => {
    expect(findSection(body, "preferences")).not.toBeNull();
  });

  it("tolerates a leading # in the requested heading", () => {
    expect(findSection(body, "## Preferences")).not.toBeNull();
  });

  it("returns null for a heading that does not exist", () => {
    expect(findSection(body, "Nonexistent")).toBeNull();
  });

  it("runs to the next heading of the same or higher level", () => {
    // "## Preferences" must swallow "### Detail" but stop at "## History".
    const section = findSection(body, "Preferences");
    const lines = body.split("\n").slice(section!.bodyStart, section!.bodyEnd);
    expect(lines.join("\n")).toContain("Earl grey");
    expect(lines.join("\n")).not.toContain("Met in 2024");
  });
});

describe("replaceSection()", () => {
  const body = parseNote(NOTE_WITH_FRONTMATTER).body;

  it("replaces only the targeted section", () => {
    const result = replaceSection(body, "History", "Met in 2023, actually.");
    expect(result).toContain("Met in 2023, actually.");
    expect(result).not.toContain("Met in 2024.");
    expect(result).toContain("Tea, not coffee.");
  });

  it("keeps the heading itself", () => {
    expect(replaceSection(body, "History", "new")).toContain("## History");
  });

  it("removes subsections belonging to the replaced section", () => {
    const result = replaceSection(body, "Preferences", "Coffee after all.");
    expect(result).not.toContain("### Detail");
    expect(result).not.toContain("Earl grey");
    expect(result).toContain("## History");
  });

  it("throws listing the headings that do exist", () => {
    expect(() => replaceSection(body, "Nope", "x")).toThrow(/Existing headings/);
    expect(() => replaceSection(body, "Nope", "x")).toThrow(/"Preferences"/);
  });

  it("points at append_note when the note has no headings", () => {
    expect(() => replaceSection("just text\n", "Nope", "x")).toThrow(/no headings at all/);
  });
});

describe("appendToSection()", () => {
  const body = parseNote(NOTE_WITH_FRONTMATTER).body;

  it("adds content at the end of the section, not the file", () => {
    const result = appendToSection(body, "Preferences", "Also: no sugar.");
    const preferencesAt = result.indexOf("Also: no sugar.");
    const historyAt = result.indexOf("## History");
    expect(preferencesAt).toBeGreaterThan(-1);
    expect(preferencesAt).toBeLessThan(historyAt);
  });

  it("preserves existing section content", () => {
    const result = appendToSection(body, "History", "And again in 2026.");
    expect(result).toContain("Met in 2024.");
    expect(result).toContain("And again in 2026.");
  });

  it("throws for an unknown heading", () => {
    expect(() => appendToSection(body, "Nope", "x")).toThrow(/No section titled/);
  });
});

describe("appendToBody()", () => {
  it("appends with a blank line separator", () => {
    expect(appendToBody("first\n", "second")).toBe("first\n\nsecond\n");
  });

  it("handles an empty body", () => {
    expect(appendToBody("", "only")).toBe("only\n");
  });

  it("does not accumulate trailing blank lines", () => {
    expect(appendToBody("first\n\n\n", "second")).toBe("first\n\nsecond\n");
  });
});

describe("extractLinks()", () => {
  it("pulls text and target out of markdown links", () => {
    expect(extractLinks("See [Sam Taylor](people/sam.md) for details.")).toEqual([
      { text: "Sam Taylor", target: "people/sam.md" },
    ]);
  });

  it("ignores the optional title attribute", () => {
    expect(extractLinks('[A](b.md "title")')).toEqual([{ text: "A", target: "b.md" }]);
  });

  it("finds multiple links", () => {
    expect(extractLinks("[a](1.md) and [b](2.md)")).toHaveLength(2);
  });
});

describe("logLine()", () => {
  it("renders a linked history entry", () => {
    expect(logLine("2026-08-17T10:00:00Z", "append", "memory/sam.md")).toBe(
      "- 2026-08-17T10:00:00Z `append` [memory/sam.md](memory/sam.md)"
    );
  });

  it("flattens multi-line detail onto one line", () => {
    expect(logLine("t", "replace", "p", "Some\nheading")).toBe(
      "- t `replace` [p](p) — Some heading"
    );
  });
});
