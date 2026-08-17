import { WebDavNotesBackend } from "./webdav-backend";
import { NoteConflictError, NoteNotFoundError } from "./errors";

jest.mock("../webdav/client", () => {
  const mockClient = {
    propfind: jest.fn(),
    report: jest.fn(),
    get: jest.fn(),
    put: jest.fn(),
    getWithEtag: jest.fn(),
    putWithEtag: jest.fn(),
    delete: jest.fn(),
    mkcol: jest.fn(),
    // A method missing here surfaces as "undefined is not a function" at
    // runtime, not as a compile error — so it is easy to forget.
    move: jest.fn(),
  };
  class WebDavError extends Error {
    constructor(
      public readonly status: number,
      message: string
    ) {
      super(`WebDAV error [${status}]: ${message}`);
      this.name = "WebDavError";
    }
  }
  return {
    WebDavClient: jest.fn(() => mockClient),
    WebDavError,
    __mockClient: mockClient,
  };
});

const { __mockClient: mockClient, WebDavError, WebDavClient } = jest.requireMock(
  "../webdav/client"
) as any;

// --- Test fixtures ---

const BASE_URL = "https://myfiles.fastmail.com";
const ROOT = "/sam@fastmail.com/Notes";

function entry(href: string, props: Record<string, string>) {
  return { href, props: new Map(Object.entries(props)) };
}

const COLLECTION = { resourcetype: "<d:collection/>" };

function makeBackend() {
  return new WebDavNotesBackend(new WebDavClient({} as any), { baseUrl: BASE_URL, root: ROOT });
}

function resetMocks() {
  for (const fn of Object.values(mockClient)) (fn as jest.Mock).mockReset();
}

beforeEach(resetMocks);

describe("list()", () => {
  it("maps hrefs back to paths relative to the notes root", async () => {
    mockClient.propfind.mockResolvedValue([
      entry(`${ROOT}/`, COLLECTION),
      entry(`${ROOT}/memory/`, COLLECTION),
      entry(`${ROOT}/index.md`, { getetag: '"e1"', getcontentlength: "42" }),
    ]);

    const entries = await makeBackend().list("");

    expect(entries).toEqual([
      { path: "index.md", name: "index.md", isDirectory: false, etag: '"e1"', size: 42 },
      { path: "memory", name: "memory", isDirectory: true },
    ]);
  });

  it("handles percent-encoded hrefs", async () => {
    mockClient.propfind.mockResolvedValue([
      entry(`${ROOT}/`, COLLECTION),
      entry(`${ROOT}/my%20note.md`, { getetag: '"e1"' }),
    ]);

    const entries = await makeBackend().list("");
    expect(entries[0].path).toBe("my note.md");
  });

  it("handles absolute-URL hrefs", async () => {
    mockClient.propfind.mockResolvedValue([
      entry(`${BASE_URL}${ROOT}/note.md`, { getetag: '"e1"' }),
    ]);

    const entries = await makeBackend().list("");
    expect(entries[0].path).toBe("note.md");
  });

  it("parses last-modified into an ISO timestamp", async () => {
    mockClient.propfind.mockResolvedValue([
      entry(`${ROOT}/note.md`, { getlastmodified: "Mon, 17 Aug 2026 10:00:00 GMT" }),
    ]);

    const entries = await makeBackend().list("");
    expect(entries[0].modified).toBe("2026-08-17T10:00:00.000Z");
  });

  it("skips dot-prefixed entries", async () => {
    // Obsidian ignores dot paths, so anything there is invisible to the user.
    mockClient.propfind.mockResolvedValue([
      entry(`${ROOT}/.obsidian/`, COLLECTION),
      entry(`${ROOT}/real.md`, {}),
    ]);

    const entries = await makeBackend().list("");
    expect(entries.map((e) => e.name)).toEqual(["real.md"]);
  });

  it("returns an empty listing for a missing directory", async () => {
    mockClient.propfind.mockRejectedValue(new WebDavError(404, "not found"));
    await expect(makeBackend().list("nope")).resolves.toEqual([]);
  });

  it("propagates unexpected errors", async () => {
    mockClient.propfind.mockRejectedValue(new WebDavError(500, "boom"));
    await expect(makeBackend().list("")).rejects.toThrow("boom");
  });
});

