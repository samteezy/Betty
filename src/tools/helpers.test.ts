import {
  errorResult,
  jsonResult,
  parseDisabledTools,
  toolEnabled,
  toLean,
} from "./helpers";
import { withEnv } from "../test-support/env";

describe("errorResult()", () => {
  it("formats Error instances", () => {
    const result = errorResult(new Error("something broke"));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: something broke");
  });

  it("formats string errors", () => {
    const result = errorResult("plain string");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: plain string");
  });
});

describe("jsonResult()", () => {
  it("serializes objects", () => {
    const result = jsonResult({ a: 1 });
    expect(result.content[0].text).toBe('{"a":1}');
    expect(result.isError).toBeUndefined();
  });

  it("serializes arrays", () => {
    const result = jsonResult([1, 2, 3]);
    expect(result.content[0].text).toBe("[1,2,3]");
  });

  it("serializes null", () => {
    const result = jsonResult(null);
    expect(result.content[0].text).toBe("null");
  });
});

describe("parseDisabledTools()", () => {
  it("returns empty set when unset", () => {
    withEnv({ DISABLED_TOOLS: undefined }, () => {
      expect(parseDisabledTools().size).toBe(0);
    });
  });

  it("returns empty set for whitespace-only", () => {
    withEnv({ DISABLED_TOOLS: "   " }, () => {
      expect(parseDisabledTools().size).toBe(0);
    });
  });

  it("parses comma-separated tools", () => {
    withEnv({ DISABLED_TOOLS: "list_emails, send_email" }, () => {
      const disabled = parseDisabledTools();
      expect(disabled.has("list_emails")).toBe(true);
      expect(disabled.has("send_email")).toBe(true);
      expect(disabled.size).toBe(2);
    });
  });

  it("lowercases tool names", () => {
    withEnv({ DISABLED_TOOLS: "List_Emails" }, () => {
      expect(parseDisabledTools().has("list_emails")).toBe(true);
    });
  });
});

describe("toolEnabled()", () => {
  it("returns true when tool is not disabled", () => {
    expect(toolEnabled("list_emails", new Set())).toBe(true);
  });

  it("returns false when tool is disabled", () => {
    expect(toolEnabled("list_emails", new Set(["list_emails"]))).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(toolEnabled("List_Emails", new Set(["list_emails"]))).toBe(false);
  });
});

describe("toLean()", () => {
  interface Item {
    id: string;
    name: string;
    optional?: string;
    list?: string[];
  }

  const items: Item[] = [
    { id: "1", name: "Alice", optional: "yes", list: ["a"] },
    { id: "2", name: "Bob", list: [] },
    { id: "3", name: "Carol" },
  ];

  it("includes always-keys", () => {
    const result = toLean(items, ["id", "name"]);
    expect(result).toEqual([
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
      { id: "3", name: "Carol" },
    ]);
  });

  it("includes truthy-keys only when truthy", () => {
    const result = toLean(items, ["id"], ["optional", "list"]);
    expect(result).toEqual([
      { id: "1", optional: "yes", list: ["a"] },
      { id: "2" },
      { id: "3" },
    ]);
  });

  it("excludes empty arrays from truthy-keys", () => {
    const result = toLean(items, ["id"], ["list"]);
    expect(result[1]).toEqual({ id: "2" }); // list is empty
  });
});
