/** Typed failure for every sync and pairing path; `code` is stable for the UI. */
export class SyncError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SyncError";
    this.code = code;
  }
}

export function syncErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Something went wrong.";
}
