import { joinCapabilities, renderInventory, ToolGroup } from "./capabilities";

const group = (name: string, tools: string[]): ToolGroup => ({
  group: name,
  tools,
  open: true,
  deferred: false,
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

describe("renderInventory()", () => {
  it("keeps a group the capability list never names, at the end", () => {
    // Stable sort: an unranked group holds its registration position rather
    // than being dropped or jumping the queue.
    const rendered = renderInventory(
      ["memory"],
      [group("something-new", ["a"]), group("memory", ["b"])]
    );
    expect(rendered).toBe("- **memory**: b\n- **something-new**: a");
  });

  it("drops a group that registered nothing", () => {
    expect(renderInventory(["memory"], [group("mail", [])])).toBe("");
  });
});
