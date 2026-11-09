//! Top-level navigation allowlist for every Native Intelligence webview.
//!
//! WHY THIS EXISTS: a Native Intelligence window is the dial8.ai web app running with the
//! Tauri IPC bridge injected into it. tauri injects `window.__TAURI_INTERNALS__`
//! (carrying the invoke key) into the main frame of EVERY webview, and — as of
//! the `AppManifest` added in build.rs — the app's native commands are granted
//! only to the origins in `capabilities/default.json`'s `remote` allowlist. That
//! ACL is the authoritative gate. This guard is the layer in front of it: it
//! stops a Native Intelligence window from ever *reaching* an origin that isn't Native Intelligence's in the first
//! place, so a stray same-tab link in an AI reply, an email body, or a billing
//! redirect can't repaint the window onto a third-party site (where the bridge
//! would be injected and every native command would be refused by the ACL, but
//! the user would still be looking at an attacker's page inside the app frame).
//!
//! Registered as a plugin `on_navigation` hook, which tauri calls for the
//! initial load and every subsequent navigation of every webview
//! (`tauri` 2.10.3 `src/manager/webview.rs` ~566: the navigation handler ends in
//! `plugins.on_navigation(&webview, url)`). Returning `false` cancels the
//! navigation. This covers the config-created `main` window AND every window
//! created in code (workspace popouts, HUDs) from one place — no
//! per-window wiring, and no way to forget a new window.
//!
//! An http(s) destination that is NOT a Native Intelligence origin is handed to the system
//! browser via the opener plugin and then cancelled, so external links still
//! open — just not inside the app. Non-http(s) schemes the shell itself needs
//! (`tauri:`, `ipc:`, `about:`, `blob:`, `data:`) are allowed through; any other
//! scheme (a custom-scheme launcher, `file:`, etc.) is cancelled silently.

use tauri::plugin::TauriPlugin;
use tauri::{Manager, Runtime, Url, Webview};
use tauri_plugin_opener::OpenerExt;

/// The Tauri plugin that installs [`on_navigation`] as an app-wide navigation
/// veto. Register it in the `Builder` chain AFTER the opener plugin (this calls
/// into it). Generic over the runtime so the compiler infers `R` at the call
/// site; the plugin has no config (`C = ()`).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("dial8-nav-guard")
        .on_navigation(on_navigation)
        .build()
}

/// Hosts the Native Intelligence web app is served from. The main window loads
/// `https://dial8.ai` in release and `http://localhost:3000` in a debug build
/// (see `tray::api_base_url`), and workspace/HUD windows load subpaths of the
/// same. Kept in sync with `capabilities/default.json`'s `remote.urls` — that
/// file is what actually grants native-command access; this list only decides
/// what may render in-app.
pub(crate) fn is_dial8_host(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let scheme = url.scheme();
    match host {
        // Production, https only. Exactly these hosts, never any subdomain
        // (security review 2026-10-31, P0-3): a dangling or third-party
        // subdomain must not render in a window whose origin the capability
        // trusts. www.dial8.ai redirects to dial8.ai, so it may load to follow
        // the redirect; the capability grants native access to dial8.ai alone.
        "dial8.ai" | "www.dial8.ai" => scheme == "https",
        // Dev server. http only, and only in debug builds — a release build must
        // never treat localhost as trusted.
        "localhost" | "127.0.0.1" => cfg!(debug_assertions) && scheme == "http",
        _ => false,
    }
}

/// Schemes the app shell itself navigates to internally and that carry no remote
/// content. These are not http(s) so `is_dial8_host` never sees them.
///
/// `about:` covers `about:blank` (the transient URL a fresh webview holds before
/// its real load, and the target of some internal resets). `blob:`/`data:` are
/// in-page content the web app generates for itself (object URLs, inline
/// documents). `tauri:`/`ipc:` are Tauri's own protocols.
fn is_internal_scheme(url: &Url) -> bool {
    matches!(url.scheme(), "tauri" | "ipc" | "about" | "blob" | "data")
}

