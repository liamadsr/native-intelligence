//! The automation bridge: a loopback HTTP server that lets a recorder (the
//! content-machine product-video tool) run JavaScript in the main window's web
//! view and read the result back. The recorder moves the real mouse and types
//! real keys itself (CGEvent); all it needs from the app is to ask the page
//! where things are and what state it's in. WebDriver doesn't exist for
//! WKWebView on macOS, and Puppeteer/Playwright need Chromium, hence this.
//!
//! NOT IN RELEASE BUILDS. The module is compiled only into debug builds (what
//! dev.sh builds) and builds with the `automation-bridge` cargo feature
//! (`cargo tauri build --features automation-bridge`, an optimized build for
//! the recorder; release.sh never passes it). In a released app the env vars
//! below do nothing: any process of the same user could relaunch Dial8 with
//! them and run its own JavaScript in the page that holds the app's IPC
//! (security review 2026-10-31).
//!
//! INERT UNLESS ASKED FOR. It starts only when BOTH env vars are set at launch:
//!
//!   DIAL8_AUTOMATION_PORT   an integer from 1024 to 65535
//!   DIAL8_AUTOMATION_TOKEN  32+ visible ASCII characters (no spaces)
//!
//! Neither set: nothing happens, no log line. Only one set, or a bad value:
//! one warning in the debug log, and nothing starts. Both good: the server
//! binds 127.0.0.1:<port> (never 0.0.0.0 or ::), the main web view gets
//! `window.__DIAL8_AUTOMATION__ = Object.freeze({ version: 1 })` at document
//! start of every load (the web app's own automation API keys off it), and
//! one line is logged: `automation bridge listening on 127.0.0.1:<port>`. The
//! token is never logged.
//!
//! QUIT DIAL8 FIRST. The env vars only reach a NEW process. If Dial8 is
//! already running, Launch Services just activates it (env ignored), and a
//! second process started some other way is told off by the single-instance
//! plugin (its unix socket, /tmp/ai_dial8_desktop_si.sock) and exits before
//! setup, so the bridge never starts. A fresh launch is unaffected: with no
//! running instance the socket connect fails and this process becomes the
//! instance, with its own env. So the recorder must quit Dial8 (a real quit,
//! not close-to-tray), wait for the process to be gone
//! (`NSRunningApplication.isTerminated`), then launch it with the vars
//! (`NSWorkspace.openApplication` with `OpenConfiguration.environment`), and
//! poll `/health` until it answers.
//!
//! DRIVING IT. `/health` answers before the page has loaded, and the page
//! loads twice at launch (webview.rs loads it again once the flag is in), so
//! a recorder waits for the page's own API before relying on it. A script
//! running when the page navigates answers WebKit's `Completion handler for
//! function call is no longer reachable`: retry it. While the window is
//! covered, WebKit stops rendering it and `requestAnimationFrame` never fires.
//!
//! No IPC surface: no Tauri command, no capability, nothing the page can call.
//! The page can't reach the server either: any request with an `Origin`
//! header is refused (403) and no CORS header is ever sent, and every request
//! needs the bearer token. See server.rs for the HTTP side and webview.rs for
//! the WKWebView side.

mod server;
#[cfg(target_os = "macos")]
mod webview;

use crate::log_to_file;

/// Protocol version, `/health`'s `bridge` and the page flag's `version`.
pub const PROTOCOL_VERSION: u32 = 1;

pub const PORT_VAR: &str = "DIAL8_AUTOMATION_PORT";
pub const TOKEN_VAR: &str = "DIAL8_AUTOMATION_TOKEN";

/// The shortest token accepted.
const MIN_TOKEN_CHARS: usize = 32;

/// What the bridge was asked for at launch.
#[derive(Debug, PartialEq, Eq)]
enum Activation {
    /// Neither variable set: the normal app.
    Absent,
    /// Set, but not usable: logged once, nothing starts.
    Invalid(String),
    Valid { port: u16, token: String },
}

/// Decide from the two variables' values (None: unset).
///
/// An empty value counts as unset, so `DIAL8_AUTOMATION_PORT=` alone is the
/// normal app rather than a warning.
fn parse_activation(port: Option<&str>, token: Option<&str>) -> Activation {
    let port = port.filter(|p| !p.is_empty());
    let token = token.filter(|t| !t.is_empty());
    let (port, token) = match (port, token) {
        (None, None) => return Activation::Absent,
        (Some(_), None) => return Activation::Invalid(format!("{PORT_VAR} is set but {TOKEN_VAR} is not")),
        (None, Some(_)) => return Activation::Invalid(format!("{TOKEN_VAR} is set but {PORT_VAR} is not")),
        (Some(port), Some(token)) => (port, token),
    };
    let port = match port.trim().parse::<u16>() {
        Ok(port) if port >= 1024 => port,
        _ => return Activation::Invalid(format!("{PORT_VAR} must be an integer from 1024 to 65535")),
    };
    // Visible ASCII only: the token travels in an HTTP header, where a space,
    // a control character or non-ASCII would be mangled or refused.
    if token.chars().count() < MIN_TOKEN_CHARS || !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Activation::Invalid(format!(
            "{TOKEN_VAR} must be at least {MIN_TOKEN_CHARS} visible ASCII characters with no spaces"
        ));
    }
    Activation::Valid { port, token: token.to_string() }
}

