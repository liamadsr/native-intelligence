//! Desktop Google and ChatGPT sign-in in an ASWebAuthenticationSession.
//!
//! The sign-in page runs in the system's web-authentication sheet over the
//! calling Native Intelligence window (native/web_links_helper.m), and the session catches
//! the `dial8desktop://` callback itself, so the callback URL comes back as this
//! command's result instead of as an OS deep link. The web login form falls
//! back to opening the page with the opener when this command is missing.

use std::ffi::{c_char, c_void, CStr, CString};

use tokio::sync::oneshot;

/// The sign-in callback scheme (tauri.conf.json `plugins.deep-link`).
pub const CALLBACK_SCHEME: &str = crate::incoming_url::AUTH_SCHEME;
/// The error the web side tells apart from a failure: the user closed the
/// sheet (or a newer sign-in replaced this one).
pub const CANCELLED: &str = "cancelled";

type AuthResult = Result<String, String>;

#[cfg(target_os = "macos")]
extern "C" {
    fn web_links_auth_session_start(
        url: *const c_char,
        callback_scheme: *const c_char,
        ns_window: *mut c_void,
        ctx: *mut c_void,
        done: extern "C" fn(ctx: *mut c_void, callback_url: *const c_char, error: *const c_char),
    );
}

/// The pages a sign-in session may start on, as (host, path): Supabase's
/// authorize endpoint (Google sign-in through Supabase, login-form.tsx), and
/// Native Intelligence's own Google and ChatGPT sign-ins (`/auth/google`, `/auth/chatgpt`).
/// The web uses `/auth/google` once its Google client is configured
/// (src/lib/auth/google-sign-in.ts), so the person never sees the Supabase
/// project's URL; it falls back to Supabase's flow on a build that refuses
/// it. The session shares the person's Safari cookies, so any other page
/// could be an OAuth consent they've already given, ending on a
/// `dial8desktop://` URL the page reads (security review 2026-10-31). The
/// production Supabase project and the app's own domains (nav_guard.rs
/// `APP_DOMAINS`), one of which a release build loads.
///
/// The production project has two addresses: Supabase's own, and ours in
/// front of it (`sb.`). Which one a sign-in starts on is the web's setting
/// (NEXT_PUBLIC_SUPABASE_URL), and it moves from the first to the second. A
/// build that lists only the first refuses every Google sign-in from the day
/// the web moves, so both are here, and the first stays for as long as any
/// deployment can still be using it.
const SIGN_IN_PAGES: &[(&str, &str)] = &[
    ("bzfthjzyzevjokbuhqci.supabase.co", SUPABASE_AUTHORIZE),
    ("sb.nativeintelligence.dev", SUPABASE_AUTHORIZE),
    ("nativeintelligence.dev", GOOGLE_SIGN_IN),
    ("nativeintelligence.dev", CHATGPT_SIGN_IN),
    // TODO(rename-compat): the old domain, while it still serves the app (nav_guard.rs `APP_DOMAINS`).
    ("dial8.ai", GOOGLE_SIGN_IN),
    ("dial8.ai", CHATGPT_SIGN_IN),
];
/// Debug builds also: the dev Supabase project, and over http a local
/// Supabase or the dev server on a loopback host, any port.
const DEV_SIGN_IN_PAGES: &[(&str, &str)] = &[("edrjddsxjoigpbecqgfb.supabase.co", SUPABASE_AUTHORIZE)];
const SUPABASE_AUTHORIZE: &str = "/auth/v1/authorize";
const GOOGLE_SIGN_IN: &str = "/auth/google";
const CHATGPT_SIGN_IN: &str = "/auth/chatgpt";

/// May `raw` start a sign-in session? One of [`SIGN_IN_PAGES`], over https
/// on the default port, with no user info; any query. Pure.
pub fn session_url_allowed(raw: &str) -> bool {
    page_allowed(raw, cfg!(debug_assertions))
}

