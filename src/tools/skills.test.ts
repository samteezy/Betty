import { registerSkillsTools } from "./skills";
import { NoteEntry, NoteRead, NotesBackend, NoteWriteResult } from "../types";
import { NoteNotFoundError } from "../notes/errors";

// --- Test harness ---

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function captureServer() {
  const tools = new Map<string, Handler>();
  const server = {
    tool: (name: string, _description: string, _schema: unknown, handler: Handler) => {
      tools.set(name, handler);
    },
  };
  return { server: server as never, tools };
}

class MemoryBackend implements NotesBackend {
  files = new Map<string, string>();
  reads: string[] = [];

  seed(path: string, text: string): void {
    this.files.set(path, text);
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
      if (!seen.has(childPath)) {
        seen.set(childPath, { path: childPath, name: head, isDirectory: tail.length > 0 });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(path: string): Promise<NoteRead> {
    this.reads.push(path);
    const text = this.files.get(path);
    if (text === undefined) throw new NoteNotFoundError(path);
    return { text, etag: '"v1"' };
  }

  async write(): Promise<NoteWriteResult> {
    throw new Error("skills storage is read-only");
  }
}

function setup(maxSkills?: number) {
  const backend = new MemoryBackend();
  const { server, tools } = captureServer();
  registerSkillsTools(server, backend, { skillsPrefix: "skills", maxSkills });
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const handler = tools.get(name);
    if (!handler) throw new Error(`Tool not registered: ${name}`);
    return handler(args);
  };
  const json = async (name: string, args: Record<string, unknown> = {}) =>
    JSON.parse((await call(name, args)).content[0].text);
  return { backend, tools, call, json };
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
    const { tools } = setup();
    expect([...tools.keys()].sort()).toEqual(["list_skills", "load_skill"]);
  });
});

describe("registration", () => {
  it("honours DISABLED_TOOLS", () => {
    const original = process.env.DISABLED_TOOLS;
    process.env.DISABLED_TOOLS = "load_skill";
    try {
      const { tools } = setup();
      expect(tools.has("list_skills")).toBe(true);
      expect(tools.has("load_skill")).toBe(false);
    } finally {
      if (original === undefined) delete process.env.DISABLED_TOOLS;
      else process.env.DISABLED_TOOLS = original;
    }
  });
});
