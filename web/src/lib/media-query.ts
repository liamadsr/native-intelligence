/**
 * Media queries, read safely. Every `matchMedia` in the app goes through here
 * (a test, src/lib/__tests__/media-query.test.ts, refuses a bare call
 * anywhere else).
 *
 * WHY: WebKit's `matchMedia` can return null, not a MediaQueryList (seen
 * while a view is detached or offscreen during a transition). Chromium never
 * does, so `matchMedia(q).matches` looked safe. In the desktop app (WKWebView)
 * it threw `null is not an object (evaluating 'matchMedia(...).matches')`
 * while a card's header rendered the read-aloud toggle's metal
 * (components/read-aloud/listen-metal.tsx): the dashboard's error boundary
 * remounted everything and the owner landed on Home on opening a spreadsheet
 * (Sentry JAVASCRIPT-NEXTJS-CR, 11-24).
 *
 * So: no window, no `matchMedia`, a null answer, or a throw all read as the
 * caller's fallback, and a list without `addEventListener` (Safari before 14)
 * is heard with `addListener`, or not at all.
 */

/** The MediaQueryList for `query`, or null when there is none to be had. */
export function mediaQueryList(query: string): MediaQueryList | null {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
    const list = window.matchMedia(query) as MediaQueryList | null | undefined
    return list && typeof list === 'object' ? list : null
  } catch {
    return null
  }
}

/** Whether `query` matches now; `fallback` when it can't be asked. */
export function mediaMatches(query: string, fallback = false): boolean {
  const list = mediaQueryList(query)
  if (!list || typeof list.matches !== 'boolean') return fallback
  return list.matches
}

/** Hear `query`'s changes. Returns the unsubscribe (a no-op when nothing could be heard). */
export function subscribeMedia(query: string, onChange: (event?: MediaQueryListEvent) => void): () => void {
  const list = mediaQueryList(query)
  if (!list) return () => {}
  const listener = (event: MediaQueryListEvent) => onChange(event)
  try {
    if (typeof list.addEventListener === 'function') {
      list.addEventListener('change', listener)
      return () => {
        try {
          list.removeEventListener('change', listener)
        } catch {
          /* gone with its view */
        }
      }
    }
    if (typeof list.addListener === 'function') {
      list.addListener(listener)
      return () => {
        try {
          list.removeListener(listener)
        } catch {
          /* gone with its view */
        }
      }
    }
  } catch {
    /* a list that can't be listened to says nothing more */
  }
  return () => {}
}

/**
 * For the page's first inline script (components/theme-script.tsx, and the
 * HUD pages that build their own HTML): `window.matchMedia` never answers null
 * again. Our code reads through the helpers above, but a package's does not
 * (bot-avatars, metal-fx and others read `matchMedia(q).matches`), so a null
 * becomes a list that matches nothing and hears nothing. Installed once
 * (`__niSafe`); a missing `matchMedia` is left missing.
 */
export const MATCH_MEDIA_SHIM_SCRIPT = `(function(){try{var w=window,m=w.matchMedia;if(typeof m!=='function'||m.__niSafe)return;var n=function(){};var s=function(q){var l=null;try{l=m.call(w,q)}catch(e){}if(l)return l;return{matches:false,media:String(q),onchange:null,addListener:n,removeListener:n,addEventListener:n,removeEventListener:n,dispatchEvent:function(){return false}}};s.__niSafe=true;w.matchMedia=s}catch(e){}})();`

/** `(prefers-reduced-motion: reduce)`, the query most callers ask. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** Reduced motion asked for; false when it can't be told. */
export function prefersReducedMotion(): boolean {
  return mediaMatches(REDUCED_MOTION_QUERY)
}
