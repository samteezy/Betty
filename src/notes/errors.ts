/** A write lost a race with another writer, or the target already existed. */
export class NoteConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteConflictError";
  }
}

export class NoteNotFoundError extends Error {
  constructor(path: string) {
    super(`Note not found: ${path}`);
    this.name = "NoteNotFoundError";
  }
}

/** Wording shared by both backends so the model sees one consistent story. */
export function conflictMessage(path: string): string {
  return (
    `Conflict writing "${path}": it changed since Betty last read it. ` +
    `Re-read the note with get_note and reapply the change — writing now would ` +
    `discard someone else's edit.`
  );
}

/**
 * Deliberately names no write tool. This message is shared by the memory and
 * skill paths, which have different ones — naming either would send the model
 * to a tool that isn't registered for what it is doing.
 */
export function existsMessage(path: string): string {
  return (
    `Conflict creating "${path}": a file already exists there. ` +
    `Read it with get_note first, then append to it or replace one of its ` +
    `sections instead of recreating it.`
  );
}