/// Start the bridge if the launch asked for it. Call once from `setup()`,
/// after the main window exists. Never panics: a bridge that can't start
/// leaves the app exactly as it would be without the variables.
pub fn start(app: &tauri::AppHandle) {
    let port = std::env::var(PORT_VAR).ok();
    let token = std::env::var(TOKEN_VAR).ok();
    let (port, token) = match parse_activation(port.as_deref(), token.as_deref()) {
        Activation::Absent => return,
        Activation::Invalid(why) => {
            log_to_file(&format!("[automation] not started: {why}"));
            return;
        }
        Activation::Valid { port, token } => (port, token),
    };

    #[cfg(target_os = "macos")]
    {
        // Bound here, synchronously, so a port in use is known before the
        // page gets its flag: the flag says the bridge is up.
        let listener = match std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .and_then(|l| l.set_nonblocking(true).map(|()| l))
        {
            Ok(listener) => listener,
            Err(e) => {
                log_to_file(&format!("[automation] not started: can't listen on 127.0.0.1:{port}: {e}"));
                return;
            }
        };
        let backend = webview::MainWebView::new(app.clone());
        let server = std::sync::Arc::new(server::Server::new(&token, backend));
        tauri::async_runtime::spawn(async move {
            match tokio::net::TcpListener::from_std(listener) {
                Ok(listener) => server::serve(listener, server).await,
                Err(e) => log_to_file(&format!("[automation] listener failed: {e}")),
            }
        });
        webview::install_flag(app);
        log_to_file(&format!("automation bridge listening on 127.0.0.1:{port}"));
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, port, token);
        log_to_file("[automation] not started: the automation bridge is macOS only");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn neither_variable_is_the_normal_app() {
        assert_eq!(parse_activation(None, None), Activation::Absent);
        assert_eq!(parse_activation(Some(""), Some("")), Activation::Absent, "empty counts as unset");
    }

    #[test]
    fn one_variable_alone_is_invalid() {
        assert!(matches!(parse_activation(Some("47800"), None), Activation::Invalid(_)));
        assert!(matches!(parse_activation(None, Some(TOKEN)), Activation::Invalid(_)));
        assert!(matches!(parse_activation(Some("47800"), Some("")), Activation::Invalid(_)));
    }

    #[test]
    fn bad_ports_are_invalid() {
        for port in ["0", "80", "1023", "65536", "-1", "47800x", "4.78e4", "abc"] {
            assert!(
                matches!(parse_activation(Some(port), Some(TOKEN)), Activation::Invalid(_)),
                "port {port:?} must be refused"
            );
        }
    }

    #[test]
    fn bad_tokens_are_invalid() {
        let short = &TOKEN[..31];
        let spaced = "0123456789abcdef 123456789abcdef0";
        let non_ascii = "0123456789abcdef0123456789abcdeé";
        for token in [short, spaced, non_ascii] {
            assert!(
                matches!(parse_activation(Some("47800"), Some(token)), Activation::Invalid(_)),
                "token {token:?} must be refused"
            );
        }
    }

    #[test]
    fn good_values_are_valid() {
        assert_eq!(
            parse_activation(Some("47800"), Some(TOKEN)),
            Activation::Valid { port: 47800, token: TOKEN.to_string() }
        );
        assert_eq!(
            parse_activation(Some("1024"), Some(TOKEN)),
            Activation::Valid { port: 1024, token: TOKEN.to_string() }
        );
        assert_eq!(
            parse_activation(Some("65535"), Some(TOKEN)),
            Activation::Valid { port: 65535, token: TOKEN.to_string() }
        );
    }

    /// The warning names the variable, never the token's value.
    #[test]
    fn warnings_never_carry_the_token() {
        let secret = "s3cr3t-s3cr3t-s3cr3t-s3cr3t-s3cr3t";
        for activation in [
            parse_activation(Some("80"), Some(secret)),
            parse_activation(None, Some(secret)),
            parse_activation(Some("47800"), Some("s3cr3t short")),
        ] {
            let Activation::Invalid(why) = activation else { panic!("expected invalid") };
            assert!(!why.contains("s3cr3t"), "{why}");
        }
    }
}
