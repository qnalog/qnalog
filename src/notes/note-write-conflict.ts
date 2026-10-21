/** The note changed after a rewrite captured its compare-and-swap baseline. */
export class NoteMarkdownConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteMarkdownConflictError";
  }
}
