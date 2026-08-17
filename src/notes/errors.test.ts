import { conflictMessage, existsMessage, NoteConflictError, NoteNotFoundError } from "./errors";

/**
 * These strings are the model's instructions on a failed write, so a tool name
 * in one that isn't registered sends it straight into a hard MCP error on the
 * retry the message exists to enable. Memory and skills have had separate
 * append/replace tools since 0.4.0, so the wording names an action, not a tool.
 */
const RETIRED_TOOLS = ["append_note", "replace_section"];

describe("write-failure messages", () => {
  it("existsMessage names no retired tool", () => {
    const message = existsMessage("betty/memory/sam.md");

    for (const name of RETIRED_TOOLS) expect(message).not.toContain(name);
    expect(message).toContain("betty/memory/sam.md");
  });

  it("existsMessage still points at a tool that does exist", () => {
    expect(existsMessage("betty/memory/sam.md")).toContain("get_note");
  });

  it("conflictMessage tells the model to re-read rather than retry blindly", () => {
    const message = conflictMessage("betty/memory/sam.md");

    for (const name of RETIRED_TOOLS) expect(message).not.toContain(name);
    expect(message).toContain("get_note");
    expect(message).toMatch(/changed since Betty last read it/);
  });
});

describe("error types", () => {
  it("NoteNotFoundError carries the path", () => {
    expect(new NoteNotFoundError("a.md").message).toBe("Note not found: a.md");
  });

  it("both keep a name that survives instanceof checks across the tool layer", () => {
    expect(new NoteConflictError("x").name).toBe("NoteConflictError");
    expect(new NoteNotFoundError("a.md").name).toBe("NoteNotFoundError");
  });
});
