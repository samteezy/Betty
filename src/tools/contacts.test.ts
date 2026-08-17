import { registerContactTools, ContactsToolConfig } from "./contacts";
import { harness } from "../test-support/mcp";
import { FakeContactsBackend, makeContact } from "../test-support/backends";
import { withEnv } from "../test-support/env";
import { ListContactsOptions, SearchContactsOptions } from "../types";

function setup(config: ContactsToolConfig = {}) {
  const backend = new FakeContactsBackend();
  const h = harness((server) => registerContactTools(server, backend, config));
  return { backend, ...h };
}

describe("registration", () => {
  it("registers all four contact tools", () => {
    expect(setup().names()).toEqual([
      "get_contact",
      "list_address_books",
      "list_contacts",
      "search_contacts",
    ]);
  });

  it("honours DISABLED_TOOLS", () => {
    const { tools } = withEnv(
      { DISABLED_TOOLS: "list_address_books" },
      () => setup()
    );

    expect(tools.has("list_address_books")).toBe(false);
    expect(tools.has("list_contacts")).toBe(true);
    expect(tools.has("search_contacts")).toBe(true);
  });
});

describe("list_address_books", () => {
  it("returns the backend's address books unprojected", async () => {
    const { backend, json } = setup();
    backend.addressBooks = [
      { href: "/addressbooks/personal/", name: "Personal", description: "Mine" },
    ];

    const books = await json("list_address_books");

    expect(books).toEqual([
      { href: "/addressbooks/personal/", name: "Personal", description: "Mine" },
    ]);
  });

  it("surfaces backend failures as tool errors", async () => {
    const { backend, call } = setup();
    backend.failWith = new Error("CardDAV unreachable");

    const result = await call("list_address_books");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: CardDAV unreachable");
  });
});

describe("list_contacts", () => {
  it("forwards addressBook and limit to the backend", async () => {
    const { backend, json } = setup();
    await json("list_contacts", { addressBook: "Work", limit: 10 });

    expect(backend.lastCall<ListContactsOptions>("listContacts")).toEqual({
      addressBook: "Work",
      limit: 10,
    });
  });

  it("projects lean fields by default", async () => {
    const { backend, json } = setup();
    backend.contacts = [
      makeContact({
        id: "c1",
        href: "/contacts/c1.vcf",
        name: "Alice Example",
        emails: ["alice@example.com"],
        phones: ["+15551234"],
        organization: "Example Corp",
        title: "Engineer",
        notes: "Met in 2024",
      }),
    ];

    const [contact] = await json("list_contacts");

    expect(contact).toEqual({
      id: "c1",
      href: "/contacts/c1.vcf",
      name: "Alice Example",
      addressBook: "Personal",
      emails: ["alice@example.com"],
      phones: ["+15551234"],
    });
    expect(contact.organization).toBeUndefined();
    expect(contact.notes).toBeUndefined();
  });

  it("omits empty email and phone arrays", async () => {
    // toLean() drops empty arrays — an "emails": [] key is pure noise.
    const { backend, json } = setup();
    backend.contacts = [
      makeContact({ id: "c1", emails: [], phones: ["+15551234"] }),
    ];

    const [contact] = await json("list_contacts");

    expect("emails" in contact).toBe(false);
    expect(contact.phones).toEqual(["+15551234"]);
  });

  it("returns every field when verbose", async () => {
    const { backend, json } = setup();
    backend.contacts = [
      makeContact({ id: "c1", organization: "Example Corp", notes: "Met in 2024" }),
    ];

    const [contact] = await json("list_contacts", { verbose: true });

    expect(contact.organization).toBe("Example Corp");
    expect(contact.notes).toBe("Met in 2024");
  });

  it("includes addressBook only when no address book filter applies", async () => {
    const { backend, json } = setup();
    backend.contacts = [makeContact({ id: "c1" })];

    const [unfiltered] = await json("list_contacts");
    expect(unfiltered.addressBook).toBe("Personal");

    const [filtered] = await json("list_contacts", { addressBook: "Work" });
    expect(filtered.addressBook).toBeUndefined();
  });

  it("surfaces backend failures as tool errors", async () => {
    const { backend, call } = setup();
    backend.failWith = new Error("CardDAV unreachable");

    const result = await call("list_contacts");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: CardDAV unreachable");
  });
});

describe("default address book", () => {
  it("applies the configured default when the call omits one", async () => {
    const { backend, json } = setup({ defaultAddressBook: "Work" });
    await json("list_contacts");

    expect(backend.lastCall<ListContactsOptions>("listContacts").addressBook).toBe(
      "Work"
    );
  });

  it("lets an explicit address book win over the default", async () => {
    const { backend, json } = setup({ defaultAddressBook: "Work" });
    await json("list_contacts", { addressBook: "Personal" });

    expect(backend.lastCall<ListContactsOptions>("listContacts").addressBook).toBe(
      "Personal"
    );
  });

  it("applies to search_contacts too", async () => {
    const { backend, json } = setup({ defaultAddressBook: "Work" });
    await json("search_contacts", { query: "alice" });

    expect(
      backend.lastCall<SearchContactsOptions>("searchContacts").addressBook
    ).toBe("Work");
  });

  it("suppresses the addressBook column once a default is configured", async () => {
    const { backend, json } = setup({ defaultAddressBook: "Work" });
    backend.contacts = [makeContact({ id: "c1" })];

    const [contact] = await json("list_contacts");
    expect(contact.addressBook).toBeUndefined();
  });
});

describe("get_contact", () => {
  it("returns the contact when found", async () => {
    const { backend, json } = setup();
    backend.contacts = [
      makeContact({ id: "c1", href: "/contacts/c1.vcf", name: "Alice Example" }),
    ];

    const contact = await json("get_contact", { href: "/contacts/c1.vcf" });

    expect(contact.name).toBe("Alice Example");
  });

  it("reports a missing contact as an error", async () => {
    const { call } = setup();

    const result = await call("get_contact", { href: "/contacts/nope.vcf" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Contact not found");
  });

  it("returns the full contact, not the lean projection", async () => {
    const { backend, json } = setup();
    backend.contacts = [
      makeContact({
        id: "c1",
        href: "/contacts/c1.vcf",
        organization: "Example Corp",
      }),
    ];

    const contact = await json("get_contact", { href: "/contacts/c1.vcf" });

    expect(contact.organization).toBe("Example Corp");
  });
});

describe("search_contacts", () => {
  it("forwards the query, address book and limit", async () => {
    const { backend, json } = setup();
    await json("search_contacts", {
      query: "alice",
      addressBook: "Work",
      limit: 5,
    });

    expect(backend.lastCall<SearchContactsOptions>("searchContacts")).toEqual({
      query: "alice",
      addressBook: "Work",
      limit: 5,
    });
  });

  it("projects lean fields by default and everything when verbose", async () => {
    const { backend, json } = setup();
    backend.contacts = [makeContact({ id: "c1", organization: "Example Corp" })];

    const [lean] = await json("search_contacts", { query: "alice" });
    expect(lean.organization).toBeUndefined();

    const [verbose] = await json("search_contacts", {
      query: "alice",
      verbose: true,
    });
    expect(verbose.organization).toBe("Example Corp");
  });

  it("surfaces backend failures as tool errors", async () => {
    const { backend, call } = setup();
    backend.failWith = new Error("search index offline");

    const result = await call("search_contacts", { query: "alice" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: search index offline");
  });
});
