/**
 * Registers the Leaflet service worker (book resource protocol + app shell)
 * and waits until it controls the page, so the first `/book/...` request
 * after a fresh load is already answered from IndexedDB. Never reloads the
 * page: when a newer worker takes over, `onServiceWorkerUpdate` listeners
 * fire and the UI decides how to tell the user.
 */

export type BookProtocolRegistration =
  | {
      ok: true;
      /** A previously controlling worker was replaced while registering. */
      updated: boolean;
    }
  | { ok: false; reason: string; updated?: false };

const CONTROL_TIMEOUT_MS = 4000;
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const SCOPE = "/";

const updateListeners = new Set<() => void>();
let watching = false;
let lastUpdateCheck = 0;

function workerUrl(): { url: string; options: RegistrationOptions } {
  if (import.meta.env.DEV) {
    return {
      url: "/src/sw/book-sw.ts",
      options: { type: "module", scope: SCOPE },
    };
  }
  return { url: "/book-sw.js", options: { scope: SCOPE } };
}

/**
 * Fires once each time a new worker version takes control of an already
 * controlled page (a deploy reached this tab). Returns an unsubscribe.
 */
export function onServiceWorkerUpdate(listener: () => void): () => void {
  updateListeners.add(listener);
  return () => {
    updateListeners.delete(listener);
  };
}

function watchController(container: ServiceWorkerContainer): void {
  if (watching) {
    return;
  }
  watching = true;
  let previous = container.controller;
  container.addEventListener("controllerchange", () => {
    const replaced = previous !== null;
    previous = container.controller;
    if (replaced) {
      for (const listener of updateListeners) {
        listener();
      }
    }
  });
}

/** Ask the browser to look for a newer worker when a long-lived tab returns. */
function scheduleUpdateChecks(registration: ServiceWorkerRegistration): void {
  if (typeof document === "undefined") {
    return;
  }
  lastUpdateCheck = Date.now();
  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" &&
      Date.now() - lastUpdateCheck > UPDATE_CHECK_INTERVAL_MS
    ) {
      lastUpdateCheck = Date.now();
      registration.update().catch(() => undefined);
    }
  });
}

function waitForController(
  container: ServiceWorkerContainer
): Promise<boolean> {
  if (container.controller) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      container.removeEventListener("controllerchange", onChange);
      resolve(Boolean(container.controller));
    }, CONTROL_TIMEOUT_MS);
    const onChange = () => {
      clearTimeout(timer);
      container.removeEventListener("controllerchange", onChange);
      resolve(true);
    };
    container.addEventListener("controllerchange", onChange);
  });
}

export async function registerBookProtocol(): Promise<BookProtocolRegistration> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return {
      ok: false,
      reason: "Service workers are not available in this browser.",
    };
  }
  const container = navigator.serviceWorker;
  const before = container.controller;
  watchController(container);
  const { url, options } = workerUrl();
  let registration: ServiceWorkerRegistration;
  try {
    registration = await container.register(url, options);
    await container.ready;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `The book resource worker could not start: ${detail}`,
    };
  }
  if (!(await waitForController(container))) {
    return {
      ok: false,
      reason: "The book resource worker did not take control of this page.",
    };
  }
  scheduleUpdateChecks(registration);
  return {
    ok: true,
    updated: before !== null && container.controller !== before,
  };
}

export async function unregisterBookProtocol(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    registrations
      .filter((registration) => registration.scope.endsWith(SCOPE))
      .map((registration) => registration.unregister())
  );
}
