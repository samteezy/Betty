import { validateSavePath, toLeanMessages, parseEmailFormat } from "./register";
import { EmailMessage } from "../types";
import { withEnv } from "../test-support/env";

// validateSavePath uses ATTACHMENT_DIR which resolves at module load from process.env.
// We need to set it before import, but since it's already imported, we test against
// the default (~/Downloads) or mock via jest.

// The module resolves ATTACHMENT_DIR at load time from process.env.ATTACHMENT_DIR.
// For these tests we rely on the default (homedir/Downloads).
import { homedir } from "node:os";
import { join } from "node:path";

const ATTACHMENT_DIR = join(homedir(), "Downloads");

describe("validateSavePath()", () => {
  it("accepts a path within ATTACHMENT_DIR", () => {
    const result = validateSavePath(join(ATTACHMENT_DIR, "file.pdf"));
    expect(result).toBe(join(ATTACHMENT_DIR, "file.pdf"));
  });

  it("accepts a subdirectory within ATTACHMENT_DIR", () => {
    const result = validateSavePath(join(ATTACHMENT_DIR, "sub", "file.pdf"));
    expect(result).toBe(join(ATTACHMENT_DIR, "sub", "file.pdf"));
  });

  it("rejects path traversal with ../", () => {
    expect(() =>
      validateSavePath(join(ATTACHMENT_DIR, "..", "etc", "passwd"))
    ).toThrow("saveTo must be within");
  });

  it("rejects absolute path outside ATTACHMENT_DIR", () => {
    expect(() => validateSavePath("/tmp/evil.pdf")).toThrow(
      "saveTo must be within"
    );
  });

  it("rejects path that escapes via symlink-like traversal", () => {
    expect(() =>
      validateSavePath(join(ATTACHMENT_DIR, "sub", "..", "..", "escape.pdf"))
    ).toThrow("saveTo must be within");
  });
});

describe("toLeanMessages()", () => {
  const messages: EmailMessage[] = [
    {
      id: "msg1",
      from: "alice@example.com",
      to: ["bob@example.com"],
      cc: ["carol@example.com"],
      subject: "Hello",
      date: "2026-01-01T00:00:00Z",
      snippet: "Hi there",
      body: "Hi there, how are you?",
      isRead: true,
      folder: "Inbox",
    },
    {
      id: "msg2",
      from: "bob@example.com",
      to: ["alice@example.com"],
      subject: "Re: Hello",
      date: "2026-01-02T00:00:00Z",
      snippet: "Good thanks",
      isRead: false,
      folder: "Sent",
    },
  ];

  it("returns lean fields without folder when includeFolder is false", () => {
    const result = toLeanMessages(messages, { includeFolder: false });
    expect(result[0]).toEqual({
      id: "msg1",
      from: "alice@example.com",
      subject: "Hello",
      date: "2026-01-01T00:00:00Z",
      snippet: "Hi there",
    });
    expect(result[0]).not.toHaveProperty("folder");
    expect(result[0]).not.toHaveProperty("to");
    expect(result[0]).not.toHaveProperty("cc");
    expect(result[0]).not.toHaveProperty("body");
    expect(result[0]).not.toHaveProperty("isRead");
  });

  it("includes folder when includeFolder is true", () => {
    const result = toLeanMessages(messages, { includeFolder: true });
    expect(result[0]).toHaveProperty("folder", "Inbox");
    expect(result[1]).toHaveProperty("folder", "Sent");
  });
});

describe("parseEmailFormat()", () => {
  const format = (value: string | undefined) =>
    withEnv({ EMAIL_FORMAT: value }, () => parseEmailFormat());

  it("defaults to plain when unset", () => {
    expect(format(undefined)).toBe("plain");
  });

  it("returns plain for explicit 'plain'", () => {
    expect(format("plain")).toBe("plain");
  });

  it("returns html for 'html'", () => {
    expect(format("html")).toBe("html");
  });

  it("is case-insensitive", () => {
    expect(format("HTML")).toBe("html");
  });

  it("trims whitespace", () => {
    expect(format("  html  ")).toBe("html");
  });

  it("defaults to plain for unknown values", () => {
    expect(format("markdown")).toBe("plain");
  });
});
