import { registerSkillsTools } from "./skills";
import { harness } from "../test-support/mcp";
import { MemoryNotesBackend } from "../test-support/backends";
import { withEnv } from "../test-support/env";

const NOW = () => new Date("2026-08-17T10:00:00.000Z");

/**
 * Read-only backend: for the reading tools, a write reaching storage is a bug,
 * and this keeps that a compile-free assertion. The authoring tools get
 * writableSetup() instead rather than loosening this one.
 */
function setup(maxSkills?: number) {
  const backend = new MemoryNotesBackend({ readOnly: true });
  const h = harness((server) =>
    registerSkillsTools(server, backend, { skillsPrefix: "skills", maxSkills, now: NOW })
  );
  return { backend, ...h };
}

function writableSetup() {
  const backend = new MemoryNotesBackend();
  const h = harness((server) =>
    registerSkillsTools(server, backend, { skillsPrefix: "skills", now: NOW })
  );
  return { backend, ...h };
}

// --- Test fixtures ---

const RESEARCH_SKILL = `---
name: deep-research
description: Run a structured research pass over a topic and summarize the findings.
license: MIT
allowed-tools: ["Read", "Grep"]
version: 2
---

# Deep research

1. Break the question into sub-questions.
2. Search each independently.
3. Reconcile contradictions before summarizing.
`;

/**
 * Deliberately an *email* skill, and deliberately still called "inbox-triage".
 * The docs use meeting-prep as the example so readers aren't anchored on mail,
 * but the fixtures keep a mail skill on purpose: "inbox" is email's word here,
 * and a user's inbox-triage skill has to coexist with organize-desk without
 * either one claiming the other's job. Don't rename this for tidiness.
 */
const TRIAGE_SKILL = `---
name: inbox-triage
description: Sort the inbox into reply-now, defer, and archive.
---

# Inbox triage

Start with anything from a human.
`;

describe("list_skills", () => {
  it("returns name and description for each skill", async () => {
    const { json, backend } = setup();
    backend.seed("skills/research/SKILL.md", RESEARCH_SKILL);
    backend.seed("skills/triage/SKILL.md", TRIAGE_SKILL);

    const result = await json("list_skills");

    expect(result.skills).toEqual([
      {
        name: "deep-research",
        description: "Run a structured research pass over a topic and summarize the findings.",
      },
      { name: "inbox-triage", description: "Sort the inbox into reply-now, defer, and archive." },
    ]);
  });

  it("does not leak skill bodies into the listing", async () => {
    // Progressive disclosure: bodies cost context and load on demand only.
    const { call, backend } = setup();
    backend.seed("skills/research/SKILL.md", RESEARCH_SKILL);

    const text = (await call("list_skills")).content[0].text;

    expect(text).not.toContain("Break the question into sub-questions");
  });

  it("ignores unknown frontmatter keys", async () => {
    const { json, backend } = setup();
    backend.seed("skills/research/SKILL.md", RESEARCH_SKILL);

    const result = await json("list_skills");

    expect(result.skills[0]).toEqual({
      name: "deep-research",
      description: "Run a structured research pass over a topic and summarize the findings.",
    });
  });

  it("skips folders with no SKILL.md without calling them errors", async () => {
    const { json, backend } = setup();
    backend.seed("skills/research/SKILL.md", RESEARCH_SKILL);
    backend.seed("skills/notes-only/README.md", "# Not a skill");

    const result = await json("list_skills");

    expect(result.skills).toHaveLength(1);
    expect(result.skippedFolders).toBeUndefined();
  });

  it("skips a SKILL.md missing name or description and counts it", async () => {
    const { json, backend } = setup();
    backend.seed("skills/broken/SKILL.md", "---\nname: nameless\n---\n\n# Body\n");
    backend.seed("skills/research/SKILL.md", RESEARCH_SKILL);

    const result = await json("list_skills");

    expect(result.skills).toHaveLength(1);
    expect(result.skippedFolders).toBe(1);
  });

  it("explains what was skipped when verbose", async () => {
    const { json, backend } = setup();
    backend.seed("skills/broken/SKILL.md", "---\nname: nameless\n---\n\n# Body\n");

    const result = await json("list_skills", { verbose: true });

    expect(result.invalid[0]).toMatchObject({ folder: "broken" });
    expect(result.invalid[0].reason).toMatch(/must set both "name" and "description"/);
  });

  it("includes paths when verbose", async () => {
    const { json, backend } = setup();
    backend.seed("skills/research/SKILL.md", RESEARCH_SKILL);

    expect((await json("list_skills", { verbose: true })).skills[0].path).toBe(
      "skills/research/SKILL.md"
    );
  });

  it("returns an empty list when nothing is configured", async () => {
    const { json } = setup();
    expect(await json("list_skills")).toEqual({ skills: [] });
  });

  it("flags truncation rather than silently capping", async () => {
    const { json, backend } = setup(1);
    backend.seed("skills/a/SKILL.md", TRIAGE_SKILL);
    backend.seed("skills/b/SKILL.md", RESEARCH_SKILL);

    const result = await json("list_skills");

    expect(result.truncated).toBe(true);
  });
});

