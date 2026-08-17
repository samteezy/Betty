import { harness } from "../test-support/mcp";
import { ToolGroup } from "./capabilities";
import { WAKE_TOOL, registerWakeTool } from "./wake";

/** A group as the gate would report it: open unless said otherwise. */
const group = (name: string, tools: string[], extra: Partial<ToolGroup> = {}): ToolGroup => ({
  group: name,
  tools,
  open: true,
  deferred: false,
  ...extra,
});

function fakeGate() {
  let open = false;
  return {
    get awake() {
      return open;
    },
    wake() {
      if (open) return false;
      open = true;
      return true;
    },
  };
}

function setup(
  overrides: {
    capabilities?: string[];
    instructions?: () => Promise<string>;
    inventory?: () => ToolGroup[];
    disabled?: Set<string>;
  } = {}
) {
  const gate = fakeGate();
  const h = harness((server) =>
    registerWakeTool(server, {
      gate,
      capabilities: overrides.capabilities ?? ["memory", "skills"],
      instructions: overrides.instructions ?? (async () => "# Betty\n\nInstructions."),
      inventory: overrides.inventory,
      disabled: overrides.disabled ?? new Set(),
    })
  );
  return { gate, ...h };
}

describe("wake_betty", () => {
  it("registers exactly one tool", () => {
    expect(setup().names()).toEqual([WAKE_TOOL]);
  });

  it("returns the instructions verbatim, between a preamble and a footer", async () => {
    const { text } = setup();
    expect(await text(WAKE_TOOL)).toContain("\n\n---\n\n# Betty\n\nInstructions.\n\n---\n\n");
  });

  it("names the tools it just revealed", async () => {
    // The failure this exists for: the client has been told the list changed
    // but the model is still looking at the old one, holding only wake_betty.
    // A model that does not believe a tool exists will not call it.
    const { text } = setup({
      capabilities: ["memory", "skills", "mail"],
      inventory: () => [
        group("mail", ["list_messages", "send_message"]),
        group("memory", ["search_notes", "get_note"]),
        group("skills", ["list_skills", "load_skill"]),
      ],
    });

    const body = await text(WAKE_TOOL);

    expect(body).toContain("- **memory**: search_notes, get_note");
    expect(body).toContain("- **mail**: list_messages, send_message");
    // Ordered as the description reads, not as registration happened: memory
    // and skills register last but lead, because they are what Betty is.
    expect(body.indexOf("**memory**")).toBeLessThan(body.indexOf("**mail**"));
  });

  it("asks the model to check skills as well as tools", async () => {
    // Two different questions that fail separately — a full tool list still
    // does not say the user wrote a skill for exactly this.
    const body = await setup().text(WAKE_TOOL);
    expect(body).toContain("list_skills");
    expect(body).toMatch(/taught/i);
  });

  it("still says the tool list changed when there is no inventory to name", async () => {
    const body = await setup({ inventory: () => [] }).text(WAKE_TOOL);
    expect(body).toMatch(/tool list/i);
    expect(body).toContain("# Betty");
  });

  it("opens the gate", async () => {
    const { gate, call } = setup();
    await call(WAKE_TOOL);
    expect(gate.awake).toBe(true);
  });

  it("skips the instructions when the model already has them", async () => {
    // The whole reason a short re-arm is affordable: recovering from one costs
    // a sentence, not the entire skill.
    const instructions = jest.fn(async () => "the whole skill");
    const { call, gate } = setup({ instructions });

    const result = await call(WAKE_TOOL, { loaded: true });

    expect(instructions).not.toHaveBeenCalled();
    expect(gate.awake).toBe(true);
    expect(result.content[0].text).toMatch(/tool list again/);
  });

  it("says so when loaded=true finds the gate already open", async () => {
    const { call } = setup();
    await call(WAKE_TOOL, { loaded: true });
    const result = await call(WAKE_TOOL, { loaded: true });
    expect(result.content[0].text).toBe("Betty is already awake.");
  });

  it("re-sends the instructions when asked again without loaded", async () => {
    // Omitting the flag is the safe direction — a wasted read, never a boot
    // with no instructions.
    const instructions = jest.fn(async () => "the whole skill");
    const { call } = setup({ instructions });
    await call(WAKE_TOOL);
    await call(WAKE_TOOL);
    expect(instructions).toHaveBeenCalledTimes(2);
  });

  it("still wakes when the instructions cannot be read", async () => {
    const { call, gate } = setup({
      instructions: async () => {
        throw new Error("storage unreachable");
      },
    });

    const result = await call(WAKE_TOOL);

    // The tools are live, so this is not an error result — the model can carry
    // on without the skill.
    expect(gate.awake).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/storage unreachable/);
    expect(result.content[0].text).toMatch(/list_skills/);
  });

  it("names the tools even when the instructions cannot be read", async () => {
    // Without the skill the inventory is the only orientation the model gets.
    const { call } = setup({
      instructions: async () => {
        throw new Error("storage unreachable");
      },
      inventory: () => [group("memory", ["search_notes"])],
    });

    expect((await call(WAKE_TOOL)).content[0].text).toContain("- **memory**: search_notes");
  });

  it("names the configured capabilities in its description", () => {
    const { tools } = setup({ capabilities: ["memory", "skills", "mail", "calendar"] });
    expect(tools.get(WAKE_TOOL)?.description).toContain(
      "memory, skills, mail and calendar"
    );
  });

  it("stays small — its definition is in context on every request forever", () => {
    const tool = setup({
      capabilities: ["memory", "skills", "mail", "calendar", "tasks", "contacts"],
    }).tools.get(WAKE_TOOL);

    // The gate only pays for itself if the always-visible half is cheap. This
    // is a budget, not a measurement: ~3.5 chars/token puts it near 70.
    expect(tool!.description.length).toBeLessThan(300);
    expect(Object.keys(tool!.schema as object)).toEqual(["loaded"]);
  });

  it("registers nothing when the disabled set names it", () => {
    // The composition root refuses to arm the gate in this case, and hands the
    // same set down so the two decisions cannot disagree.
    expect(setup({ disabled: new Set(["wake_betty"]) }).names()).toEqual([]);
  });
});
