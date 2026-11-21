/**
 * Inline script in <head>: a page whose scripts never ran is reloaded, so a
 * window is never left blank for good.
 *
 * WHY: a page here loads two dozen `async` script chunks, and Turbopack's
 * runtime starts the app only once every one of them has arrived. If any one
 * fails (the network drops for a moment), nothing runs and nothing retries:
 * the server's HTML stays on screen without React, which in the dashboard is
 * an empty dark window. It happens most when a load starts just as a laptop
 * wakes, the network still coming back. A new deploy made while it slept
 * reloads every open window then (lib/deploy-reload.ts, and the desktop's
 * cache-buster after it). Seen on 2026-11-20: the desktop app's main window
 * black after a sleep, its page loaded (`/account`) but never hydrated.
 *
 * An inline script runs while the HTML is parsed, chunks or not, so it is the
 * one piece that can notice. The app calls `window.__niBoot()` once React has
 * committed (BootMark, in the root layout), and so does the global error page
 * unless what it shows is itself a chunk that failed to load. Until then:
 *   - {@link BOOT_AFTER_LOAD_MS} after the page's `load` (every chunk loaded or
 *     failed by then), a page that has not started is reloaded; a load that
 *     never ends is reloaded once it is at least {@link BOOT_ABSOLUTE_MS} old
 *     AND nothing has finished downloading for {@link BOOT_STALL_MS} (a slow
 *     link still bringing chunks in is left to finish);
 *   - only while it is visible and online: otherwise it waits for the window
 *     to come back into view or the network to return;
 *   - at most {@link BOOT_MAX_RELOADS} times in {@link BOOT_RELOAD_WINDOW_MS}
 *     per tab (sessionStorage; a page that starts clears the count), so a
 *     genuinely broken build cannot loop. Past that, or where sessionStorage
 *     cannot be written, it shows "This page didn't finish loading" with a
 *     Reload button instead of a blank window.
 *
 * EVERY RELOAD FETCHES THE PAGE'S OWN SCRIPTS FIRST. Next preloads the runtime
 * chunk (`<link rel="preload" as="script">`), and WebKit keeps a failed
 * preload in its memory cache: `location.reload()` then reuses the failure
 * without asking the network, every time, until the process ends (seen live on
 * 2026-11-21 behind a proxy that failed that chunk once: three reloads, three
 * blank pages, one request). A `fetch()` of the same URL replaces that entry,
 * so the scripts are fetched (the HTTP cache answers for the ones that loaded),
 * then the page reloads, after all of them or {@link BOOT_REFETCH_MS}.
 *
 * Top-level windows only: a frame (the landing page's live demos) shares its
 * tab's sessionStorage with every other frame, and its page shows a poster
 * until it draws anyway.
 *
 * Production only: in `next dev` a slow first compile would read as a failure.
 */
export const BOOT_RELOADS_KEY = 'ni:boot-reloads'
export const BOOT_MAX_RELOADS = 3
export const BOOT_RELOAD_WINDOW_MS = 10 * 60_000
export const BOOT_AFTER_LOAD_MS = 10_000
export const BOOT_ABSOLUTE_MS = 60_000
export const BOOT_STALL_MS = 30_000
/** How often a load that has not ended is looked at. */
export const BOOT_LOAD_POLL_MS = 5_000
/** A reload that never left the page (the server unreachable) is tried again after this. */
export const BOOT_RELOAD_STUCK_MS = 30_000
/** The longest a reload waits for the page's scripts to be fetched again. */
export const BOOT_REFETCH_MS = 8_000
export const BOOT_FALLBACK_ID = 'ni-boot-fallback'

