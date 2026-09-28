/** Offsets count UTF-16 code units in the chapter's stable source text. */
export interface ContentLocator {
  chapterId: string;
  end: number;
  quote: string;
  start: number;
}

/** Who wrote a note; `id` is the per-browser reader id, never a device secret. */
export interface AnnotationAuthor {
  color: string;
  id: string;
  name: string;
}

export interface Annotation {
  author?: AnnotationAuthor;
  createdAt: number;
  id: string;
  kind: "comment" | "highlight" | "bookmark";
  locator: ContentLocator;
  text: string;
}
