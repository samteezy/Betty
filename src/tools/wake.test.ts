import { harness } from "../test-support/mcp";
import { WAKE_TOOL, joinCapabilities, registerWakeTool } from "./wake";

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
    disabled?: Set<string>;
  } = {}
) {
  const gate = fakeGate();
  const h = harness((server) =>
    registerWakeTool(server, {
      gate,
      capabilities: overrides.capabilities ?? ["memory", "skills"],
      instructions: overrides.instructions ?? (async () => "# Betty\n\nInstructions."),
      disabled: overrides.disabled ?? new Set(),
    })
  );
  return { gate, ...h };
}

describe("wake_betty", () => {
  it("registers exactly one tool", () => {
    expect(setup().names()).toEqual([WAKE_TOOL]);
  });

  it("returns the instructions verbatim", async () => {
    const { text } = setup();
    expect(await text(WAKE_TOOL)).toBe("# Betty\n\nInstructions.");
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
    expect(result.content[0].text).toMatch(/back online/);
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

describe("joinCapabilities()", () => {
  it.each([
    [["memory"], "memory"],
    [["memory", "skills"], "memory and skills"],
    [["memory", "skills", "mail"], "memory, skills and mail"],
  ])("formats %j", (input, expected) => {
    expect(joinCapabilities(input)).toBe(expected);
  });

  it("falls back to something readable when there is nothing to name", () => {
    expect(joinCapabilities([])).toBe("her tools");
  });
});
