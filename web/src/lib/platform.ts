/**
 * Platform detection utilities for Native Intelligence.
 * Detects whether the app is running inside a Tauri desktop shell.
 */

declare global {
  interface Window {
    __TAURI__?: Record<string, unknown>;
    __TAURI_INTERNALS__?: Record<string, unknown>;
  }
}

/** Returns true when running inside the Tauri desktop app. */
export function isDesktopApp(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.__TAURI__ !== undefined ||
      window.__TAURI_INTERNALS__ !== undefined)
  );
}

/** The desktop app's operating system. */
export type DesktopOS = "macos" | "windows";

/**
 * Which desktop app this is, from the web view's user agent (WebView2 on
 * Windows says "Windows NT"; WKWebView on macOS says "Macintosh"). Null
 * outside the desktop app.
 */
export function desktopOS(): DesktopOS | null {
  if (!isDesktopApp() || typeof navigator === "undefined") return null;
  return /Windows/i.test(navigator.userAgent) ? "windows" : "macos";
}

/**
 * True in the macOS desktop app, whose window buttons (the traffic lights)
 * overlay the page's top-left corner, so the header leaves room for them. The
 * Windows app has a native title bar above the page: nothing overlays it.
 */
export function hasTrafficLights(): boolean {
  return desktopOS() === "macos";
}

/**
 * True when `target` (an Element or Text node; anything else → false) sits
 * inside the agent browser's DOM: the live view (components/cloud-browser/
 * live-view.tsx, its blocked sites included) and the side panel's computer
 * card carry `data-ni-browser`. That DOM shows the person's browsing (the
 * screen, page previews, the sites they blocked or visited today), so Sentry
 * drops click/input breadcrumbs from it (shouldDropSentryBreadcrumb); PostHog
 * skips it through its `ph-no-capture` class.
 */
export function isInBrowserSurface(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const node = target as { nodeType?: unknown; parentElement?: unknown; closest?: unknown };
  // A Text node (an input event on a contenteditable, a click on bare text)
  // has no `closest`: start from its element.
  const el = (node.nodeType === 3 ? node.parentElement : node) as
    | { closest?: (selector: string) => unknown }
    | null
    | undefined;
  if (!el || typeof el.closest !== "function") return false;
  try {
    return el.closest("[data-ni-browser]") != null;
  } catch {
    return false;
  }
}

/**
 * Horizontal space (px) the web header reserves for the macOS traffic lights.
 * The native cluster itself spans ~65pt (leftInset 13 + 3 lights sized by
 * TRAFFIC_LIGHT_DIAMETER in desktop/src-tauri/src/lib.rs) — keep this
 * in sync with those Rust constants if either side changes.
 */
export const MACOS_TRAFFIC_LIGHT_WIDTH = 78;