describe("read()", () => {
  it("returns body and etag", async () => {
    mockClient.getWithEtag.mockResolvedValue({ body: "# Note", etag: '"e1"' });

    await expect(makeBackend().read("memory/sam.md")).resolves.toEqual({
      text: "# Note",
      etag: '"e1"',
    });
    expect(mockClient.getWithEtag).toHaveBeenCalledWith(`${ROOT}/memory/sam.md`);
  });

  it("throws NoteNotFoundError on 404", async () => {
    mockClient.getWithEtag.mockRejectedValue(new WebDavError(404, "gone"));
    await expect(makeBackend().read("missing.md")).rejects.toBeInstanceOf(NoteNotFoundError);
  });
});

describe("write() — conditional update", () => {
  it("sends the real etag as If-Match, not a wildcard", async () => {
    // The whole point of the ETag work: If-Match "*" only asserts existence
    // and would clobber a concurrent human edit.
    mockClient.putWithEtag.mockResolvedValue({ etag: '"e2"' });

    await makeBackend().write("memory/sam.md", "body", '"e1"');

    const [path, body, headers] = mockClient.putWithEtag.mock.calls[0];
    expect(path).toBe(`${ROOT}/memory/sam.md`);
    expect(body).toBe("body");
    expect(headers["If-Match"]).toBe('"e1"');
    expect(headers["If-Match"]).not.toBe("*");
    expect(headers["If-None-Match"]).toBeUndefined();
    expect(headers["Content-Type"]).toBe("text/markdown; charset=utf-8");
  });

  it("returns the etag the server assigned", async () => {
    mockClient.putWithEtag.mockResolvedValue({ etag: '"e2"' });
    await expect(makeBackend().write("memory/sam.md", "body", '"e1"')).resolves.toEqual({
      etag: '"e2"',
    });
  });

  it("throws NoteConflictError on 412", async () => {
    mockClient.putWithEtag.mockRejectedValue(new WebDavError(412, "precondition failed"));

    await expect(makeBackend().write("memory/sam.md", "body", '"stale"')).rejects.toBeInstanceOf(
      NoteConflictError
    );
  });

  it("tells the caller to re-read rather than retry blindly", async () => {
    mockClient.putWithEtag.mockRejectedValue(new WebDavError(412, "precondition failed"));

    await expect(makeBackend().write("memory/sam.md", "body", '"stale"')).rejects.toThrow(
      /changed since Betty last read it/
    );
  });

  it("does not silently fall back to an unconditional write on conflict", async () => {
    mockClient.putWithEtag.mockRejectedValue(new WebDavError(412, "precondition failed"));

    await expect(makeBackend().write("memory/sam.md", "body", '"stale"')).rejects.toThrow();
    expect(mockClient.putWithEtag).toHaveBeenCalledTimes(1);
  });

  it("throws NoteNotFoundError when the target disappeared", async () => {
    mockClient.putWithEtag.mockRejectedValue(new WebDavError(404, "gone"));
    await expect(makeBackend().write("memory/sam.md", "b", '"e1"')).rejects.toBeInstanceOf(
      NoteNotFoundError
    );
  });

  it("fetches the etag separately when the server does not return one", async () => {
    mockClient.putWithEtag.mockResolvedValue({ etag: undefined });
    // Two PROPFINDs now: the precondition check before the PUT sees the etag
    // the caller holds, the lookup after it sees the new one.
    mockClient.propfind
      .mockResolvedValueOnce([entry(`${ROOT}/memory/sam.md`, { getetag: '"e1"' })])
      .mockResolvedValueOnce([entry(`${ROOT}/memory/sam.md`, { getetag: '"e3"' })]);

    await expect(makeBackend().write("memory/sam.md", "b", '"e1"')).resolves.toEqual({
      etag: '"e3"',
    });
  });

  it("still reports success when the follow-up etag lookup fails", async () => {
    mockClient.putWithEtag.mockResolvedValue({ etag: undefined });
    mockClient.propfind.mockRejectedValue(new WebDavError(500, "boom"));

    await expect(makeBackend().write("memory/sam.md", "b", '"e1"')).resolves.toEqual({
      etag: undefined,
    });
  });
});

