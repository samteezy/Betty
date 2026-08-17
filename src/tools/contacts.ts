import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ContactsBackend, Contact } from "../types.js";
import {
  errorResult,
  jsonResult,
  parseDisabledTools,
  toLean,
  toolEnabled,
} from "./helpers.js";

function toLeanContacts(
  contacts: Contact[],
  opts: { includeAddressBook: boolean }
) {
  const always: (keyof Contact)[] = ["id", "href", "name"];
  if (opts.includeAddressBook) always.push("addressBook");
  return toLean(contacts, always, ["emails", "phones"]);
}

/**
 * Config is passed in rather than read from process.env here, so tool handlers
 * stay free of transport and environment concerns.
 */
export interface ContactsToolConfig {
  /** Address book used when a tool call omits one. */
  defaultAddressBook?: string;
}

export function registerContactTools(
  server: McpServer,
  backend: ContactsBackend,
  config: ContactsToolConfig = {}
): void {
  const disabled = parseDisabledTools();
  const defaultAddressBook = config.defaultAddressBook;

  if (toolEnabled("list_address_books", disabled)) {
    server.tool(
      "list_address_books",
      "List all address books",
      {},
      async () => {
        try {
          const books = await backend.listAddressBooks();
          return jsonResult(books);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("list_contacts", disabled)) {
    server.tool(
      "list_contacts",
      "List contacts from address books",
      {
        addressBook: z
          .string()
          .optional()
          .describe("Address book name to filter by"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max contacts to return (default 50)"),
        verbose: z
          .boolean()
          .optional()
          .describe(
            "Return all fields (organization, title, address, notes) — default returns only id, href, name, emails, phones, addressBook"
          ),
      },
      async ({ addressBook, limit, verbose }) => {
        try {
          const book = addressBook ?? defaultAddressBook;
          const contacts = await backend.listContacts({ addressBook: book, limit });
          if (verbose) return jsonResult(contacts);
          return jsonResult(
            toLeanContacts(contacts, { includeAddressBook: !book })
          );
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("get_contact", disabled)) {
    server.tool(
      "get_contact",
      "Get a single contact by href",
      {
        href: z
          .string()
          .describe("The contact href (from list_contacts or search_contacts)"),
      },
      async ({ href }) => {
        try {
          const contact = await backend.getContact(href);
          if (!contact) {
            return {
              content: [{ type: "text" as const, text: "Contact not found" }],
              isError: true,
            };
          }
          return jsonResult(contact);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("search_contacts", disabled)) {
    server.tool(
      "search_contacts",
      "Search contacts by name, email, phone, or organization",
      {
        query: z.string().describe("Search text"),
        addressBook: z
          .string()
          .optional()
          .describe("Address book to search within"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max results (default 50)"),
        verbose: z
          .boolean()
          .optional()
          .describe(
            "Return all fields (organization, title, address, notes) — default returns only id, href, name, emails, phones, addressBook"
          ),
      },
      async ({ query, addressBook, limit, verbose }) => {
        try {
          const book = addressBook ?? defaultAddressBook;
          const contacts = await backend.searchContacts({
            query,
            addressBook: book,
            limit,
          });
          if (verbose) return jsonResult(contacts);
          return jsonResult(
            toLeanContacts(contacts, { includeAddressBook: !book })
          );
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }
}
