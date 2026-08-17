import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORGANIZE_DESK_SKILL, organizeDeskSkill } from "./organize-desk";
import { WAKE_BETTY_SKILL, wakeBettySkill } from "./wake-betty";
import { BUNDLED_SKILLS } from "./bundled";
import { parseNote } from "../notes/okf";
import { buildServer, connectAll } from "../server";

const PATHS = {
  memoryPrefix: "betty/memory",
  deskPrefix: "betty/desk",
  trashPrefix: "betty/trash",
  skillsPrefix: "betty/skills",
};

/** Invariants every shipped skill has to hold, whatever it is for. */
describe.each(BUNDLED_SKILLS.map((s) => [s.name, s] as const))("bundled skill: %s", (name, skill) => {
  const text = () => skill.build(PATHS);

  it("carries the name and description list_skills needs", () => {
    // Frontmatter missing either key makes list_skills skip the folder, so a
    // bundled skill that shipped without them would look installed and never
    // load.
    const parsed = parseNote(text());

    expect(parsed.frontmatter.name).toBe(name);
    expect(String(parsed.frontmatter.description).length).toBeGreaterThan(20);
  });

  it("says when to use it, not only what it is", () => {
    const description = String(parseNote(text()).frontmatter.description);
    expect(description).toMatch(/use (this|it|on|when)|load (this|it)|when asked/i);
  });

  it("names the configured roots rather than the defaults", () => {
    const rendered = skill.build({
      memoryPrefix: "brain",
      deskPrefix: "workbench",
      trashPrefix: "bin",
      skillsPrefix: "procedures",
    });

    expect(rendered).not.toContain("betty/memory");
    expect(rendered).not.toContain("betty/desk");
    expect(rendered).toContain("brain");
  });

  it("never says \"inbox\" — that word belongs to email here", () => {
    // list_skills shows only name and description, so that string is the whole
    // basis for choosing. Betty ships list_messages, and a user's own
    // mail-triage skill will legitimately claim "inbox"; if a bundled one did
    // too, "catch up on my inbox" would have two plausible answers.
    expect(text().toLowerCase()).not.toContain("inbox");
  });

  it("has a description distinct from every other bundled skill", () => {
    const mine = String(parseNote(text()).frontmatter.description).toLowerCase();
    for (const other of BUNDLED_SKILLS) {
      if (other.name === name) continue;
      const theirs = String(parseNote(other.build(PATHS)).frontmatter.description).toLowerCase();
      expect(mine).not.toBe(theirs);
    }
  });
});

describe("organize-desk", () => {
  it("says when to run it", () => {
    const description = String(parseNote(organizeDeskSkill(PATHS)).frontmatter.description);
    expect(description).toMatch(/schedule|daily|weekly/i);
  });

  it("names the configured roots rather than the defaults", () => {
    const text = organizeDeskSkill({
      memoryPrefix: "brain",
      deskPrefix: "workbench",
      trashPrefix: "bin",
      skillsPrefix: "procedures",
    });

    expect(text).toContain("brain/index.md");
    expect(text).toContain("workbench/unfiled.md");
    expect(text).toContain("bin/");
  });

  it("tells the model the index links are relative to the memory root", () => {
    // The one mistake that produces dead links which then rank top in search.
    const text = organizeDeskSkill(PATHS);

    expect(text).toMatch(/relative to/i);
    expect(text).toContain("people/priya-raman.md");
  });

  it("tells the model never to link trash from the index", () => {
    expect(organizeDeskSkill(PATHS)).toMatch(/[Nn]ever link/);
  });

  it("says plainly that it is not the email tool", () => {
    const description = String(parseNote(organizeDeskSkill(PATHS)).frontmatter.description);

    expect(description).toMatch(/memory/i);
    expect(description).toMatch(/not for email/i);
  });

  it("shares no trigger word with a user's email-triage skill", () => {
    // The real test of the rename. A user who writes their own mail skill and
    // a model choosing between the two see only these two strings; if they
    // overlap on the words someone would actually say, the model has to guess.
    const EMAIL_SKILL =
      "Sort the inbox into reply-now, waiting-on, and archive. Use when asked to triage, clear, or catch up on email.";
    const ours = String(parseNote(organizeDeskSkill(PATHS)).frontmatter.description);

    const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]+/g) ?? []);
    const shared = [...words(ours)].filter((w) => words(EMAIL_SKILL).has(w));

    // No word a user would actually say to invoke the email one.
    for (const trigger of ["inbox", "triage", "sort", "clear"]) {
      expect(shared).not.toContain(trigger);
    }
    // "email" is the exception, and only because we push it away explicitly.
    expect(ours.toLowerCase()).toContain("not for email");
    expect(ours.toLowerCase().replace("not for email", "")).not.toContain("email");
  });
});

