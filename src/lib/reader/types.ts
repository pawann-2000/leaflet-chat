export interface ChapterPage {
  anchors: string[];
  content: HTMLElement;
  endOffset: number;
  startOffset: number;
}

export type ReaderPage =
  | { kind: "blank" }
  | { kind: "text"; chapterIndex: number; page: ChapterPage; number: number }
  | { kind: "end"; chapterIndex: number };