describe("write() — create", () => {
  it("sends If-None-Match: * rather than an unconditional PUT", async () => {
    mockClient.putWithEtag.mockResolvedValue({ etag: '"e1"' });

    await makeBackend().write("memory/new.md", "body");

    const headers = mockClient.putWithEtag.mock.calls[0][2];
    expect(headers["If-None-Match"]).toBe("*");
    expect(headers["If-Match"]).toBeUndefined();
  });

  it("throws NoteConflictError when the file already exists", async () => {
    mockClient.putWithEtag.mockRejectedValue(new WebDavError(412, "exists"));

    await expect(makeBackend().write("memory/new.md", "body")).rejects.toThrow(
      /a file already exists there/
    );
  });

  it("creates missing parent collections top-down and retries once", async () => {
    mockClient.putWithEtag
      .mockRejectedValueOnce(new WebDavError(409, "no parent"))
      .mockResolvedValueOnce({ etag: '"e1"' });
    mockClient.mkcol.mockResolvedValue(undefined);

    await expect(makeBackend().write("memory/people/sam.md", "body")).resolves.toEqual({
      etag: '"e1"',
    });

    expect(mockClient.mkcol.mock.calls.map((c: string[]) => c[0])).toEqual([
      `${ROOT}/memory`,
      `${ROOT}/memory/people`,
    ]);
    expect(mockClient.putWithEtag).toHaveBeenCalledTimes(2);
  });

  it("surfaces a conflict raised by the retry", async () => {
    mockClient.putWithEtag
      .mockRejectedValueOnce(new WebDavError(409, "no parent"))
      .mockRejectedValueOnce(new WebDavError(412, "exists"));
    mockClient.mkcol.mockResolvedValue(undefined);

    await expect(makeBackend().write("memory/people/sam.md", "b")).rejects.toBeInstanceOf(
      NoteConflictError
    );
  });

  it("does not attempt parent creation on a conditional update", async () => {
    // A 409 during an update is not a missing-parent problem.
    mockClient.putWithEtag.mockRejectedValue(new WebDavError(409, "conflict"));

    await expect(makeBackend().write("memory/sam.md", "b", '"e1"')).rejects.toThrow();
    expect(mockClient.mkcol).not.toHaveBeenCalled();
  });
});

describe("connect()", () => {
  it("explains how to fix a 404 on the notes root", async () => {
    mockClient.propfind.mockRejectedValue(new WebDavError(404, "not found"));
    await expect(makeBackend().connect()).rejects.toThrow(/NOTES_ROOT not found/);
  });

  it("propagates an auth failure as-is", async () => {
    mockClient.propfind.mockRejectedValue(new WebDavError(401, "unauthorized"));
    await expect(makeBackend().connect()).rejects.toThrow(/401/);
  });
});

describe("move()", () => {
  it("moves via the client with root-joined paths", async () => {
    mockClient.move.mockResolvedValue(undefined);

    await makeBackend().move("memory/sam.md", "trash/sam.md");

    expect(mockClient.move).toHaveBeenCalledWith(`${ROOT}/memory/sam.md`, `${ROOT}/trash/sam.md`);
  });

  it("maps 412 to a conflict naming the destination", async () => {
    // RFC 4918 §9.9.4: Overwrite "F" against a non-null destination is a 412.
    mockClient.move.mockRejectedValue(new WebDavError(412, "precondition failed"));

    await expect(makeBackend().move("memory/sam.md", "trash/sam.md")).rejects.toThrow(
      NoteConflictError
    );
    await expect(makeBackend().move("memory/sam.md", "trash/sam.md")).rejects.toThrow(
      /trash\/sam\.md/
    );
  });

  it("maps 404 to not-found naming the source", async () => {
    mockClient.move.mockRejectedValue(new WebDavError(404, "not found"));

    await expect(makeBackend().move("memory/sam.md", "trash/sam.md")).rejects.toThrow(
      NoteNotFoundError
    );
  });

  it("creates missing parent collections on 409 and retries", async () => {
    mockClient.move
      .mockRejectedValueOnce(new WebDavError(409, "conflict"))
      .mockResolvedValueOnce(undefined);
    mockClient.mkcol.mockResolvedValue(undefined);

    await makeBackend().move("memory/sam.md", "trash/2026/sam.md");

    expect(mockClient.mkcol).toHaveBeenCalledWith(`${ROOT}/trash`);
    expect(mockClient.mkcol).toHaveBeenCalledWith(`${ROOT}/trash/2026`);
    expect(mockClient.move).toHaveBeenCalledTimes(2);
  });

  it("reports a second 409 as a parent-folder failure", async () => {
    mockClient.move.mockRejectedValue(new WebDavError(409, "conflict"));
    mockClient.mkcol.mockResolvedValue(undefined);

    await expect(makeBackend().move("memory/sam.md", "trash/sam.md")).rejects.toThrow(
      /parent folder could not be created/
    );
  });

  it("leaves a 403 as a WebDavError rather than dressing it up as a conflict", async () => {
    // Telling the model to retry under another name cannot fix a permission
    // failure, so the real status has to survive.
    mockClient.move.mockRejectedValue(new WebDavError(403, "forbidden"));

    await expect(makeBackend().move("memory/sam.md", "trash/sam.md")).rejects.not.toThrow(
      NoteConflictError
    );
    await expect(makeBackend().move("memory/sam.md", "trash/sam.md")).rejects.toThrow(/403/);
  });

  it("leaves a 507 quota failure as a WebDavError", async () => {
    mockClient.move.mockRejectedValue(new WebDavError(507, "insufficient storage"));

    await expect(makeBackend().move("memory/sam.md", "trash/sam.md")).rejects.toThrow(/507/);
  });
});

