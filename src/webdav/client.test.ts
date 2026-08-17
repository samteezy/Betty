import { WebDavClient, WebDavError } from "./client";

const CONFIG = {
  baseUrl: "https://dav.example.com/",
  username: "user",
  password: "pass",
};

function makeResponse(
  body = "",
  init: { status?: number; headers?: Record<string, string> } = {}
) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers(init.headers ?? {}),
    text: async () => body,
  } as unknown as Response;
}

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn().mockResolvedValue(makeResponse());
  global.fetch = fetchMock as unknown as typeof fetch;
});

function lastCall() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: url as string, init: init as RequestInit & { headers: Record<string, string> } };
}

describe("existing behaviour is unchanged", () => {
  it("sends Basic auth", async () => {
    await new WebDavClient(CONFIG).get("file.txt");

    expect(lastCall().init.headers.Authorization).toBe(
      `Basic ${Buffer.from("user:pass").toString("base64")}`
    );
  });

  it("strips the trailing slash from the base URL", async () => {
    await new WebDavClient(CONFIG).get("file.txt");
    expect(lastCall().url).toBe("https://dav.example.com/file.txt");
  });

  it("resolves server-absolute paths against the origin", async () => {
    await new WebDavClient(CONFIG).get("/dav/file.txt");
    expect(lastCall().url).toBe("https://dav.example.com/dav/file.txt");
  });

  it("get() still returns the body as a plain string", async () => {
    fetchMock.mockResolvedValue(makeResponse("BEGIN:VCALENDAR"));
    await expect(new WebDavClient(CONFIG).get("a.ics")).resolves.toBe("BEGIN:VCALENDAR");
  });

  it("put() still defaults to the calendar content type", async () => {
    await new WebDavClient(CONFIG).put("a.ics", "DATA");

    const { init } = lastCall();
    expect(init.headers["Content-Type"]).toBe("text/calendar; charset=utf-8");
    expect(init.body).toBe("DATA");
  });

  it("put() still lets callers override headers", async () => {
    await new WebDavClient(CONFIG).put("a.ics", "DATA", { "If-Match": "*" });
    expect(lastCall().init.headers["If-Match"]).toBe("*");
  });

  it("throws WebDavError carrying the status", async () => {
    fetchMock.mockResolvedValue(makeResponse("nope", { status: 404 }));

    await expect(new WebDavClient(CONFIG).get("missing")).rejects.toMatchObject({
      name: "WebDavError",
      status: 404,
    });
  });

  it("refuses to send credentials to a foreign origin", async () => {
    await expect(new WebDavClient(CONFIG).get("https://evil.example/steal")).rejects.toThrow(
      /foreign origin/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to follow a redirect to a foreign origin", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse("", { status: 302, headers: { location: "https://evil.example/steal" } })
    );

    await expect(new WebDavClient(CONFIG).get("file.txt")).rejects.toThrow(/foreign origin/);
  });

  it("follows a same-origin redirect while preserving method and body", async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeResponse("", { status: 307, headers: { location: "/moved.ics" } })
      )
      .mockResolvedValueOnce(makeResponse("OK"));

    await new WebDavClient(CONFIG).put("a.ics", "DATA");

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://dav.example.com/moved.ics");
    expect((init as RequestInit).method).toBe("PUT");
    expect((init as RequestInit).body).toBe("DATA");
  });
});

describe("getWithEtag()", () => {
  it("returns body and etag together", async () => {
    fetchMock.mockResolvedValue(makeResponse("# Note", { headers: { etag: '"e1"' } }));

    await expect(new WebDavClient(CONFIG).getWithEtag("note.md")).resolves.toEqual({
      body: "# Note",
      etag: '"e1"',
    });
  });

  it("returns undefined when the server omits the header", async () => {
    fetchMock.mockResolvedValue(makeResponse("# Note"));

    expect((await new WebDavClient(CONFIG).getWithEtag("note.md")).etag).toBeUndefined();
  });
});

describe("putWithEtag()", () => {
  it("returns the etag the server assigned", async () => {
    fetchMock.mockResolvedValue(makeResponse("", { headers: { etag: '"e2"' } }));

    await expect(new WebDavClient(CONFIG).putWithEtag("note.md", "body")).resolves.toEqual({
      etag: '"e2"',
    });
  });

  it("passes conditional headers through", async () => {
    await new WebDavClient(CONFIG).putWithEtag("note.md", "body", {
      "Content-Type": "text/markdown; charset=utf-8",
      "If-Match": '"e1"',
    });

    const { init } = lastCall();
    expect(init.method).toBe("PUT");
    expect(init.headers["If-Match"]).toBe('"e1"');
    expect(init.headers["Content-Type"]).toBe("text/markdown; charset=utf-8");
  });

  it("surfaces a 412 as a WebDavError so callers can detect a conflict", async () => {
    fetchMock.mockResolvedValue(makeResponse("", { status: 412 }));

    await expect(
      new WebDavClient(CONFIG).putWithEtag("note.md", "body", { "If-Match": '"stale"' })
    ).rejects.toMatchObject({ status: 412 });
  });
});

describe("delete()", () => {
  it("issues a DELETE", async () => {
    await new WebDavClient(CONFIG).delete("note.md");

    expect(lastCall().init.method).toBe("DELETE");
  });

  it("sends If-Match when given", async () => {
    await new WebDavClient(CONFIG).delete("note.md", '"e1"');
    expect(lastCall().init.headers["If-Match"]).toBe('"e1"');
  });
});

describe("mkcol()", () => {
  it("issues a MKCOL", async () => {
    fetchMock.mockResolvedValue(makeResponse("", { status: 201 }));
    await new WebDavClient(CONFIG).mkcol("dir");

    expect(lastCall().init.method).toBe("MKCOL");
  });

  it("treats 405 as already-exists so parent creation is idempotent", async () => {
    fetchMock.mockResolvedValue(makeResponse("", { status: 405 }));

    await expect(new WebDavClient(CONFIG).mkcol("dir")).resolves.toBeUndefined();
  });

  it("still throws on a real failure", async () => {
    fetchMock.mockResolvedValue(makeResponse("", { status: 403 }));

    await expect(new WebDavClient(CONFIG).mkcol("dir")).rejects.toMatchObject({ status: 403 });
  });
});

describe("WebDavError", () => {
  it("keeps the status accessible for precondition handling", () => {
    expect(new WebDavError(412, "precondition failed").status).toBe(412);
  });
});
