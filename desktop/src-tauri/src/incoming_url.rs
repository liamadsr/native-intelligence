//! URLs that reach the app from OUTSIDE the main web view, and where each goes.
//!
//! The deep-link plugin feeds this (launch URLs from `get_current()` and every
//! `deep-link://new-url` event): the OS hands Native Intelligence its own `dial8desktop://`
//! callbacks (sign-in and integration OAuth).
//!
//! A `dial8desktop://…` URL is broadcast as `deep-link-auth` (the web app's
//! DeepLinkHandler). Anything else is dropped: Native Intelligence is never a handler for
//! http(s) links.

use tauri::{AppHandle, Emitter, Runtime, Url};

/// The app's own custom scheme (tauri.conf.json `plugins.deep-link`).
pub const AUTH_SCHEME: &str = "dial8desktop";
/// Broadcast for auth / OAuth callbacks (the web DeepLinkHandler listens).
pub const AUTH_EVENT: &str = "deep-link-auth";

/// The `dial8desktop://` URL in `raw`, trimmed; `None` for anything else. Pure.
pub fn auth_callback(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let url = Url::parse(raw).ok()?;
    (url.scheme() == AUTH_SCHEME).then(|| raw.to_string())
}

/// The URLs in a `deep-link://new-url` payload: a JSON array of strings (the
/// plugin's shape), a JSON string, or a bare URL. Empty entries are dropped.
pub fn parse_new_url_payload(raw: &str) -> Vec<String> {
    if let Ok(urls) = serde_json::from_str::<Vec<String>>(raw) {
        return urls.into_iter().filter(|u| !u.is_empty()).collect();
    }
    if let Ok(url) = serde_json::from_str::<String>(raw) {
        return if url.is_empty() { vec![] } else { vec![url] };
    }
    let raw = raw.trim();
    if raw.is_empty() {
        vec![]
    } else {
        vec![raw.to_string()]
    }
}

/// Route one incoming URL (see the module doc). `source` names where it came
/// from, for the log only.
pub fn route<R: Runtime>(app: &AppHandle<R>, raw: &str, source: &str) {
    match auth_callback(raw) {
        Some(url) => {
            crate::log_to_file(&format!("[incoming] {source}: auth callback"));
            let _ = app.emit(AUTH_EVENT, url);
        }
        None => crate::log_to_file(&format!("[incoming] {source}: dropped a URL that isn't dial8desktop://")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_scheme_is_auth_verbatim() {
        assert_eq!(
            auth_callback("dial8desktop://auth/callback?code=abc").as_deref(),
            Some("dial8desktop://auth/callback?code=abc")
        );
        assert_eq!(
            auth_callback("  dial8desktop://oauth/success?provider=google  ").as_deref(),
            Some("dial8desktop://oauth/success?provider=google")
        );
    }

    #[test]
    fn everything_else_is_dropped() {
        assert_eq!(auth_callback("https://example.com/a?b=1"), None);
        assert_eq!(auth_callback("https://dial8.ai/auth/desktop-callback?code=abc"), None);
        assert_eq!(auth_callback("file:///etc/passwd"), None);
        assert_eq!(auth_callback("zoommtg://join?x=1"), None);
        assert_eq!(auth_callback("not a url"), None);
        assert_eq!(auth_callback(""), None);
    }

    #[test]
    fn new_url_payload_shapes() {
        assert_eq!(parse_new_url_payload(r#"["https://a.com/","dial8desktop://x",""]"#), vec!["https://a.com/", "dial8desktop://x"]);
        assert_eq!(parse_new_url_payload(r#""https://a.com/""#), vec!["https://a.com/"]);
        assert_eq!(parse_new_url_payload("https://a.com/"), vec!["https://a.com/"]);
        assert!(parse_new_url_payload("").is_empty());
        assert!(parse_new_url_payload("[]").is_empty());
    }
}