describe("preconditions are enforced client-side", () => {
  // Fastmail Files accepts a PUT carrying a stale If-Match, a bogus one, or
  // If-None-Match:* against a file that exists — verified against the live
  // service. A client trusting the header alone silently clobbers a concurrent
  // human edit on the backend this project documents first.
  const etagResponse = (tag: string) => [entry(`${ROOT}/memory/sam.md`, { getetag: tag })];

  it("refuses a stale conditional write without ever sending the PUT", async () => {
    mockClient.propfind.mockResolvedValue(etagResponse('"current"'));

    await expect(makeBackend().write("memory/sam.md", "body", '"stale"')).rejects.toBeInstanceOf(
      NoteConflictError
    );
    expect(mockClient.putWithEtag).not.toHaveBeenCalled();
  });

  it("tells the model to re-read rather than retry blindly", async () => {
    mockClient.propfind.mockResolvedValue(etagResponse('"current"'));

    await expect(makeBackend().write("memory/sam.md", "b", '"stale"')).rejects.toThrow(
      /changed since Betty last read it/
    );
  });

  it("allows a conditional write when the etag still matches", async () => {
    mockClient.propfind.mockResolvedValue(etagResponse('"e1"'));
    mockClient.putWithEtag.mockResolvedValue({ etag: '"e2"' });

    await expect(makeBackend().write("memory/sam.md", "body", '"e1"')).resolves.toEqual({
      etag: '"e2"',
    });
    expect(mockClient.putWithEtag).toHaveBeenCalledTimes(1);
  });

  it("still sends If-Match, so servers that enforce it keep the atomic guarantee", async () => {
    mockClient.propfind.mockResolvedValue(etagResponse('"e1"'));
    mockClient.putWithEtag.mockResolvedValue({ etag: '"e2"' });

    await makeBackend().write("memory/sam.md", "body", '"e1"');

    expect(mockClient.putWithEtag.mock.calls[0][2]["If-Match"]).toBe('"e1"');
  });

  it("does not block a conditional write when the server reports no etag", async () => {
    // Inconclusive is not the same as mismatched; let the PUT decide.
    mockClient.propfind.mockResolvedValue([entry(`${ROOT}/memory/sam.md`, {})]);
    mockClient.putWithEtag.mockResolvedValue({ etag: '"e2"' });

    await expect(makeBackend().write("memory/sam.md", "body", '"e1"')).resolves.toBeDefined();
  });

  it("refuses a create when something already exists there", async () => {
    mockClient.propfind.mockResolvedValue(etagResponse('"e1"'));

    await expect(makeBackend().write("memory/sam.md", "body")).rejects.toBeInstanceOf(
      NoteConflictError
    );
    expect(mockClient.putWithEtag).not.toHaveBeenCalled();
  });

  it("refuses a create even when the server returns no etag for the existing file", async () => {
    // This is the seeding path: a missing etag must not read as "nothing here",
    // or every startup would rewrite the user's edited SKILL.md.
    mockClient.propfind.mockResolvedValue([entry(`${ROOT}/memory/sam.md`, {})]);

    await expect(makeBackend().write("memory/sam.md", "body")).rejects.toBeInstanceOf(
      NoteConflictError
    );
  });

  it("allows a create when nothing is there", async () => {
    mockClient.propfind.mockRejectedValue(new WebDavError(404, "not found"));
    mockClient.putWithEtag.mockResolvedValue({ etag: '"e1"' });

    await expect(makeBackend().write("memory/sam.md", "body")).resolves.toEqual({ etag: '"e1"' });
    expect(mockClient.putWithEtag.mock.calls[0][2]["If-None-Match"]).toBe("*");
  });
});
