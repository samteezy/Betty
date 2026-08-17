import {
  AddressBookInfo,
  CalendarBackend,
  CalendarEvent,
  CalendarInfo,
  Contact,
  ContactsBackend,
  CreateTaskOptions,
  ListContactsOptions,
  ListEventsOptions,
  ListTasksOptions,
  NoteEntry,
  NoteRead,
  NotesBackend,
  NoteWriteResult,
  SearchContactsOptions,
  SearchEventsOptions,
  SearchTasksOptions,
  TaskBackend,
  TaskInfo,
  UpdateTaskOptions,
} from "../types.js";
import {
  NoteConflictError,
  NoteNotFoundError,
  conflictMessage,
  existsMessage,
} from "../notes/errors.js";

/**
 * In-memory backends for tool-layer tests.
 *
 * Each implements the real interface from `../types.js`, so a change to an
 * interface breaks compilation here rather than silently leaving the fakes
 * behind. Excluded from the published build — see `tsconfig.json`.
 */

// --- Notes ---

export interface MemoryNotesOptions {
  /** Make every write throw, as skills storage does. */
  readOnly?: boolean;
}

/**
 * NotesBackend with real etag semantics: each write bumps a version, and
 * conditional writes are checked against it. Tests of the conflict paths are
 * only meaningful against a backend that can actually produce a conflict.
 */
export class MemoryNotesBackend implements NotesBackend {
  files = new Map<string, string>();
  /** Every path passed to read(), in order — for asserting what was fetched. */
  reads: string[] = [];
  /** Every move performed, in order — so a test can assert the tool reached
   *  the backend rather than inferring it from the file map. */
  moves: Array<{ from: string; to: string }> = [];
  private versions = new Map<string, number>();

  constructor(private readonly options: MemoryNotesOptions = {}) {}

  seed(path: string, text: string): void {
    this.files.set(path, text);
    this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
  }

  private etag(path: string): string {
    return `"v${this.versions.get(path) ?? 0}"`;
  }

  async connect(): Promise<void> {}

  async list(dir: string): Promise<NoteEntry[]> {
    const prefix = dir ? `${dir}/` : "";
    const seen = new Map<string, NoteEntry>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest) continue;
      const [head, ...tail] = rest.split("/");
      const childPath = `${prefix}${head}`;
      if (seen.has(childPath)) continue;
      const isDirectory = tail.length > 0;
      seen.set(childPath, {
        path: childPath,
        name: head,
        isDirectory,
        etag: isDirectory ? undefined : this.etag(childPath),
      });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(path: string): Promise<NoteRead> {
    this.reads.push(path);
    const text = this.files.get(path);
    if (text === undefined) throw new NoteNotFoundError(path);
    return { text, etag: this.etag(path) };
  }

  async write(
    path: string,
    text: string,
    ifMatch?: string
  ): Promise<NoteWriteResult> {
    if (this.options.readOnly) throw new Error("storage is read-only");
    const exists = this.files.has(path);
    if (ifMatch === undefined) {
      // No etag means create-only. There is deliberately no overwrite path.
      if (exists) throw new NoteConflictError(existsMessage(path));
    } else {
      if (!exists) throw new NoteNotFoundError(path);
      if (ifMatch !== this.etag(path)) {
        throw new NoteConflictError(conflictMessage(path));
      }
    }
    this.seed(path, text);
    return { etag: this.etag(path) };
  }

  async move(from: string, to: string): Promise<void> {
    if (this.options.readOnly) throw new Error("storage is read-only");
    const text = this.files.get(from);
    if (text === undefined) throw new NoteNotFoundError(from);
    if (this.files.has(to)) throw new NoteConflictError(existsMessage(to));
    this.moves.push({ from, to });
    this.files.delete(from);
    this.versions.delete(from);
    this.seed(to, text);
  }
}

// --- Recording fakes for the CalDAV/CardDAV-backed tools ---

export interface RecordedCall {
  method: string;
  args: unknown;
}

/**
 * Shared recording machinery. The tasks/calendar/contacts tool layers are a
 * thin passthrough plus a lean projection, so the assertion that matters is
 * "what exact options object did the backend receive" — hence recording rather
 * than stubbing.
 */
class RecordingBackend {
  calls: RecordedCall[] = [];
  /** When set, every method rejects with this — drives the errorResult paths. */
  failWith?: Error;

  protected record<T>(method: string, args: unknown, result: T): T {
    this.calls.push({ method, args });
    if (this.failWith) throw this.failWith;
    return result;
  }