describe("load_skill", () => {
  it("returns the full instructions on demand", async () => {
    const { json, backend } = setup();
    backend.seed("skills/research/SKILL.md", RESEARCH_SKILL);

    const result = await json("load_skill", { name: "deep-research" });

    expect(result.name).toBe("deep-research");
    expect(result.instructions).toContain("Break the question into sub-questions");
  });

  it("strips the frontmatter from the instructions", async () => {
    const { json, backend } = setup();
    backend.seed("skills/research/SKILL.md", RESEARCH_SKILL);

    expect((await json("load_skill", { name: "deep-research" })).instructions).not.toContain(
      "license: MIT"
    );
  });

  it("matches case-insensitively", async () => {
    const { json, backend } = setup();
    backend.seed("skills/research/SKILL.md", RESEARCH_SKILL);

    await expect(json("load_skill", { name: "Deep-Research" })).resolves.toMatchObject({
      name: "deep-research",
    });
  });

  it("falls back to the folder name", async () => {
    const { json, backend } = setup();
    backend.seed("skills/research/SKILL.md", RESEARCH_SKILL);

    await expect(json("load_skill", { name: "research" })).resolves.toMatchObject({
      name: "deep-research",
    });
  });

  it("lists what is available when the name is wrong", async () => {
    const { call, backend } = setup();
    backend.seed("skills/research/SKILL.md", RESEARCH_SKILL);

    const result = await call("load_skill", { name: "nope" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Available skills: deep-research/);
  });

  it("says so plainly when no skills exist at all", async () => {
    const { call } = setup();
    const result = await call("load_skill", { name: "nope" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No skills are configured/);
  });
});

describe("skills are instructions, not code", () => {
  it("never reads anything from a scripts directory", async () => {
    const { json, backend } = setup();
    backend.seed("skills/research/SKILL.md", RESEARCH_SKILL);
    backend.seed("skills/research/scripts/run.sh", "#!/bin/sh\nrm -rf /\n");
    backend.seed("skills/research/scripts/helper.py", "import os");

    await json("list_skills");
    await json("load_skill", { name: "deep-research" });

    expect(backend.reads.some((p) => p.includes("scripts/"))).toBe(false);
    expect(backend.reads).toEqual([
      "skills/research/SKILL.md",
      "skills/research/SKILL.md",
      "skills/research/SKILL.md",
    ]);
  });

  it("does not surface script paths in tool output", async () => {
    const { call, backend } = setup();
    backend.seed("skills/research/SKILL.md", RESEARCH_SKILL);
    backend.seed("skills/research/scripts/run.sh", "#!/bin/sh");

    const listed = (await call("list_skills", { verbose: true })).content[0].text;
    const loaded = (await call("load_skill", { name: "deep-research" })).content[0].text;

    expect(listed).not.toContain("scripts");
    expect(loaded).not.toContain("run.sh");
  });

  it("exposes no tool that could execute a skill", () => {
    // Authoring a skill is writing markdown. Nothing here runs it, and nothing
    // reads a scripts/ directory — writability does not loosen that.
    const { tools } = setup();
    expect([...tools.keys()].sort()).toEqual([
      "append_skill",
      "list_skills",
      "load_skill",
      "replace_skill_section",
    ]);
    for (const name of ["run_skill", "execute_skill", "delete_skill", "move_skill"]) {
      expect(tools.has(name)).toBe(false);
    }
  });
});

describe("append_skill", () => {
  it("creates a SKILL.md with name/description frontmatter, not an OKF block", async () => {
    // list_skills reads name and description and skips a folder with neither.
    // An OKF title/type block here would load as a note and fail as a skill.
    const { json, backend } = writableSetup();

    const result = await json("append_skill", {
      name: "inbox-triage",
      content: "1. `list_messages` for the last 24 hours.",
      description: "Sort the inbox into reply-now and archive.",
    });

    expect(result).toMatchObject({ name: "inbox-triage", path: "skills/inbox-triage/SKILL.md", created: true });
    const text = backend.files.get("skills/inbox-triage/SKILL.md")!;
    expect(text).toContain("name: inbox-triage");
    expect(text).toContain("description: Sort the inbox into reply-now and archive.");
    expect(text).not.toContain("title:");
    expect(text).not.toContain("type: note");
  });

  it("leads with name, then description", async () => {
    const { json, backend } = writableSetup();
    await json("append_skill", { name: "a", content: "x", description: "d" });

    const text = backend.files.get("skills/a/SKILL.md")!;
    expect(text.indexOf("name:")).toBeLessThan(text.indexOf("description:"));
  });

  it("stamps source and timestamp so Betty's skills stay greppable", async () => {
    const { json, backend } = writableSetup();
    await json("append_skill", { name: "a", content: "x", description: "d" });

    const text = backend.files.get("skills/a/SKILL.md")!;
    expect(text).toContain("source: betty");
    expect(text).toContain("timestamp: 2026-08-17T10:00:00Z");
  });

  it("puts the skill exactly one level down, where list_skills looks", async () => {
    const { json, backend } = writableSetup();
    await json("append_skill", { name: "inbox-triage", content: "x", description: "d" });

    expect([...backend.files.keys()]).toEqual(["skills/inbox-triage/SKILL.md"]);
  });

  it("refuses to create a skill with no description", async () => {
    const { call, backend } = writableSetup();
    const result = await call("append_skill", { name: "a", content: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/needs a description/);
    expect(backend.files.size).toBe(0);
  });

  it("refuses a name that is a path", async () => {
    // A name cannot express a wrong-depth SKILL.md — that is the point of
    // taking a name rather than a path.
    const { call, backend } = writableSetup();

    for (const name of ["team/triage", "a/b/c", "."]) {
      const result = await call("append_skill", { name, content: "x", description: "d" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/single folder name/);
    }
    expect(backend.files.size).toBe(0);
  });

  it("refuses a name that traverses out of the skills root", async () => {
    // Caught by safeRelPath before the single-segment check, with its own
    // wording — either way nothing is written.
    const { call, backend } = writableSetup();

    const result = await call("append_skill", {
      name: "../../etc/passwd",
      content: "x",
      description: "d",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/escapes the notes root/);
    expect(backend.files.size).toBe(0);
  });

  it("appends to an existing skill without rewriting its frontmatter", async () => {
    const { json, backend } = writableSetup();
    backend.seed("skills/inbox-triage/SKILL.md", TRIAGE_SKILL);

    const result = await json("append_skill", { name: "inbox-triage", content: "Then archive." });

    expect(result.created).toBe(false);
    const text = backend.files.get("skills/inbox-triage/SKILL.md")!;
    expect(text).toContain("description: Sort the inbox into reply-now, defer, and archive.");
    expect(text).toContain("Start with anything from a human.");
    expect(text).toContain("Then archive.");
    expect(text).not.toContain("source: betty");
  });

  it("matches the folder even when the frontmatter name differs", async () => {
    const { json, backend } = writableSetup();
    backend.seed("skills/research/SKILL.md", RESEARCH_SKILL);

    await json("append_skill", { name: "research", content: "4. Cite sources." });

    expect(backend.files.get("skills/research/SKILL.md")).toContain("4. Cite sources.");
  });

  it("surfaces a write conflict rather than clobbering", async () => {
    const { call, backend } = writableSetup();
    backend.seed("skills/inbox-triage/SKILL.md", TRIAGE_SKILL);

    // Resolving the name reads the manifest once before the read whose etag is
    // used for the write, so the edit has to land after that second read —
    // mockImplementationOnce would fire on the resolution pass instead.
    const original = backend.read.bind(backend);
    let reads = 0;
    jest.spyOn(backend, "read").mockImplementation(async (path: string) => {
      const snapshot = await original(path);
      if (path.endsWith("SKILL.md") && ++reads === 2) {
        backend.seed(path, `${TRIAGE_SKILL}\nEdited by a human.\n`);
      }
      return snapshot;
    });

    const result = await call("append_skill", { name: "inbox-triage", content: "Betty's line." });

    expect(result.isError).toBe(true);
    expect(backend.files.get("skills/inbox-triage/SKILL.md")).toContain("Edited by a human.");
  });
});

describe("replace_skill_section", () => {
  const STEPS = `---
name: inbox-triage
description: d
---

# Inbox triage

## Steps

old

## Notes

keep
`;

  it("replaces only the targeted section", async () => {
    const { json, backend } = writableSetup();
    backend.seed("skills/inbox-triage/SKILL.md", STEPS);

    const result = await json("replace_skill_section", {
      name: "inbox-triage",
      heading: "Steps",
      content: "new",
    });

    expect(result.replaced).toBe(true);
    const text = backend.files.get("skills/inbox-triage/SKILL.md")!;
    expect(text).toContain("new");
    expect(text).not.toContain("old");
    expect(text).toContain("keep");
  });

  it("refuses a heading that does not exist and lists the ones that do", async () => {
    const { call, backend } = writableSetup();
    backend.seed("skills/inbox-triage/SKILL.md", STEPS);

    const result = await call("replace_skill_section", {
      name: "inbox-triage",
      heading: "Nope",
      content: "x",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/"Steps"/);
    expect(backend.files.get("skills/inbox-triage/SKILL.md")).toBe(STEPS);
  });

  it("does not create a skill that is missing", async () => {
    const { call, backend } = writableSetup();
    const result = await call("replace_skill_section", {
      name: "nope",
      heading: "H",
      content: "x",
    });

    expect(result.isError).toBe(true);
    expect(backend.files.size).toBe(0);
  });
});

describe("registration", () => {
  it("honours DISABLED_TOOLS", () => {
    const { tools } = withEnv({ DISABLED_TOOLS: "load_skill" }, () => setup());

    expect(tools.has("list_skills")).toBe(true);
    expect(tools.has("load_skill")).toBe(false);
  });

  it("can freeze skills while leaving memory writable", () => {
    // The split is what makes this expressible at all — before 0.4.0 the write
    // tools were shared, so there was no setting that did this.
    const { tools } = withEnv(
      { DISABLED_TOOLS: "append_skill,replace_skill_section" },
      () => setup()
    );

    expect(tools.has("append_skill")).toBe(false);
    expect(tools.has("replace_skill_section")).toBe(false);
    expect(tools.has("list_skills")).toBe(true);
  });

  it("honours the pre-0.4 tool names in DISABLED_TOOLS", () => {
    const { tools } = withEnv({ DISABLED_TOOLS: "append_note,replace_section" }, () => setup());

    expect(tools.has("append_skill")).toBe(false);
    expect(tools.has("replace_skill_section")).toBe(false);
    expect(tools.has("load_skill")).toBe(true);
  });
});

describe("a skill whose frontmatter name differs from its folder", () => {
  // list_skills reports the frontmatter name, so that is the name the model
  // passes back. Deriving the path from it as if it were the folder would miss
  // the skill on replace, and create a duplicate on append.
  const NAMED = `---
name: Inbox Triage
description: Sort the inbox into reply-now and archive.
---

# Inbox triage

## Steps

1. First.
`;

  it("extends the existing skill instead of creating a second one", async () => {
    const { json, backend } = writableSetup();
    backend.seed("skills/inbox-triage/SKILL.md", NAMED);

    const result = await json("append_skill", { name: "Inbox Triage", content: "2. Second." });

    expect(result).toMatchObject({ path: "skills/inbox-triage/SKILL.md", created: false });
    expect(backend.files.has("skills/Inbox Triage/SKILL.md")).toBe(false);
    expect([...backend.files.keys()]).toEqual(["skills/inbox-triage/SKILL.md"]);
    expect(backend.files.get("skills/inbox-triage/SKILL.md")).toContain("2. Second.");
  });

  it("replaces a section in it", async () => {
    const { json, backend } = writableSetup();
    backend.seed("skills/inbox-triage/SKILL.md", NAMED);

    const result = await json("replace_skill_section", {
      name: "Inbox Triage",
      heading: "Steps",
      content: "1. Rewritten.",
    });

    expect(result).toMatchObject({ path: "skills/inbox-triage/SKILL.md", replaced: true });
    expect(backend.files.get("skills/inbox-triage/SKILL.md")).toContain("1. Rewritten.");
  });

  it("still matches on the folder name", async () => {
    const { json, backend } = writableSetup();
    backend.seed("skills/inbox-triage/SKILL.md", NAMED);

    await json("append_skill", { name: "inbox-triage", content: "2. Second." });

    expect([...backend.files.keys()]).toEqual(["skills/inbox-triage/SKILL.md"]);
  });

  it("creates a new skill when the name matches nothing", async () => {
    const { json, backend } = writableSetup();
    backend.seed("skills/inbox-triage/SKILL.md", NAMED);

    await json("append_skill", { name: "weekly-review", content: "x", description: "d" });

    expect(backend.files.has("skills/weekly-review/SKILL.md")).toBe(true);
  });
});
