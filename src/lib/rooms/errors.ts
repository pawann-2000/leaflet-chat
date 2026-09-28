/** Typed failure for every room path; `code` is stable for the UI. */
export type RoomErrorCode =
  | "bad_code"
  | "bad_relay_url"
  | "closed"
  | "crypto"
  | "empty"
  | "exists"
  | "forbidden"
  | "kicked"
  | "locked"
  | "network"
  | "not_found"
  | "rate_limited"
  | "room_full"
  | "timeout"
  | "too_large"
  | "unsupported";

export class RoomError extends Error {
  readonly code: RoomErrorCode;

  constructor(code: RoomErrorCode, message: string) {
    super(message);
    this.name = "RoomError";
    this.code = code;
  }
}

export function roomErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Something went wrong.";
}
