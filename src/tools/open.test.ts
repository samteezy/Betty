import { harness } from "../test-support/mcp";
import { ToolGroup } from "./capabilities";
import { CapabilityGate, OPEN_TOOL, registerOpenTool } from "./open";

/**
 * A gate that knows only what this tool asks of it: which drawers exist, and how
 * to open one. The real ToolGate is covered in gate.test.ts.
 */
function fakeGate(groups: ToolGroup[]): CapabilityGate {
  return {
    inventory: groups,
    openGroup(name) {
      const group = groups.find((entry) => entry.group === name);
      if (!group) return "unknown";
      if (group.open) return "already-open";
      group.open = true;
      return "opened";
    },
  };
}

const deferred = (name: string, tools: string[]): ToolGroup => ({
  group: name,
  tools,
  open: false,
  deferred: true,
});

function setup(groups: ToolGroup[], disabled = new Set<string>()) {
  const gate = fakeGate(groups);
  return { gate, ...harness((server) => registerOpenTool(server, { gate, disabled })) };
}

describe("open_drawer", () => {
  const groups = () => [
    { group: "memory", tools: ["search_notes"], open: true, deferred: false },
    deferred("mail", ["list_messages", "send_message"]),
    deferred("calendar", ["list_events"]),
  ];

  it("names the drawers it can open, so the model need not guess", () => {
    const { tools } = setup(groups());
    expect(tools.get(OPEN_TOOL)?.description).toContain("mail and calendar");
  });

  it("opens one and reports the tools that came with it", async () => {
    const { gate, text } = setup(groups());

    const reply = await text(OPEN_TOOL, { drawer: "mail" });

    expect(gate.inventory.find((g) => g.group === "mail")?.open).toBe(true);
    expect(reply).toContain("list_messages, send_message");
    // And what is still behind the curtain, so one call can lead to the next.
    expect(reply).toContain("Still closed: calendar");
  });

  it("says nothing is left to open once everything is", async () => {
    const { text } = setup(groups());
    await text(OPEN_TOOL, { drawer: "mail" });
    const reply = await text(OPEN_TOOL, { drawer: "calendar" });
    expect(reply).not.toContain("Still closed");
  });

  it("treats a second request as harmless", async () => {
    const { text } = setup(groups());
    await text(OPEN_TOOL, { drawer: "mail" });
    expect(await text(OPEN_TOOL, { drawer: "mail" })).toMatch(/already open/);
  });

  it("tolerates the case and spacing a model actually sends", async () => {
    const { gate, text } = setup(groups());
    await text(OPEN_TOOL, { drawer: " Mail " });
    expect(gate.inventory.find((g) => g.group === "mail")?.open).toBe(true);
  });

  it("answers an unknown name with the real list rather than an error", async () => {
    // A refusal the model can act on beats a stack trace it cannot.
    const reply = await setup(groups()).text(OPEN_TOOL, { drawer: "reminders" });
    expect(reply).toContain('no drawer called "reminders"');
    expect(reply).toContain("mail, calendar");
  });

  it("does not register when there is no drawer to open", () => {
    // A memory-only server: no second tier, so no tool advertising one.
    const { names } = setup([
      { group: "memory", tools: ["search_notes"], open: true, deferred: false },
    ]);
    expect(names()).toEqual([]);
  });

  it("registers nothing when the disabled set names it", () => {
    expect(setup(groups(), new Set([OPEN_TOOL])).names()).toEqual([]);
  });

  it("takes one parameter — it is in context for the whole waking session", () => {
    const { tools } = setup(groups());
    expect(Object.keys(tools.get(OPEN_TOOL)?.schema as object)).toEqual(["drawer"]);
  });
});
