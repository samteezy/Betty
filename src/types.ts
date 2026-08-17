/**
 * Shared interface that both IMAP and JMAP backends implement.
 * The MCP tool layer depends only on this interface, never on a specific backend.
 */

export interface AttachmentInfo {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
  isInline: boolean;
}

export interface AttachmentContent {
  filename: string;
  mimeType: string;
  content: string; // base64-encoded
}

export interface EmailMessage {
  id: string;
  subject: string;
  from: string;
  to: string[];
  cc?: string[];
  date: string;
  snippet: string;
  body?: string;
  isRead: boolean;
  folder: string;
  attachments?: AttachmentInfo[];
}

export interface ListMessagesOptions {
  folder?: string;
  limit?: number;
  offset?: number;
}

export interface SearchOptions {
  query: string;
  folder?: string;
  limit?: number;
}

export interface SendMessageOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  inReplyTo?: string;
}

export interface EmailBackend {
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  listFolders(): Promise<string[]>;
  listMessages(options?: ListMessagesOptions): Promise<EmailMessage[]>;
  getMessage(id: string): Promise<EmailMessage | null>;
  searchMessages(options: SearchOptions): Promise<EmailMessage[]>;
  sendMessage?(options: SendMessageOptions): Promise<{ id: string }>;
  getAttachment?(
    messageId: string,
    partId: string,
    maxSize?: number
  ): Promise<AttachmentContent>;
}

// --- Calendar types ---

export interface CalendarInfo {
  href: string;
  name: string;
  color?: string;
  description?: string;
  supportedComponents?: string[];
}

export interface CalendarEvent {
  id: string;
  href: string;
  calendar: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  organizer?: string;
  attendees?: string[];
  status?: string;
  recurrence?: string;
  allDay: boolean;
}

export interface ListEventsOptions {
  calendar?: string;
  limit?: number;
}

export interface SearchEventsOptions {
  query: string;
  calendar?: string;
  limit?: number;
}

export interface CalendarBackend {
  connect(): Promise<void>;
  listCalendars(): Promise<CalendarInfo[]>;
  listEvents(options?: ListEventsOptions): Promise<CalendarEvent[]>;
  getEvent(href: string): Promise<CalendarEvent | null>;
  searchEvents(options: SearchEventsOptions): Promise<CalendarEvent[]>;
}

// --- Task types ---

export interface TaskInfo {
  id: string;
  href: string;
  calendar: string;
  title: string;
  status?: string;
  priority?: number;
  due?: string;
  start?: string;
  completed?: string;
  percentComplete?: number;
  description?: string;
  categories?: string[];
  recurrence?: string;
}

export interface ListTasksOptions {
  calendar?: string;
  limit?: number;
  status?: string;
  includeCompleted?: boolean;
}

export interface SearchTasksOptions {
  query: string;
  calendar?: string;
  limit?: number;
}

export interface CreateTaskOptions {
  calendar?: string;
  title: string;
  description?: string;
  due?: string;
  priority?: number;
  categories?: string[];
  status?: string;
}

export interface UpdateTaskOptions {
  href: string;
  title?: string;
  description?: string;
  due?: string;
  priority?: number;
  status?: string;
  percentComplete?: number;
  categories?: string[];
}

export interface TaskBackend {
  connect(): Promise<void>;
  listCalendars(): Promise<CalendarInfo[]>;
  listTasks(options?: ListTasksOptions): Promise<TaskInfo[]>;
  getTask(href: string): Promise<TaskInfo | null>;
  searchTasks(options: SearchTasksOptions): Promise<TaskInfo[]>;
  createTask(options: CreateTaskOptions): Promise<TaskInfo>;
  updateTask(options: UpdateTaskOptions): Promise<TaskInfo>;
  completeTask(href: string): Promise<TaskInfo>;
}

// --- Contact types ---

export interface AddressBookInfo {
  href: string;
  name: string;
  description?: string;
}

export interface Contact {
  id: string;
  href: string;
  addressBook: string;
  name: string;
  emails?: string[];
  phones?: string[];
  organization?: string;
  title?: string;
  address?: string;
  notes?: string;
}

export interface ListContactsOptions {
  addressBook?: string;
  limit?: number;
}

export interface SearchContactsOptions {
  query: string;
  addressBook?: string;
  limit?: number;
}

export interface ContactsBackend {
  connect(): Promise<void>;
  listAddressBooks(): Promise<AddressBookInfo[]>;
  listContacts(options?: ListContactsOptions): Promise<Contact[]>;
  getContact(href: string): Promise<Contact | null>;
  searchContacts(options: SearchContactsOptions): Promise<Contact[]>;
}

// --- Notes types ---

/** One entry in a directory listing. Paths are relative to the notes root. */
export interface NoteEntry {
  /** POSIX-style path relative to the notes root, e.g. "memory/people/sam.md" */
  path: string;
  /** Final path segment, e.g. "sam.md" */
  name: string;
  isDirectory: boolean;
  size?: number;
  modified?: string;
  etag?: string;
}

export interface NoteRead {
  text: string;
  /**
   * Opaque version token for the content just read. Pass it back to write()
   * to make the write conditional on nothing having changed since.
   */
  etag?: string;
}

export interface NoteWriteResult {
  etag?: string;
}

/**
 * Storage for notes, memory, and skills. Deliberately thin and path-based so
 * WebDAV and the local filesystem can both satisfy it. Scope enforcement
 * (read within NOTES_ROOT, write only within MEMORY_ROOT) lives in the tool
 * layer, above this interface.
 */
export interface NotesBackend {
  connect(): Promise<void>;
  /** Single level, non-recursive. Returns [] for a directory that isn't there. */
  list(dir: string): Promise<NoteEntry[]>;
  /** Throws NoteNotFoundError when the path doesn't exist. */
  read(path: string): Promise<NoteRead>;
  /**
   * Write a file, creating parent directories as needed.
   *
   * `ifMatch` given     — conditional update; throws NoteConflictError if the
   *                       stored version no longer matches.
   * `ifMatch` omitted   — create-only; throws NoteConflictError if the file
   *                       already exists. There is no unconditional overwrite,
   *                       by design.
   */
  write(path: string, text: string, ifMatch?: string): Promise<NoteWriteResult>;
  /**
   * Move a file, creating parent directories as needed. Throws
   * NoteConflictError when anything already exists at `to`, and
   * NoteNotFoundError when `from` doesn't exist or is a directory.
   *
   * There is no `ifMatch`. The precondition on write() exists to stop Betty
   * discarding a concurrent human edit; a move discards nothing — whatever
   * bytes are at `from` travel intact. The only thing a move can destroy is
   * the destination, and refusing a non-empty destination covers that.
   */
  move(from: string, to: string): Promise<void>;
}
