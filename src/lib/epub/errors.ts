/** Error codes mirror `reader_epub::EpubReaderError` and `reader_security::SecurityError`. */
export type EpubErrorCode =
  | "invalid_extension"
  | "input_too_large"
  | "too_many_entries"
  | "archive_too_large"
  | "entry_too_large"
  | "unsafe_archive_path"
  | "suspicious_compression"
  | "parse"
  | "no_readable_content"
  | "chapter_not_found"
  | "invalid_link"
  | "unsupported_link"
  | "link_not_found";

const MESSAGES: Record<EpubErrorCode, string> = {
  invalid_extension: "only EPUB files can be opened",
  input_too_large: "the EPUB exceeds the 512 MiB input limit",
  too_many_entries: "the EPUB archive has too many entries",
  archive_too_large: "the EPUB expands beyond the 512 MiB safety limit",
  entry_too_large: "the EPUB contains an oversized resource",
  unsafe_archive_path: "the EPUB contains an unsafe archive path",
  suspicious_compression: "the EPUB has a suspicious compression ratio",
  parse: "could not parse the EPUB",
  no_readable_content: "the EPUB does not contain readable chapters",
  chapter_not_found: "the requested chapter does not exist",
  invalid_link: "the publication link is invalid",
  unsupported_link: "the publication link type is not supported",
  link_not_found: "the publication link does not point to a readable chapter",
};

export class EpubError extends Error {
  readonly code: EpubErrorCode;

  constructor(code: EpubErrorCode, detail?: string) {
    super(detail ? `${MESSAGES[code]}: ${detail}` : MESSAGES[code]);
    this.name = "EpubError";
    this.code = code;
  }
}
