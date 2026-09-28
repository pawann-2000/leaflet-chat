import {
  ChevronLeft,
  ChevronRight,
  Command,
  Library,
  ListTree,
  Moon,
  NotebookPen,
  PanelLeft,
  Sparkles,
  Type,
  Users,
  Zap,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import {
  AnimatedSidebarTrigger,
  useAnimatedSidebar,
} from "@/components/motion/animated-sidebar";
import { Button } from "@/components/motion/button";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import { RangeSlider } from "@/components/motion/range-slider";
import { Switch } from "@/components/motion/switch";
import { Tooltip } from "@/components/motion/tooltip";
import { FONT_SCALE, type useReadingPrefs } from "@/lib/prefs";
import { cn } from "@/lib/utils";

type Prefs = ReturnType<typeof useReadingPrefs>;

export function AppearancePopover({
  prefs,
  trigger,
}: {
  prefs: Prefs;
  trigger?: ReactElement;
}) {
  return (
    <MorphPopover>
      <MorphPopoverTrigger>
        {trigger ?? (
          <Button aria-label="Reading appearance" size="sm" variant="ghost">
            <Type className="size-4" />
            Aa
          </Button>
        )}
      </MorphPopoverTrigger>
      <MorphPopoverContent className="paper flex w-72 flex-col gap-4 rounded-2xl p-4">
        <div className="flex flex-col gap-2">
          <p className="eyebrow">
            Text size · {Math.round(prefs.fontScale * 100)}%
          </p>
          <RangeSlider
            aria-label="Text size"
            formatValueText={(value) => `${Math.round(value * 100)}%`}
            max={FONT_SCALE.max}
            min={FONT_SCALE.min}
            onValueChange={prefs.setFontScale}
            step={FONT_SCALE.step}
            value={prefs.fontScale}
          />
        </div>
        <Switch
          checked={prefs.colorMode === "night"}
          label="Night mode · dark paper"
          onCheckedChange={prefs.setNight}
        />
      </MorphPopoverContent>
    </MorphPopover>
  );
}

export interface ReaderHeaderProps {
  eyebrow: string;
  onCommands: () => void;
  onLibrary: () => void;
  onNotes: () => void;
  onSpeedRead: () => void;
  onTogether: () => void;
  prefs: Prefs;
  reading: boolean;
  roomCount: number;
  /** The reading-timer chip, when a book is open. */
  timer?: ReactNode;
  title: string;
}

export function ReaderHeader({
  eyebrow,
  title,
  timer,
  prefs,
  reading,
  roomCount,
  onLibrary,
  onSpeedRead,
  onNotes,
  onTogether,
  onCommands,
}: ReaderHeaderProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-1.5 border-border border-b bg-background/85 px-3 backdrop-blur-sm">
      <Tooltip content="Sidebar · ⌘B">
        <AnimatedSidebarTrigger className="hover:bg-muted">
          <PanelLeft className="size-4" />
        </AnimatedSidebarTrigger>
      </Tooltip>
      {reading && (
        <Tooltip content="Back to the library">
          <Button
            aria-label="Back to the library"
            onClick={onLibrary}
            size="icon"
            variant="ghost"
          >
            <Library className="size-4" />
          </Button>
        </Tooltip>
      )}
      <div className="min-w-0 flex-1 px-1">
        <p className="eyebrow">{eyebrow}</p>
        <p className="truncate font-medium font-serif text-sm">{title}</p>
      </div>
      {timer}
      {reading && (
        <>
          <div className="hidden items-center gap-1 md:flex">
            <Tooltip content="Speed read · S">
              <Button
                aria-label="Speed read"
                onClick={onSpeedRead}
                size="icon"
                variant="ghost"
              >
                <Zap className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip content="Notes and highlights · N">
              <Button
                aria-label="Notes and highlights"
                onClick={onNotes}
                size="icon"
                variant="ghost"
              >
                <NotebookPen className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip content="Read together">
              <Button
                aria-label="Read together"
                className={cn("relative", roomCount > 0 && "text-coral")}
                onClick={onTogether}
                size="icon"
                variant="ghost"
              >
                <Users className="size-4" />
                {roomCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-coral font-semibold text-[9px] text-coral-foreground">
                    {roomCount}
                  </span>
                )}
              </Button>
            </Tooltip>
          </div>
          <AppearancePopover prefs={prefs} />
        </>
      )}
      <Tooltip content="Commands · ⌘K">
        <Button
          aria-label="Open commands"
          onClick={onCommands}
          size="icon"
          variant="ghost"
        >
          <Command className="size-4" />
        </Button>
      </Tooltip>
    </header>
  );
}

export interface ReaderFooterProps {
  chapterCount: number;
  chapterIndex: number;
  onAsk: () => void;
  onBackToBook: () => void;
  onContents: () => void;
  onNextChapter: () => void;
  onNotes: () => void;
  onPreviousChapter: () => void;
  onSpeedRead: () => void;
  prefs: Prefs;
  supplementaryTitle: string | null;
}

/**
 * Below the book. Desktop: chapter stepper. Phones: a thumb-friendly action
 * bar (the sidebar is a sheet there, so its tabs need a way in).
 */
export function ReaderFooter({
  chapterIndex,
  chapterCount,
  supplementaryTitle,
  onPreviousChapter,
  onNextChapter,
  onBackToBook,
  onContents,
  onNotes,
  onAsk,
  onSpeedRead,
  prefs,
}: ReaderFooterProps) {
  const { isMobile } = useAnimatedSidebar();

  if (supplementaryTitle !== null) {
    return (
      <footer className="flex h-11 shrink-0 items-center justify-between border-border border-t px-3 text-xs">
        <span className="truncate text-muted-foreground">
          Outside the reading order · {supplementaryTitle}
        </span>
        <Button onClick={onBackToBook} size="sm" variant="ghost">
          Back to the book
        </Button>
      </footer>
    );
  }

  if (isMobile) {
    return (
      <footer className="mobile-bar shrink-0 border-border border-t bg-background/90 backdrop-blur-sm">
        <MobileAction icon={ListTree} label="Contents" onClick={onContents} />
        <MobileAction icon={NotebookPen} label="Notes" onClick={onNotes} />
        <MobileAction icon={Sparkles} label="Ask" onClick={onAsk} />
        <MobileAction icon={Zap} label="Speed" onClick={onSpeedRead} />
        <AppearancePopover
          prefs={prefs}
          trigger={
            <button className="mobile-bar__action" type="button">
              {prefs.colorMode === "night" ? (
                <Moon className="size-5" />
              ) : (
                <Type className="size-5" />
              )}
              <span>Aa</span>
            </button>
          }
        />
      </footer>
    );
  }

  return (
    <footer className="flex h-11 shrink-0 items-center justify-between border-border border-t px-3 text-muted-foreground text-xs">
      <Button
        disabled={chapterIndex === 0}
        onClick={onPreviousChapter}
        size="sm"
        variant="ghost"
      >
        <ChevronLeft className="size-4" />
        Previous chapter
      </Button>
      <span className="font-serif">
        Chapter {chapterIndex + 1} of {chapterCount}
      </span>
      <Button
        disabled={chapterIndex >= chapterCount - 1}
        onClick={onNextChapter}
        size="sm"
        variant="ghost"
      >
        Next chapter
        <ChevronRight className="size-4" />
      </Button>
    </footer>
  );
}

function MobileAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof ListTree;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className="mobile-bar__action" onClick={onClick} type="button">
      <Icon className="size-5" />
      <span>{label}</span>
    </button>
  );
}
