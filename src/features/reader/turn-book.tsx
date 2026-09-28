import { useReducedMotion } from "motion/react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { createTurnBook } from "svelte-turn-page/turn-engine";
import type { TurnBookApi, TurnDisplay } from "svelte-turn-page/types";

export interface Leaf {
  content: ReactNode;
  key: string;
  kind: string;
}

interface Slot {
  element: HTMLDivElement;
  key: string;
}

export const TURN_DURATION = 800;

export function useElementSize(target: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = target.current;
    if (!element) {
      return;
    }
    const measure = () =>
      setSize((current) =>
        current.width === element.clientWidth &&
        current.height === element.clientHeight
          ? current
          : { width: element.clientWidth, height: element.clientHeight }
      );
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [target]);

  return size;
}

/** Tracks a media query; used to switch the book to one page per view on phones. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function useArrowTurns(turnLeaf: (direction: 1 | -1) => void) {
  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
        return;
      }
      event.preventDefault();
      turnLeaf(event.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [turnLeaf]);
}

export function TurnBook({
  leaves,
  page,
  width,
  height,
  display = "double",
  onTurning,
  onTurned,
}: {
  leaves: Leaf[];
  page: number;
  width: number;
  height: number;
  display?: TurnDisplay;
  onTurning?: () => void;
  onTurned?: (page: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const events = useRef({ onTurning, onTurned });
  const slotsRef = useRef<Slot[]>([]);
  const initialDisplay = useRef(display);
  const [api, setApi] = useState<TurnBookApi | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const duration = useReducedMotion() ? 0 : TURN_DURATION;

  useEffect(() => {
    events.current = { onTurning, onTurned };
  });

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) {
      return;
    }
    const created: { api?: TurnBookApi } = {};
    createTurnBook(
      element,
      {
        display: initialDisplay.current,
        gradients: true,
        duration: TURN_DURATION,
      },
      {
        ready: (event) => {
          created.api = event.api;
        },
        turning: () => events.current.onTurning?.(),
        turned: (event) => events.current.onTurned?.(event.page),
      }
    ).catch(console.error);
    setApi(created.api ?? null);
    return () => {
      created.api?.destroy();
      setApi(null);
    };
  }, []);

  useEffect(() => {
    if (api && width > 0 && height > 0) {
      api.configure({ width, height, duration, display });
    }
  }, [api, width, height, duration, display]);

  useLayoutEffect(() => {
    const element = host.current;
    if (!(api && element)) {
      return;
    }
    const current = slotsRef.current;
    const kept =
      current.length <= leaves.length &&
      current.every((slot, index) => slot.key === leaves[index].key)
        ? current
        : [];
    if (kept !== current) {
      for (const slot of current) {
        slot.element.remove();
      }
    }
    const added = leaves.slice(kept.length).map((leaf) => {
      const slot = document.createElement("div");
      slot.className = `curl-page curl-page--${leaf.kind}`;
      element.append(slot);
      return { key: leaf.key, element: slot };
    });
    slotsRef.current = [...kept, ...added];
    setSlots(slotsRef.current);
  }, [api, leaves]);

  useEffect(() => {
    if (!api) {
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && api.page() !== page) {
        api.page(page);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, page]);

  const elements = new Map(slots.map((slot) => [slot.key, slot.element]));

  return (
    <>
      <div ref={host} />
      {leaves.map((leaf) => {
        const element = elements.get(leaf.key);
        return element ? createPortal(leaf.content, element, leaf.key) : null;
      })}
    </>
  );
}