fn page_allowed(raw: &str, debug_build: bool) -> bool {
    let Ok(url) = tauri::Url::parse(raw.trim()) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return false;
    }
    let (Some(host), path) = (url.host_str(), url.path()) else {
        return false;
    };
    let listed = |pages: &[(&str, &str)]| pages.iter().any(|&(h, p)| h == host && p == path);
    match url.scheme() {
        "https" => url.port().is_none() && (listed(SIGN_IN_PAGES) || (debug_build && listed(DEV_SIGN_IN_PAGES))),
        "http" => {
            debug_build
                && matches!(host, "localhost" | "127.0.0.1")
                && matches!(path, SUPABASE_AUTHORIZE | GOOGLE_SIGN_IN | CHATGPT_SIGN_IN)
        }
        _ => false,
    }
}

/// Only a `dial8desktop://` URL is a sign-in result. Pure.
pub fn callback_ok(raw: &str) -> AuthResult {
    match tauri::Url::parse(raw) {
        Ok(url) if url.scheme() == CALLBACK_SCHEME => Ok(raw.to_string()),
        _ => Err("sign-in returned an unexpected URL".into()),
    }
}

/// Called once by native, on the main thread, with the session's outcome.
extern "C" fn on_done(ctx: *mut c_void, callback_url: *const c_char, error: *const c_char) {
    if ctx.is_null() {
        return;
    }
    // SAFETY: ctx is the Box::into_raw below; native calls this exactly once.
    let tx = unsafe { Box::from_raw(ctx as *mut oneshot::Sender<AuthResult>) };
    let text = |p: *const c_char| (!p.is_null()).then(|| unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned());
    let result = match (text(callback_url), text(error)) {
        (Some(url), _) => callback_ok(&url),
        (None, Some(e)) => Err(e),
        (None, None) => Err("sign-in failed".into()),
    };
    let _ = tx.send(result);
}