/// Decide whether `url` may load in a Native Intelligence webview. Pure so it can be tested
/// without a running app (see the tests below).
fn is_allowed(url: &Url) -> bool {
    is_dial8_host(url) || is_internal_scheme(url)
}

/// The `on_navigation` callback. Returns `true` to allow the navigation, `false`
/// to cancel it. A cancelled http(s) URL is opened in the system browser first.
pub fn on_navigation<R: Runtime>(webview: &Webview<R>, url: &Url) -> bool {
    if is_allowed(url) {
        return true;
    }

    // Not a Native Intelligence origin. If it's a normal web link, open it in the user's real
    // browser (same destination the opener plugin sends `target="_blank"` links
    // to) so the click still does something; then cancel the in-app navigation.
    if matches!(url.scheme(), "http" | "https") {
        if let Err(e) = webview
            .app_handle()
            .opener()
            .open_url(url.as_str(), None::<&str>)
        {
            crate::log_to_file(&format!(
                "[nav-guard] blocked {} and failed to open it externally: {e}",
                url.as_str()
            ));
        } else {
            crate::log_to_file(&format!(
                "[nav-guard] blocked in-app navigation to {}, opened it in the system browser",
                url.as_str()
            ));
        }
    } else {
        crate::log_to_file(&format!(
            "[nav-guard] blocked navigation to non-web URL {}",
            url.as_str()
        ));
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn allows_production_dial8() {
        assert!(is_allowed(&u("https://dial8.ai/account")));
        assert!(is_allowed(&u("https://dial8.ai/")));
        assert!(is_allowed(&u("https://www.dial8.ai/pricing")));
    }

    #[test]
    fn rejects_every_other_subdomain() {
        // A taken-over or third-party-hosted subdomain never renders in-app
        // (security review 2026-10-31, P0-3); it opens in the system browser.
        for url in [
            "https://app.dial8.ai/account?switch_to=abc",
            "https://docs.dial8.ai/",
            "https://status.dial8.ai/",
            "https://evil.dial8.ai/",
            "https://a.b.dial8.ai/",
        ] {
            assert!(!is_allowed(&u(url)), "{url}");
        }
    }

    #[test]
    fn rejects_http_dial8_in_release_logic() {
        // http://dial8.ai is never allowed (only https for the real host).
        assert!(!is_allowed(&u("http://dial8.ai/")));
    }

    #[test]
    fn localhost_only_in_debug() {
        let localhost = u("http://localhost:3000/account");
        let loopback = u("http://127.0.0.1:3000/account");
        assert_eq!(is_allowed(&localhost), cfg!(debug_assertions));
        assert_eq!(is_allowed(&loopback), cfg!(debug_assertions));
        // https localhost is not the dev server and is not allowed.
        assert!(!is_allowed(&u("https://localhost:3000/")));
    }

    #[test]
    fn rejects_third_party_web_origins() {
        assert!(!is_allowed(&u("https://checkout.stripe.com/pay/cs_test")));
        assert!(!is_allowed(&u("https://accounts.google.com/o/oauth2/v2/auth")));
        assert!(!is_allowed(&u("http://127.0.0.1:8799/")) || cfg!(debug_assertions));
        assert!(!is_allowed(&u("https://evil.example.com/")));
    }

    #[test]
    fn rejects_lookalike_hosts() {
        // Suffix match must be on a dot boundary, not a substring.
        assert!(!is_allowed(&u("https://dial8.ai.evil.com/")));
        assert!(!is_allowed(&u("https://notdial8.ai/")));
        assert!(!is_allowed(&u("https://dial8ai.com/")));
    }

    #[test]
    fn allows_internal_schemes() {
        assert!(is_allowed(&u("about:blank")));
        assert!(is_allowed(&u("tauri://localhost/index.html")));
        assert!(is_allowed(&u("ipc://localhost")));
        assert!(is_allowed(&u("data:text/html,<p>hi</p>")));
        assert!(is_allowed(&u("blob:https://dial8.ai/uuid")));
    }

    #[test]
    fn rejects_other_schemes() {
        assert!(!is_allowed(&u("file:///etc/passwd")));
        assert!(!is_allowed(&u("dial8desktop://auth/callback?code=x")));
    }
}