  /** Args of the most recent call to `method`. Throws if never called. */
  lastCall<T = unknown>(method: string): T {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      if (this.calls[i].method === method) return this.calls[i].args as T;
    }
    throw new Error(`Backend method never called: ${method}`);
  }

  /** How many times `method` was called. */
  countCalls(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

export class FakeTaskBackend extends RecordingBackend implements TaskBackend {
  calendars: CalendarInfo[] = [];
  tasks: TaskInfo[] = [];

  async connect(): Promise<void> {}

  async listCalendars(): Promise<CalendarInfo[]> {
    return this.record("listCalendars", undefined, this.calendars);
  }

  async listTasks(options?: ListTasksOptions): Promise<TaskInfo[]> {
    return this.record("listTasks", options, this.tasks);
  }

  async getTask(href: string): Promise<TaskInfo | null> {
    const found = this.tasks.find((t) => t.href === href) ?? null;
    return this.record("getTask", href, found);
  }

  async searchTasks(options: SearchTasksOptions): Promise<TaskInfo[]> {
    return this.record("searchTasks", options, this.tasks);
  }

  async createTask(options: CreateTaskOptions): Promise<TaskInfo> {
    const created: TaskInfo = {
      id: `created-${this.countCalls("createTask") + 1}`,
      href: `/tasks/created-${this.countCalls("createTask") + 1}.ics`,
      calendar: options.calendar ?? "Default",
      title: options.title,
      status: options.status ?? "NEEDS-ACTION",
      description: options.description,
      due: options.due,
      priority: options.priority,
      categories: options.categories,
    };
    return this.record("createTask", options, created);
  }

  async updateTask(options: UpdateTaskOptions): Promise<TaskInfo> {
    const existing = this.tasks.find((t) => t.href === options.href);
    // options.href is the same href we looked up, so spreading it is a no-op.
    const updated: TaskInfo = {
      ...(existing ?? makeTask({ href: options.href })),
      ...options,
    };
    return this.record("updateTask", options, updated);
  }

  async completeTask(href: string): Promise<TaskInfo> {
    const existing = this.tasks.find((t) => t.href === href);
    const completed: TaskInfo = {
      ...(existing ?? makeTask({ href })),
      status: "COMPLETED",
      percentComplete: 100,
    };
    return this.record("completeTask", href, completed);
  }
}

export class FakeCalendarBackend
  extends RecordingBackend
  implements CalendarBackend
{
  calendars: CalendarInfo[] = [];
  events: CalendarEvent[] = [];

  async connect(): Promise<void> {}

  async listCalendars(): Promise<CalendarInfo[]> {
    return this.record("listCalendars", undefined, this.calendars);
  }

  async listEvents(options?: ListEventsOptions): Promise<CalendarEvent[]> {
    return this.record("listEvents", options, this.events);
  }

  async getEvent(href: string): Promise<CalendarEvent | null> {
    const found = this.events.find((e) => e.href === href) ?? null;
    return this.record("getEvent", href, found);
  }

  async searchEvents(options: SearchEventsOptions): Promise<CalendarEvent[]> {
    return this.record("searchEvents", options, this.events);
  }
}

export class FakeContactsBackend
  extends RecordingBackend
  implements ContactsBackend
{
  addressBooks: AddressBookInfo[] = [];
  contacts: Contact[] = [];

  async connect(): Promise<void> {}

  async listAddressBooks(): Promise<AddressBookInfo[]> {
    return this.record("listAddressBooks", undefined, this.addressBooks);
  }

  async listContacts(options?: ListContactsOptions): Promise<Contact[]> {
    return this.record("listContacts", options, this.contacts);
  }

  async getContact(href: string): Promise<Contact | null> {
    const found = this.contacts.find((c) => c.href === href) ?? null;
    return this.record("getContact", href, found);
  }

  async searchContacts(options: SearchContactsOptions): Promise<Contact[]> {
    return this.record("searchContacts", options, this.contacts);
  }
}

// --- Fixture builders ---

let fixtureCounter = 0;
function nextId(prefix: string): string {
  fixtureCounter += 1;
  return `${prefix}-${fixtureCounter}`;
}

/** Reset fixture id numbering, for tests that assert on generated ids. */
export function resetFixtureIds(): void {
  fixtureCounter = 0;
}

export function makeTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
  const id = overrides.id ?? nextId("task");
  return {
    id,
    href: `/tasks/${id}.ics`,
    calendar: "Personal",
    title: "Buy milk",
    status: "NEEDS-ACTION",
    ...overrides,
  };
}

export function makeEvent(
  overrides: Partial<CalendarEvent> = {}
): CalendarEvent {
  const id = overrides.id ?? nextId("event");
  return {
    id,
    href: `/calendars/${id}.ics`,
    calendar: "Personal",
    title: "Team Standup",
    start: "2026-08-17T09:00:00Z",
    end: "2026-08-17T09:30:00Z",
    allDay: false,
    ...overrides,
  };
}

export function makeContact(overrides: Partial<Contact> = {}): Contact {
  const id = overrides.id ?? nextId("contact");
  return {
    id,
    href: `/contacts/${id}.vcf`,
    addressBook: "Personal",
    name: "Alice Example",
    ...overrides,
  };
}