describe("wake-betty", () => {
  const text = () => wakeBettySkill(PATHS);

  it("triggers on Betty being mentioned, not on a task", () => {
    // It is the default entry point: the thing a client config points at with
    // one line, so the substance lives in the user's storage rather than being
    // duplicated into every platform's settings.
    const description = String(parseNote(text()).frontmatter.description);

    expect(description).toMatch(/betty/i);
    expect(description).toMatch(/first time|start of a session|before using/i);
  });

  it("tells the model it is not Betty", () => {
    // A skill whose first line is "# Betty" reads as a character sheet, and a
    // model reading it cold will otherwise answer in her voice or narrate its
    // filing back to the user. Betty is the colleague consulted, not a costume.
    const body = text();

    expect(body).toMatch(/not Betty/i);
    expect(body).toMatch(/as yourself/i);
  });

  it("leads with searching before answering", () => {
    // The single highest-value instruction: an unread memory is worse than
    // none, because it means asking something already answered.
    const body = parseNote(text()).body;
    const searchAt = body.indexOf("search");
    const writeAt = body.indexOf("append_memory");

    expect(searchAt).toBeGreaterThan(-1);
    expect(searchAt).toBeLessThan(writeAt);
    expect(body).toContain(`${PATHS.memoryPrefix}/index.md`);
  });

  it("states the constraints a model would otherwise try to work around", () => {
    const body = text();

    expect(body).toMatch(/no delete/i);
    expect(body).toMatch(/never (executed|run)|never executed/i);
    expect(body).toContain(PATHS.trashPrefix);
  });

  it("says what is worth recording and what is not", () => {
    const body = text();

    expect(body).toMatch(/do not record/i);
    expect(body).toMatch(/one concept per file/i);
  });

  it("points at the other skills rather than duplicating them", () => {
    const body = text();

    expect(body).toContain("list_skills");
    expect(body).toContain(ORGANIZE_DESK_SKILL);
    // It should not restate organize-desk's procedure.
    expect(body).not.toContain("## Unprocessed");
  });
});

describe("seeding", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  const skillPath = () => join(root, "betty/skills/organize-desk/SKILL.md");

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "betty-seed-"));
    env = { NOTES_BACKEND: "local", NOTES_ROOT: root };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("installs every bundled skill on first connect", async () => {
    await connectAll(buildServer(env).backends);

    for (const skill of BUNDLED_SKILLS) {
      const text = await readFile(join(root, `betty/skills/${skill.name}/SKILL.md`), "utf8");
      expect(text).toContain(`name: ${skill.name}`);
    }
    expect(await readFile(skillPath(), "utf8")).toContain(`name: ${ORGANIZE_DESK_SKILL}`);
  });

  it("seeds each skill independently", async () => {
    // A user who deletes one on purpose, or one that fails to write, must not
    // stop the others arriving.
    await connectAll(buildServer(env).backends);
    await rm(join(root, `betty/skills/${WAKE_BETTY_SKILL}`), { recursive: true });
    await writeFile(skillPath(), "---\nname: organize-desk\ndescription: Mine.\n---\n\nMine.\n");

    await connectAll(buildServer(env).backends);

    expect(await readFile(join(root, `betty/skills/${WAKE_BETTY_SKILL}/SKILL.md`), "utf8")).toContain(
      `name: ${WAKE_BETTY_SKILL}`
    );
    expect(await readFile(skillPath(), "utf8")).toContain("Mine.");
  });

  it("leaves the user's edits alone on every connect after", async () => {
    await connectAll(buildServer(env).backends);
    await writeFile(skillPath(), "---\nname: organize-desk\ndescription: Mine now.\n---\n\nMine.\n");

    await connectAll(buildServer(env).backends);
    await connectAll(buildServer(env).backends);

    expect(await readFile(skillPath(), "utf8")).toContain("Mine now.");
  });

  it("can be turned off", async () => {
    await connectAll(buildServer({ ...env, BETTY_SEED_SKILLS: "false" }).backends);

    await expect(readFile(skillPath(), "utf8")).rejects.toThrow();
  });

  it("honours an explicit SKILLS_ROOT", async () => {
    await connectAll(buildServer({ ...env, SKILLS_ROOT: "procedures" }).backends);

    expect(await readFile(join(root, "procedures/organize-desk/SKILL.md"), "utf8")).toContain(
      "name: organize-desk"
    );
  });

  it("starts anyway when the skill cannot be written", async () => {
    // A convenience is never a reason to refuse to start. A file where the
    // skill's folder should be makes the write fail.
    await mkdir(join(root, "betty/skills"), { recursive: true });
    await writeFile(join(root, "betty/skills/organize-desk"), "not a directory");
    const stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(connectAll(buildServer(env).backends)).resolves.toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("organize-desk"));

    stderr.mockRestore();
  });

  it("writes nothing when notes are not configured", async () => {
    const { backends } = buildServer({
      CALDAV_URL: "https://dav.example.com",
      CALDAV_USERNAME: "u",
      CALDAV_PASSWORD: "p",
    });

    expect(backends.notes).toBeNull();
    expect(backends.notesPaths).toBeUndefined();
  });
});
