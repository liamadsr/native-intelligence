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
 * committed (BootMark, in the root layout). Until then:
 *   - {@link BOOT_AFTER_LOAD_MS} after the page's `load` (every chunk loaded or
 *     failed by then), or {@link BOOT_ABSOLUTE_MS} after the HTML started (a
 *     load that never ends), a page that has not started is reloaded;
 *   - only while it is visible and online: otherwise it waits for the window
 *     to come back into view or the network to return;
 *   - at most {@link BOOT_MAX_RELOADS} times in {@link BOOT_RELOAD_WINDOW_MS}
 *     per tab (sessionStorage; a page that starts clears the count), so a
 *     genuinely broken build cannot loop. Past that, or where sessionStorage
 *     cannot be written, it shows "This page didn't finish loading" with a
 *     Reload button instead of a blank window.
 *
 * Production only: in `next dev` a slow first compile would read as a failure.
 */
export const BOOT_RELOADS_KEY = 'ni:boot-reloads'
export const BOOT_MAX_RELOADS = 3
export const BOOT_RELOAD_WINDOW_MS = 10 * 60_000
export const BOOT_AFTER_LOAD_MS = 10_000
export const BOOT_ABSOLUTE_MS = 60_000
/** A reload that never left the page (the server unreachable) is tried again after this. */
export const BOOT_RELOAD_STUCK_MS = 30_000
export const BOOT_FALLBACK_ID = 'ni-boot-fallback'

export const BOOT_WATCHDOG_SCRIPT = `
(function () {
  var w = window, d = document;
  if (w.__niBootWatch) return;
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
    button.onclick = function () { location.reload(); };
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
          location.reload();
          // Still here later: the reload never left (the server unreachable). Try again, on the budget.
          setTimeout(function () { acted = false; check(); }, ${BOOT_RELOAD_STUCK_MS});
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
  setTimeout(check, ${BOOT_ABSOLUTE_MS});

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
