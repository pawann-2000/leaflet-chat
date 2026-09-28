import {
  BookOpen,
  FolderOpen,
  MonitorSmartphone,
  Search,
  ShieldCheck,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  AnimatedSidebar,
  AnimatedSidebarContent,
  AnimatedSidebarFooter,
  AnimatedSidebarGroup,
  AnimatedSidebarGroupContent,
  AnimatedSidebarGroupLabel,
  AnimatedSidebarHeader,
  AnimatedSidebarMenu,
  AnimatedSidebarMenuButton,
  AnimatedSidebarMenuItem,
  AnimatedSidebarRail,
  useAnimatedSidebar,
} from "@/components/motion/animated-sidebar";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { Assistant } from "@/features/assistant/assistant";
import { LibraryShelf } from "@/features/library/library-shelf";
import type { Chapter, LibraryBook, OpenedBook, TocEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

export type SidebarTab = "contents" | "notes" | "ask" | "library";

function OpenBookCard({ book }: { book: OpenedBook }) {
  return (
    <div className="paper flex items-center gap-3 rounded-2xl p-3">
      {book.summary.coverDataUrl ? (
        <img
          alt=""
          className="h-14 w-10 rounded-md object-cover shadow-sm"
          height={56}
          src={book.summary.coverDataUrl}
          width={40}
        />
      ) : (
        <span className="grid h-14 w-10 shrink-0 place-items-center rounded-md bg-primary font-serif text-lg text-primary-foreground">
          {book.summary.title.slice(0, 1).toLocaleUpperCase() || "L"}
        </span>
      )}
      <div className="min-w-0">
        <p className="truncate font-medium font-serif text-sm">
          {book.summary.title}
        </p>
        <p className="truncate text-muted-foreground text-xs">
          {book.summary.authors.join(", ") || "Unknown author"}
        </p>
      </div>
    </div>
  );
}

function Contents({
  book,
  currentIndex,
  onSelect,
  onNavigate,
}: {
  book: OpenedBook;
  currentIndex: number;
  onSelect: (index: number) => void;
  onNavigate: (entry: TocEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const chapters = book.chapters.filter((item) =>
    item.title.toLocaleLowerCase().includes(needle)
  );
  const navigation = book.navigation.filter((item) =>
    item.title.toLocaleLowerCase().includes(needle)
  );
  const read = Math.round(((currentIndex + 1) / book.chapters.length) * 100);

  return (
    <>
      <Input
        aria-label="Search chapters"
        leftIcon={<Search className="size-4" />}
        onChange={setQuery}
        placeholder="Find a chapter"
        type="search"
        value={query}
      />
      {navigation.length > 0 && (
        <AnimatedSidebarGroup>
          <AnimatedSidebarGroupLabel>
            Publisher's contents
          </AnimatedSidebarGroupLabel>
          <AnimatedSidebarGroupContent>
            <AnimatedSidebarMenu>
              {navigation.map((item) => (
                <AnimatedSidebarMenuItem key={item.id}>
                  <AnimatedSidebarMenuButton
                    className="text-sm"
                    isActive={
                      item.chapterIndex === currentIndex &&
                      item.fragment === null
                    }
                    onSelect={() => onNavigate(item)}
                  >
                    <span
                      style={{
                        paddingInlineStart: `${Math.min(item.depth, 8) * 0.75}rem`,
                      }}
                    >
                      {item.title}
                    </span>
                  </AnimatedSidebarMenuButton>
                </AnimatedSidebarMenuItem>
              ))}
            </AnimatedSidebarMenu>
          </AnimatedSidebarGroupContent>
        </AnimatedSidebarGroup>
      )}
      <AnimatedSidebarGroup>
        <AnimatedSidebarGroupLabel>
          Reading order · {book.chapters.length}
        </AnimatedSidebarGroupLabel>
        <AnimatedSidebarGroupContent>
          <AnimatedSidebarMenu>
            {chapters.map((item) => (
              <AnimatedSidebarMenuItem key={item.id}>
                <AnimatedSidebarMenuButton
                  badge={String(item.index + 1).padStart(2, "0")}
                  isActive={item.index === currentIndex}
                  onSelect={() => onSelect(item.index)}
                >
                  {item.title}
                </AnimatedSidebarMenuButton>
              </AnimatedSidebarMenuItem>
            ))}
          </AnimatedSidebarMenu>
        </AnimatedSidebarGroupContent>
      </AnimatedSidebarGroup>
      <div className="mt-auto px-2 pt-3">
        <div aria-hidden="true" className="ribbon">
          <span className="ribbon__fill" style={{ width: `${read}%` }} />
        </div>
        <p className="mt-1.5 text-muted-foreground text-xs">
          Chapter {currentIndex + 1} of {book.summary.chapterCount} · {read}%
        </p>
      </div>
    </>
  );
}

export function LibrarySidebar({
  book,
  chapter,
  currentIndex,
  library,
  libraryBusy,
  selectedText,
  tab,
  notesPanel,
  onTabChange,
  onSelect,
  onNavigate,
  onImport,
  onOpenBook,
  onRemoveBook,
  onSync,
  onTrustedSites,
  onError,
}: {
  book: OpenedBook | null;
  chapter: Chapter | null;
  currentIndex: number;
  library: LibraryBook[];
  libraryBusy: boolean;
  selectedText: string;
  tab: SidebarTab;
  /** Rendered in the Notes tab. */
  notesPanel: ReactNode;
  onTabChange: (tab: SidebarTab) => void;
  onSelect: (index: number) => void;
  onNavigate: (entry: TocEntry) => void;
  onImport: () => void;
  onOpenBook: (id: string) => void;
  onRemoveBook: (book: LibraryBook) => void;
  onSync?: () => void;
  onTrustedSites: () => void;
  onError: (message: string) => void;
}) {
  const { open, isMobile, setOpenMobile } = useAnimatedSidebar();
  const expanded = open || isMobile;
  const closeOnMobile = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  return (
    <AnimatedSidebar ariaLabel="Library" collapsible="icon">
      <AnimatedSidebarHeader>
        <div className="flex h-10 items-center gap-2 px-2">
          <span className="grid size-7 place-items-center rounded-lg bg-coral/15 text-coral">
            <BookOpen className="size-4 shrink-0" />
          </span>
          {expanded && (
            <span className="truncate font-semibold font-serif text-base">
              Leaflet
            </span>
          )}
        </div>
        {expanded && book && <OpenBookCard book={book} />}
        {expanded && book && (
          <Tabs
            onValueChange={(value) => onTabChange(value as SidebarTab)}
            value={tab}
            variant="segment"
          >
            <TabsList className="flex w-full">
              <TabsTrigger className="flex-1" value="contents">
                Contents
              </TabsTrigger>
              <TabsTrigger className="flex-1" value="notes">
                Notes
              </TabsTrigger>
              <TabsTrigger className="flex-1" value="ask">
                Ask
              </TabsTrigger>
              <TabsTrigger className="flex-1" value="library">
                Shelf
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
      </AnimatedSidebarHeader>

      <AnimatedSidebarContent
        className={cn(
          "scrollbar-paper px-3",
          tab === "ask" && "overflow-hidden"
        )}
      >
        {expanded && !book && (
          <>
            <div className="paper flex flex-col gap-3 rounded-2xl p-4">
              <p className="font-medium font-serif text-sm">
                {library.length ? "Your shelf" : "A quiet shelf"}
              </p>
              <p className="text-muted-foreground text-xs">
                {library.length
                  ? "Pick a book up where you left off."
                  : "Add an EPUB to begin. Your books stay on this device."}
              </p>
              <Button onClick={onImport} size="sm">
                Choose an EPUB
              </Button>
            </div>
            {library.length > 0 && (
              <AnimatedSidebarGroup>
                <AnimatedSidebarGroupLabel>
                  Library · {library.length}
                </AnimatedSidebarGroupLabel>
                <AnimatedSidebarGroupContent>
                  <LibraryShelf
                    books={library}
                    busy={libraryBusy}
                    currentId={null}
                    layout="list"
                    onOpen={(id) => {
                      onOpenBook(id);
                      closeOnMobile();
                    }}
                    onRemove={onRemoveBook}
                  />
                </AnimatedSidebarGroupContent>
              </AnimatedSidebarGroup>
            )}
          </>
        )}
        {expanded && book && tab === "contents" && (
          <Contents
            book={book}
            currentIndex={currentIndex}
            onNavigate={(entry) => {
              onNavigate(entry);
              closeOnMobile();
            }}
            onSelect={(index) => {
              onSelect(index);
              closeOnMobile();
            }}
          />
        )}
        {expanded && book && tab === "notes" && notesPanel}
        {expanded && book && tab === "library" && (
          <AnimatedSidebarGroup>
            <AnimatedSidebarGroupLabel>
              Library · {library.length}
            </AnimatedSidebarGroupLabel>
            <AnimatedSidebarGroupContent>
              <LibraryShelf
                books={library}
                busy={libraryBusy}
                currentId={book.summary.id}
                layout="list"
                onOpen={(id) => {
                  onOpenBook(id);
                  closeOnMobile();
                }}
                onRemove={onRemoveBook}
              />
            </AnimatedSidebarGroupContent>
          </AnimatedSidebarGroup>
        )}
        {expanded && book && tab === "ask" && (
          <Assistant
            chapterText={chapter?.plainText ?? ""}
            chapterTitle={chapter?.title ?? ""}
            onError={onError}
            selectedText={selectedText}
          />
        )}
      </AnimatedSidebarContent>

      <AnimatedSidebarFooter>
        <AnimatedSidebarMenu>
          <AnimatedSidebarMenuItem>
            <AnimatedSidebarMenuButton
              icon={<FolderOpen className="size-4" />}
              onSelect={onImport}
            >
              Add a book
            </AnimatedSidebarMenuButton>
          </AnimatedSidebarMenuItem>
          {onSync && (
            <AnimatedSidebarMenuItem>
              <AnimatedSidebarMenuButton
                icon={<MonitorSmartphone className="size-4" />}
                onSelect={onSync}
              >
                Your devices
              </AnimatedSidebarMenuButton>
            </AnimatedSidebarMenuItem>
          )}
          <AnimatedSidebarMenuItem>
            <AnimatedSidebarMenuButton
              icon={<ShieldCheck className="size-4" />}
              onSelect={onTrustedSites}
            >
              Trusted sites
            </AnimatedSidebarMenuButton>
          </AnimatedSidebarMenuItem>
        </AnimatedSidebarMenu>
      </AnimatedSidebarFooter>
      <AnimatedSidebarRail />
    </AnimatedSidebar>
  );
}