/// Run the sign-in page `url` (one of [`SIGN_IN_PAGES`]) in a web
/// authentication session presented over the calling window. Resolves with the
/// `dial8desktop://auth/callback?…` URL it ended on, or rejects: `"cancelled"`
/// when the user closed it, any other text on failure.
#[tauri::command]
pub async fn auth_web_session_cmd(window: tauri::WebviewWindow, url: String) -> AuthResult {
    if !session_url_allowed(&url) {
        return Err("not a Native Intelligence sign-in page".into());
    }
    #[cfg(target_os = "macos")]
    {
        let ns_window = window.ns_window().unwrap_or(std::ptr::null_mut());
        let (Ok(c_url), Ok(c_scheme)) = (CString::new(url), CString::new(CALLBACK_SCHEME)) else {
            return Err("string contained a NUL byte".into());
        };
        let (tx, rx) = oneshot::channel::<AuthResult>();
        let ctx = Box::into_raw(Box::new(tx)) as *mut c_void;
        // Native copies its arguments before returning and dispatches the
        // session onto the main thread; the outcome arrives through on_done.
        unsafe { web_links_auth_session_start(c_url.as_ptr(), c_scheme.as_ptr(), ns_window, ctx, on_done) };
        crate::log_to_file("[auth-session] sign-in session started");
        let result = rx.await.unwrap_or_else(|_| Err("sign-in ended unexpectedly".into()));
        crate::log_to_file(match &result {
            Ok(_) => "[auth-session] sign-in session returned a callback",
            Err(e) if e == CANCELLED => "[auth-session] sign-in session cancelled",
            Err(_) => "[auth-session] sign-in session failed",
        });
        result
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("the sign-in window is only available on macOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOGLE: &str = "https://bzfthjzyzevjokbuhqci.supabase.co/auth/v1/authorize?provider=google&redirect_to=https%3A%2F%2Fdial8.ai%2Fauth%2Fdesktop-callback&code_challenge=abc&code_challenge_method=s256";
    const GOOGLE_VIA_OUR_ADDRESS: &str = "https://sb.nativeintelligence.dev/auth/v1/authorize?provider=google&redirect_to=https%3A%2F%2Fdial8.ai%2Fauth%2Fdesktop-callback&code_challenge=abc&code_challenge_method=s256";
    const NI_GOOGLE: &str = "https://dial8.ai/auth/google?desktop=1&bind=0123abcd";
    const CHATGPT: &str = "https://dial8.ai/auth/chatgpt?desktop=1&bind=0123abcd";
    const NEW_GOOGLE: &str = "https://nativeintelligence.dev/auth/google?desktop=1&bind=0123abcd";
    const NEW_CHATGPT: &str = "https://nativeintelligence.dev/auth/chatgpt?desktop=1&bind=0123abcd";

    #[test]
    fn the_sign_in_pages_the_web_opens_are_allowed() {
        for debug_build in [false, true] {
            assert!(page_allowed(GOOGLE, debug_build));
            assert!(page_allowed(GOOGLE_VIA_OUR_ADDRESS, debug_build));
            assert!(page_allowed(NI_GOOGLE, debug_build));
            assert!(page_allowed(CHATGPT, debug_build));
            assert!(page_allowed(NEW_GOOGLE, debug_build));
            assert!(page_allowed(NEW_CHATGPT, debug_build));
        }
        // Every sign-in page of the app is on one of its domains, and each domain has both.
        for domain in crate::nav_guard::APP_DOMAINS {
            for path in [GOOGLE_SIGN_IN, CHATGPT_SIGN_IN] {
                assert!(SIGN_IN_PAGES.contains(&(domain, path)), "{domain}{path}");
            }
        }
    }

    #[test]
    fn no_other_page_starts_a_session() {
        for raw in [
            // Another host's consent page, with the person's Safari cookies.
            "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=dial8desktop://auth/callback",
            "https://github.com/login/oauth/authorize?client_id=x",
            // Another Supabase project, or another path on ours.
            "https://abc.supabase.co/auth/v1/authorize?provider=google",
            "https://bzfthjzyzevjokbuhqci.supabase.co/auth/v1/verify?token=x",
            "https://bzfthjzyzevjokbuhqci.supabase.co/auth/v1/authorize/../admin",
            // Our own address for the project: the authorize page and nothing else on it,
            // and no other host under the domain gets that page.
            "https://sb.nativeintelligence.dev/auth/v1/verify?token=x",
            "https://sb.nativeintelligence.dev/auth/v1/authorize/../admin",
            "https://sb.nativeintelligence.dev/auth/v1/callback?code=x",
            "https://sb.nativeintelligence.dev/",
            "https://sb.nativeintelligence.dev/auth/google",
            "https://sb.nativeintelligence.dev/auth/chatgpt",
            "https://nativeintelligence.dev/auth/v1/authorize?provider=google",
            "https://inngest.nativeintelligence.dev/auth/v1/authorize?provider=google",
            "https://x.sb.nativeintelligence.dev/auth/v1/authorize?provider=google",
            "https://sb.nativeintelligence.dev.evil.example/auth/v1/authorize?provider=google",
            "https://sb.nativeintelligence.dev@evil.example/auth/v1/authorize?provider=google",
            "https://user:pw@sb.nativeintelligence.dev/auth/v1/authorize?provider=google",
            "https://sb.nativeintelligence.dev:8443/auth/v1/authorize?provider=google",
            "http://sb.nativeintelligence.dev/auth/v1/authorize?provider=google",
            "https://sb.dial8.ai/auth/v1/authorize?provider=google",
            // Another page on dial8.ai, a subdomain, a look-alike.
            "https://dial8.ai/account",
            "https://dial8.ai/auth/chatgpt/callback?code=x",
            "https://dial8.ai/auth/google/callback?code=x",
            "https://www.dial8.ai/auth/google",
            "https://www.dial8.ai/auth/chatgpt",
            "https://share.dial8.ai/auth/chatgpt",
            "https://dial8.ai.evil.example/auth/chatgpt",
            "https://dial8.ai@evil.example/auth/chatgpt",
            "https://user:pw@dial8.ai/auth/chatgpt",
            "https://dial8.ai:8443/auth/chatgpt",
            "https://dial8.ai/auth/chatgpt#x",
            // The same for the new domain.
            "https://nativeintelligence.dev/account",
            "https://nativeintelligence.dev/auth/chatgpt/callback?code=x",
            "https://nativeintelligence.dev/auth/google/callback?code=x",
            "https://www.nativeintelligence.dev/auth/google",
            "https://www.nativeintelligence.dev/auth/chatgpt",
            "https://share.nativeintelligence.dev/auth/chatgpt",
            "https://browser-relay.nativeintelligence.dev/auth/chatgpt",
            "https://nativeintelligence.dev.evil.example/auth/chatgpt",
            "https://notnativeintelligence.dev/auth/chatgpt",
            "https://nativeintelligence.dev@evil.example/auth/chatgpt",
            "https://user:pw@nativeintelligence.dev/auth/chatgpt",
            "https://nativeintelligence.dev:8443/auth/chatgpt",
            "https://nativeintelligence.dev/auth/chatgpt#x",
            "http://nativeintelligence.dev/auth/chatgpt",
            // Not https.
            "http://dial8.ai/auth/chatgpt",
            "http://bzfthjzyzevjokbuhqci.supabase.co/auth/v1/authorize",
            "dial8desktop://auth/callback?code=x",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "",
        ] {
            for debug_build in [false, true] {
                assert!(!page_allowed(raw, debug_build), "{raw} (debug_build={debug_build})");
            }
        }
    }

    #[test]
    fn the_dev_project_and_loopback_are_a_debug_builds_alone() {
        for raw in [
            "https://edrjddsxjoigpbecqgfb.supabase.co/auth/v1/authorize?provider=google",
            "http://127.0.0.1:54321/auth/v1/authorize?provider=google",
            "http://localhost:3000/auth/chatgpt?desktop=1&bind=x",
            "http://localhost:3000/auth/google?desktop=1&bind=x",
        ] {
            assert!(page_allowed(raw, true), "{raw}");
            assert!(!page_allowed(raw, false), "{raw}");
        }
        assert!(!page_allowed("http://localhost:3000/account", true));
        assert!(!page_allowed("http://192.168.1.2:3000/auth/chatgpt", true));
        assert_eq!(session_url_allowed("http://localhost:3000/auth/chatgpt"), cfg!(debug_assertions));
    }

    #[test]
    fn only_our_scheme_is_a_result() {
        assert_eq!(
            callback_ok("dial8desktop://auth/callback?code=abc"),
            Ok("dial8desktop://auth/callback?code=abc".to_string())
        );
        assert!(callback_ok("https://dial8.ai/auth/desktop-callback?code=abc").is_err());
        assert!(callback_ok("nonsense").is_err());
    }

    #[test]
    fn done_callback_delivers_once_through_the_channel() {
        let (tx, mut rx) = oneshot::channel::<AuthResult>();
        let ctx = Box::into_raw(Box::new(tx)) as *mut c_void;
        let err = CString::new(CANCELLED).unwrap();
        on_done(ctx, std::ptr::null(), err.as_ptr());
        assert_eq!(rx.try_recv().unwrap(), Err(CANCELLED.to_string()));

        let (tx, mut rx) = oneshot::channel::<AuthResult>();
        let ctx = Box::into_raw(Box::new(tx)) as *mut c_void;
        let url = CString::new("dial8desktop://auth/callback?code=x").unwrap();
        on_done(ctx, url.as_ptr(), std::ptr::null());
        assert_eq!(rx.try_recv().unwrap(), Ok("dial8desktop://auth/callback?code=x".to_string()));
    }
}
