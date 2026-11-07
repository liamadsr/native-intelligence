/**
 * Inline script that runs before React hydration in the Tauri desktop app.
 *
 * WKWebView aggressively caches JS chunks. When the Next.js app is redeployed,
 * stale chunks can persist across app restarts. This script detects a deployment
 * change by comparing the server's build ID with a locally stored one, and forces
 * a one-time hard reload to pick up fresh assets.
 *
 * Only runs inside the Tauri desktop webview (detected via __TAURI_INTERNALS__).
 */
export function CacheBusterScript() {
  const script = `
    try {
      if (window.__TAURI_INTERNALS__) {
        var KEY = 'dial8_build_id';
        var stored = localStorage.getItem(KEY);
        var reloading = sessionStorage.getItem('dial8_cache_bust');
        if (reloading) {
          // We just reloaded — clean up the flag and strip ?_cb param if present
          sessionStorage.removeItem('dial8_cache_bust');
          if (location.search.indexOf('_cb=') !== -1) {
            var clean = new URL(location.href);
            clean.searchParams.delete('_cb');
            history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
          }
        } else {
          fetch('/api/version', { cache: 'no-store' })
            .then(function(r) { return r.json(); })
            .then(function(d) {
              if (!d.buildId) return;
              var needsReload = !stored || d.buildId !== stored;
              localStorage.setItem(KEY, d.buildId);
              if (needsReload) {
                sessionStorage.setItem('dial8_cache_bust', '1');
                var url = new URL(location.href);
                url.searchParams.set('_cb', Date.now());
                location.replace(url.toString());
              }
            })
            .catch(function() {});
        }
      }
    } catch (_) {}
  `

  return <script dangerouslySetInnerHTML={{ __html: script }} />
}
