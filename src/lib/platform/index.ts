import type { Platform } from "@/lib/platform/types";

export type { Platform, PlatformCapabilities } from "@/lib/platform/types";

let current: Platform | null = null;
let pending: Promise<Platform> | null = null;

export const isDesktopHost =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Pick and initialise the host implementation once, before the UI mounts.
 * The two implementations are loaded lazily so the browser bundle never
 * evaluates Tauri IPC code and the desktop bundle never registers a service
 * worker.
 */
export function initPlatform(): Promise<Platform> {
  if (current) {
    return Promise.resolve(current);
  }
  pending ??= (async () => {
    const platform = isDesktopHost
      ? (await import("@/lib/platform/tauri")).createTauriPlatform()
      : await (await import("@/lib/platform/web")).createWebPlatform();
    current = platform;
    return platform;
  })();
  return pending;
}

/** The initialised host. Only valid after `initPlatform()` resolved. */
export function platform(): Platform {
  if (!current) {
    throw new Error("The platform has not been initialised yet.");
  }
  return current;
}