export const BOOT_WATCHDOG_SCRIPT = `
(function () {
  var w = window, d = document;
  if (w.__niBootWatch || w.self !== w.top) return;
  w.__niBootWatch = true;
  var KEY = '${BOOT_RELOADS_KEY}', MAX = ${BOOT_MAX_RELOADS}, SPAN = ${BOOT_RELOAD_WINDOW_MS};
  var ID = '${BOOT_FALLBACK_ID}';
  var acted = false, waiting = false;

  function booted() { return w.__niBooted === true; }

  // This tab's recent boot reloads; null when sessionStorage can't be read. A garbled count is none.
  function recent() {
    var raw, list, kept = [], now = Date.now();
    try { raw = sessionStorage.getItem(KEY); } catch (_) { return null; }
    try { list = JSON.parse(raw || '[]'); } catch (_) { list = []; }
    if (Object.prototype.toString.call(list) !== '[object Array]') list = [];
    for (var i = 0; i < list.length; i++) {
      if (typeof list[i] === 'number' && now - list[i] < SPAN) kept.push(list[i]);
    }
    return kept;
  }

  // Fetch the page's own scripts, then reload: a fetch replaces what WebKit remembers of a failed
  // preload, which a plain reload would reuse. \`always\`: the person asked (the Reload button).
  // \`reloaded\` runs right after the reload is asked for.
  function reloadFresh(always, reloaded) {
    var urls = [], seenUrl = {}, left, done = false, els, i, u;
    function go() {
      if (done) return;
      done = true;
      if (always || !booted()) {
        location.reload();
        if (reloaded) reloaded();
      }
    }
    function settle() { if (--left <= 0) go(); }
    try {
      if (typeof fetch !== 'function') { go(); return; }
      els = d.querySelectorAll('script[src],link[rel="preload"][as="script"],link[rel="modulepreload"]');
      for (i = 0; i < els.length; i++) {
        u = els[i].src || els[i].href;
        if (u && u.indexOf(location.origin + '/') === 0 && !seenUrl[u]) { seenUrl[u] = true; urls.push(u); }
      }
    } catch (_) { go(); return; }
    left = urls.length;
    if (!left) { go(); return; }
    setTimeout(go, ${BOOT_REFETCH_MS});
    for (i = 0; i < urls.length; i++) {
      try { fetch(urls[i]).then(settle, settle); } catch (_) { settle(); }
    }
  }

  function fallback() {
    if (d.getElementById(ID)) return;
    var box = d.createElement('div');
    box.id = ID;
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:12px;background:Canvas;color:CanvasText;' +
      'font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
    var text = d.createElement('p');
    text.style.margin = '0';
    text.textContent = "This page didn't finish loading.";
    var button = d.createElement('button');
    button.type = 'button';
    button.textContent = 'Reload';
    button.style.cssText = 'font:inherit;color:inherit;background:transparent;border:1px solid currentColor;' +
      'border-radius:6px;padding:4px 14px;cursor:pointer';
    button.onclick = function () { reloadFresh(true); };
    box.appendChild(text);
    box.appendChild(button);
    (d.body || d.documentElement).appendChild(box);
  }

  function check() {
    if (acted || booted()) return;
    if (d.visibilityState === 'hidden' || navigator.onLine === false) { waiting = true; return; }
    waiting = false;
    acted = true;
    var list = recent();
    if (list && list.length < MAX) {
      list.push(Date.now());
      var noted = JSON.stringify(list);
      try {
        sessionStorage.setItem(KEY, noted);
        if (sessionStorage.getItem(KEY) === noted) {
          reloadFresh(false, function () {
            // Still here a while after the reload: it never left (the server unreachable). Try again, on the budget.
            setTimeout(function () { acted = false; check(); }, ${BOOT_RELOAD_STUCK_MS});
          });
          return;
        }
      } catch (_) {}
    }
    // Out of tries, or no way to count them (so it could loop): say so instead of a blank window.
    fallback();
  }

  function retry() { if (waiting) check(); }
  d.addEventListener('visibilitychange', retry);
  w.addEventListener('online', retry);
  function afterLoad() { setTimeout(check, ${BOOT_AFTER_LOAD_MS}); }
  if (d.readyState === 'complete') afterLoad(); else w.addEventListener('load', afterLoad);

  // A load that never ends: reloaded once old enough AND stalled (no download finished for a while).
  var started = Date.now(), seen = -1, movedAt = started;
  function finished() {
    try { return performance.getEntriesByType('resource').length; } catch (_) { return -1; }
  }
  function watchLoad() {
    if (acted || booted() || d.readyState === 'complete') return; // the load path takes it from here
    var n = finished(), now = Date.now();
    if (n !== seen) { seen = n; movedAt = now; }
    if (now - started >= ${BOOT_ABSOLUTE_MS} && (n < 0 || now - movedAt >= ${BOOT_STALL_MS})) check();
    else setTimeout(watchLoad, ${BOOT_LOAD_POLL_MS});
  }
  setTimeout(watchLoad, ${BOOT_LOAD_POLL_MS});

  // BootMark calls this once React has committed.
  w.__niBoot = function () {
    w.__niBooted = true;
    try { sessionStorage.removeItem(KEY); } catch (_) {}
    var shown = d.getElementById(ID);
    if (shown && shown.parentNode) shown.parentNode.removeChild(shown);
  };
})();
`

export function BootWatchdogScript() {
  if (process.env.NODE_ENV !== 'production') return null
  return <script dangerouslySetInnerHTML={{ __html: BOOT_WATCHDOG_SCRIPT }} />
}
