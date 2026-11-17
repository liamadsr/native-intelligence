//! Saved logins for the agent's cloud browser.
//!
//! A site's password lives in this machine's keystore (the Keychain on a Mac,
//! Credential Manager on Windows) and nowhere else: never in a file, never on
//! Native Intelligence's server. The list of what is saved (the site, the account
//! name, whether to ask first) is a small file beside the app's settings; it
//! holds no secret.
//!
//! How one is used: the person's cloud browser reaches a site's sign-in page,
//! and its relay asks this machine for that site's login over the tunnel this
//! app already holds to it (`browser_exit.rs`; the question is a stream to
//! `browser_exit::node::LOCAL_HOST`, answered here). The answer goes back on
//! the same stream, encrypted like the rest of the tunnel, and the relay types
//! it into the page. What guards it:
//! - the tunnel is to the signed-in account's own browser, by a token checked
//!   against the keys pinned in this binary (`browser_exit.rs`), and the
//!   account is checked again here at each answer;
//! - a login is given only for its own site or a subdomain of it;
//! - the person is asked first, in a dialog on this machine, unless they set
//!   that login to be used without asking. That switch is theirs alone: the
//!   web page can turn asking ON, but turning it OFF takes a yes in a dialog
//!   on this machine (every command here is reachable by whatever the server
//!   sends, tests/capability_policy.rs), and a new login always asks;
//! - a page on a SUBDOMAIN of the saved site (not the site itself, or its
//!   `www.`) always asks, whatever the switch says: some sites hand subdomains
//!   to strangers, and the dialog names the host;
//! - at most [`ANSWERS_PER_SITE`] answers for a site, and [`ANSWERS_IN_ALL`]
//!   in all, per [`ANSWER_WINDOW`]: a relay gone wrong can't drain the list
//!   or lock an account out with wrong tries.
//!
//! What it does not guard against: the browser's sandbox is the one asking.
//! Whoever controlled it (an escape from the cloud Chrome) could ask as the
//! relay does, and would get the logins set to be used without asking while
//! this app runs. The first use of every other login shows on this screen.
//!
//! Commands (each in build.rs `APP_COMMANDS` and lib.rs `generate_handler!`):
//! `saved_logins_list`, `saved_login_save`, `saved_login_remove`,
//! `saved_login_set_ask`. A login that was used is announced to the windows
//! as `saved-logins://used` (the site and the account name, never the password).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use browser_exit::node::LocalService;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_store::StoreExt;
use tokio::sync::oneshot;

use crate::log_to_file;

/// The keystore's service name for every saved login.
const KEYSTORE_SERVICE: &str = "Native Intelligence saved login";
const STORE_FILE: &str = "saved-logins.json";
const STORE_KEY: &str = "logins";
/// The most logins one machine keeps.
pub const MAX_LOGINS: usize = 200;
const MAX_FIELD: usize = 512;
/// Answers given for one site, and in all, per window.
pub const ANSWERS_PER_SITE: usize = 2;
pub const ANSWERS_IN_ALL: usize = 10;
pub const ANSWER_WINDOW: Duration = Duration::from_secs(10 * 60);

/// One saved login, as the list file keeps it and the settings page shows it. No secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedLogin {
    pub id: String,
    /// The account that saved it: another account signed into this app never sees or uses it.
    pub user_id: String,
    /// The site it signs in to ("example.com"): a host, lower case, no `www.`.
    pub site: String,
    pub username: String,
    /// Ask on this machine before each use (the default).
    pub ask: bool,
}

/// Where the passwords are kept. The real one is the OS keystore; tests use a map.
pub trait SecretStore: Send + Sync {
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

struct Keystore;

/// The keystores this app knows: without one of them the crate would keep
/// secrets in memory and lose them at quit, so nothing is saved at all.
const HAS_KEYSTORE: bool = cfg!(any(target_os = "macos", target_os = "windows"));
const NO_KEYSTORE: &str = "This computer has no keystore Native Intelligence can use.";

impl SecretStore for Keystore {
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        if !HAS_KEYSTORE {
            return Err(NO_KEYSTORE.into());
        }
        keyring::Entry::new(KEYSTORE_SERVICE, account).and_then(|entry| entry.set_password(secret)).map_err(|e| e.to_string())
    }
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        if !HAS_KEYSTORE {
            return Err(NO_KEYSTORE.into());
        }
        match keyring::Entry::new(KEYSTORE_SERVICE, account).and_then(|entry| entry.get_password()) {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        match keyring::Entry::new(KEYSTORE_SERVICE, account).and_then(|entry| entry.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// The keystore's account name for a login: its id alone, so a renamed site or account never strands a secret.
fn secret_account(login: &SavedLogin) -> String {
    format!("{}:{}", login.user_id, login.id)
}

/// A site as the person typed it ("https://www.Example.com/login", "example.com") as a host, or None.
/// A single word is refused ("example" is a missing ".com"), and so is an address with a port or a login in it.
pub fn normalize_site(input: &str) -> Option<String> {
    let text = input.trim();
    if text.is_empty() || text.len() > MAX_FIELD {
        return None;
    }
    let with_scheme = if text.contains("://") { text.to_string() } else { format!("https://{text}") };
    let url = url::Url::parse(&with_scheme).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.port().is_some() || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = match url.host()? {
        url::Host::Domain(name) => name.trim_end_matches('.').to_ascii_lowercase(),
        _ => return None,
    };
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    if !host.contains('.') || host.starts_with('.') {
        return None;
    }
    Some(host)
}

/// Whether a login saved for `site` may be given to a page on `host`: the site itself or a subdomain of it.
pub fn site_covers(site: &str, host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == site || host.ends_with(&format!(".{site}"))
}

/// Whether `host` is the saved site itself (or its `www.`), not a deeper subdomain of it.
pub fn site_is(site: &str, host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == site || host.strip_prefix("www.") == Some(site)
}

/// The login for `host`, among `user`'s: the one whose site is the closest (longest) match.
pub fn pick<'a>(logins: &'a [SavedLogin], user: &str, host: &str) -> Option<&'a SavedLogin> {
    logins.iter().filter(|login| login.user_id == user && site_covers(&login.site, host)).max_by_key(|login| login.site.len())
}

/// The relay's question: `{"v":1,"op":"saved_login","host":"app.example.com"}`. The host, or None for anything else.
pub fn question_host(question: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(question).ok()?;
    if value.get("v")?.as_u64()? != 1 || value.get("op")?.as_str()? != "saved_login" {
        return None;
    }
    let host = value.get("host")?.as_str()?.trim().trim_end_matches('.').to_ascii_lowercase();
    // A host name only: what a page's `location.hostname` is, never an address with a path, a port or a login.
    let plain = !host.is_empty() && host.len() <= 253 && host.contains('.')
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
    plain.then_some(host)
}

fn refusal(reason: &str) -> Vec<u8> {
    serde_json::json!({ "ok": false, "reason": reason }).to_string().into_bytes()
}

/// The answers given lately, for the caps.
#[derive(Default)]
struct Recent {
    given: VecDeque<(Instant, String)>,
}

impl Recent {
    /// Whether one more answer for `site` fits now; it is counted when it does.
    fn take(&mut self, site: &str, now: Instant) -> bool {
        while self.given.front().is_some_and(|(at, _)| now.duration_since(*at) > ANSWER_WINDOW) {
            self.given.pop_front();
        }
        if self.given.len() >= ANSWERS_IN_ALL || self.given.iter().filter(|(_, s)| s == site).count() >= ANSWERS_PER_SITE {
            return false;
        }
        self.given.push_back((now, site.to_string()));
        true
    }
}

pub struct SavedLoginsService {
    secrets: Arc<dyn SecretStore>,
    recent: Mutex<Recent>,
    /// One dialog at a time, held until the person answers it (even when the
    /// question it was for has gone): two at once would be two things to misread.
    asking: Arc<tokio::sync::Mutex<()>>,
    /// One change to the list at a time.
    writing: tokio::sync::Mutex<()>,
}

impl Default for SavedLoginsService {
    fn default() -> Self {
        SavedLoginsService { secrets: Arc::new(Keystore), recent: Mutex::new(Recent::default()),
            asking: Arc::new(tokio::sync::Mutex::new(())), writing: tokio::sync::Mutex::new(()) }
    }
}

/// The list as the file holds it. A file that can't be read is an error, never an empty list: a save over it would lose every entry.
fn read_logins(app: &AppHandle) -> Result<Vec<SavedLogin>, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    match store.get(STORE_KEY) {
        None => Ok(Vec::new()),
        Some(value) => serde_json::from_value(value).map_err(|_| "The list of saved logins on this computer can't be read.".to_string()),
    }
}

fn write_logins(app: &AppHandle, logins: &[SavedLogin]) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(STORE_KEY, serde_json::to_value(logins).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

fn signed_in_user(app: &AppHandle) -> Option<String> {
    let token = app.state::<crate::state::AppState>().auth_token.lock().unwrap().clone()?;
    crate::browser_exit::session_user(&token)
}

/// A yes or no from the person, in a dialog on this machine. It holds `asking` until it is answered, whoever
/// still waits for the answer: a question the browser gave up on never leaves a second dialog beside its own.
async fn confirm(app: &AppHandle, asking: Arc<tokio::sync::Mutex<()>>, title: String, body: String, yes: &str, no: &str) -> bool {
    let guard = asking.lock_owned().await;
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .message(body)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(yes.to_string(), no.to_string()))
        .show(move |answer| {
            drop(guard);
            let _ = tx.send(answer);
        });
    rx.await.unwrap_or(false)
}

/// Before a login that asks is used.
async fn confirm_use(app: &AppHandle, asking: Arc<tokio::sync::Mutex<()>>, login: &SavedLogin, host: &str) -> bool {
    confirm(app, asking, format!("Sign in to {host} for your agent?"),
        format!("Your agent's browser is at the sign-in page of {host} and asks to sign in as {}.\n\nThe password goes from this computer's keystore straight to your own cloud browser.", login.username),
        "Sign in", "Not now").await
}

/// Answer the relay's question for the account `tunnel_user`'s browser. Never logs a secret or the question's bytes.
async fn answer(app: AppHandle, tunnel_user: String, question: Vec<u8>) -> Vec<u8> {
    let Some(host) = question_host(&question) else { return refusal("bad_request") };
    // The tunnel was opened for this account; another one signed in since gets nothing.
    if signed_in_user(&app).as_deref() != Some(tunnel_user.as_str()) {
        return refusal("unavailable");
    }
    let Some(svc) = app.try_state::<SavedLoginsService>() else { return refusal("unavailable") };
    let Ok(logins) = read_logins(&app) else { return refusal("unavailable") };
    let Some(login) = pick(&logins, &tunnel_user, &host).cloned() else { return refusal("none") };
    // Counted before the person is asked: the cap bounds the dialogs too.
    if !svc.recent.lock().unwrap().take(&login.site, Instant::now()) {
        log_to_file(&format!("[saved-logins] refused: too many uses of the login for {} lately", login.site));
        return refusal("busy");
    }
    // A subdomain of the saved site always asks, whatever the login's switch says.
    let asks = login.ask || !site_is(&login.site, &host);
    if asks && !confirm_use(&app, svc.asking.clone(), &login, &host).await {
        return refusal("declined");
    }
    // The account may have changed while the dialog was up.
    if signed_in_user(&app).as_deref() != Some(tunnel_user.as_str()) {
        return refusal("unavailable");
    }
    let password = match svc.secrets.get(&secret_account(&login)) {
        Ok(Some(password)) => password,
        Ok(None) => return refusal("none"),
        Err(e) => {
            log_to_file(&format!("[saved-logins] the keystore could not be read: {e}"));
            return refusal("unavailable");
        }
    };
    log_to_file(&format!("[saved-logins] the login for {} was given to the agent's browser (asked first: {asks})", login.site));
    let _ = app.emit("saved-logins://used", serde_json::json!({ "site": login.site, "username": login.username }));
    // `host` is the one this answer is for: the relay types it nowhere else (browser-agent/sign-in-fill.ts).
    serde_json::json!({ "ok": true, "host": host, "username": login.username, "password": password }).to_string().into_bytes()
}

/// What answers the tunnel's questions for `tunnel_user`'s browser (`browser_exit.rs` hands it to the tunnel).
pub fn service(app: AppHandle, tunnel_user: String) -> LocalService {
    Arc::new(move |question: Vec<u8>| Box::pin(answer(app.clone(), tunnel_user.clone(), question)))
}

#[tauri::command]
pub async fn saved_logins_list(app: AppHandle) -> Result<Vec<SavedLogin>, String> {
    let Some(user) = signed_in_user(&app) else { return Ok(Vec::new()) };
    Ok(read_logins(&app)?.into_iter().filter(|login| login.user_id == user).collect())
}

/// Save a login (a new one, or the same site and account again with a new password). A new one always asks
/// before each use: only `saved_login_set_ask`, with the person's yes on this machine, turns that off.
#[tauri::command]
pub async fn saved_login_save(app: AppHandle, svc: State<'_, SavedLoginsService>, site: String, username: String, password: String) -> Result<SavedLogin, String> {
    let user = signed_in_user(&app).ok_or("Sign in to Native Intelligence first.")?;
    let site = normalize_site(&site).ok_or("That does not look like a website (for example: example.com).")?;
    let username = username.trim().to_string();
    if username.is_empty() || username.len() > MAX_FIELD {
        return Err("Enter the account name you sign in with.".into());
    }
    if password.is_empty() || password.len() > MAX_FIELD {
        return Err("Enter the password.".into());
    }
    let _writing = svc.writing.lock().await;
    let mut logins = read_logins(&app)?;
    let existing = logins.iter().position(|login| login.user_id == user && login.site == site && login.username == username);
    let login = match existing {
        Some(at) => logins[at].clone(),
        None => {
            if logins.iter().filter(|login| login.user_id == user).count() >= MAX_LOGINS {
                return Err(format!("This computer already keeps {MAX_LOGINS} logins. Remove one first."));
            }
            let login = SavedLogin { id: uuid::Uuid::new_v4().to_string(), user_id: user, site, username, ask: true };
            logins.push(login.clone());
            login
        }
    };
    // The secret first: a list entry without its password would only ever fail.
    svc.secrets.set(&secret_account(&login), &password).map_err(|e| format!("This computer's keystore refused the password: {e}"))?;
    if let Err(e) = write_logins(&app, &logins) {
        // A new login that never reached the list would leave a secret nothing can remove.
        if existing.is_none() {
            let _ = svc.secrets.delete(&secret_account(&login));
        }
        return Err(e);
    }
    log_to_file(&format!("[saved-logins] saved a login for {}", login.site));
    Ok(login)
}

#[tauri::command]
pub async fn saved_login_remove(app: AppHandle, svc: State<'_, SavedLoginsService>, id: String) -> Result<(), String> {
    let user = signed_in_user(&app).ok_or("Sign in to Native Intelligence first.")?;
    let _writing = svc.writing.lock().await;
    let mut logins = read_logins(&app)?;
    let Some(at) = logins.iter().position(|login| login.id == id && login.user_id == user) else { return Ok(()) };
    let login = logins.remove(at);
    svc.secrets.delete(&secret_account(&login)).map_err(|e| format!("This computer's keystore could not remove the password: {e}"))?;
    write_logins(&app, &logins)?;
    log_to_file(&format!("[saved-logins] removed the login for {}", login.site));
    Ok(())
}

/// Ask before each use, or use it without asking. Turning asking off is the person's own yes, in a dialog on
/// this machine: the page that calls this runs what the server sends, and must not be able to do it alone.
#[tauri::command]
pub async fn saved_login_set_ask(app: AppHandle, svc: State<'_, SavedLoginsService>, id: String, ask: bool) -> Result<SavedLogin, String> {
    let user = signed_in_user(&app).ok_or("Sign in to Native Intelligence first.")?;
    let current = read_logins(&app)?.into_iter().find(|login| login.id == id && login.user_id == user).ok_or("That login is no longer saved.")?;
    if !ask && current.ask {
        let yes = confirm(&app, svc.asking.clone(), format!("Sign in to {} without asking?", current.site),
            format!("Your agent's browser will sign in to {} as {} by itself whenever it reaches the sign-in page, while this app is open. You won't be asked on this computer first.", current.site, current.username),
            "Stop asking", "Keep asking").await;
        if !yes {
            return Ok(current);
        }
    }
    let _writing = svc.writing.lock().await;
    let mut logins = read_logins(&app)?;
    let login = logins.iter_mut().find(|login| login.id == id && login.user_id == user).ok_or("That login is no longer saved.")?;
    login.ask = ask;
    let login = login.clone();
    write_logins(&app, &logins)?;
    Ok(login)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn login(user: &str, site: &str, name: &str) -> SavedLogin {
        SavedLogin { id: format!("{user}-{site}"), user_id: user.into(), site: site.into(), username: name.into(), ask: true }
    }

    #[test]
    fn a_site_is_a_plain_host_however_it_was_typed() {
        assert_eq!(normalize_site("example.com").as_deref(), Some("example.com"));
        assert_eq!(normalize_site("  https://WWW.Example.com/login?next=1 ").as_deref(), Some("example.com"));
        assert_eq!(normalize_site("app.example.co.uk").as_deref(), Some("app.example.co.uk"));
        for bad in ["", "example", "https://example.com:8443", "https://kim:pw@example.com", "ftp://example.com", "http://127.0.0.1", "http://[::1]/", ".com"] {
            assert_eq!(normalize_site(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_login_covers_its_site_and_subdomains_never_a_lookalike() {
        assert!(site_covers("example.com", "example.com"));
        assert!(site_covers("example.com", "Login.Example.com."));
        for other in ["notexample.com", "example.com.evil.test", "example.co", "com"] {
            assert!(!site_covers("example.com", other), "{other}");
        }
    }

    #[test]
    fn only_the_site_itself_or_its_www_is_not_a_subdomain() {
        assert!(site_is("example.com", "example.com"));
        assert!(site_is("example.com", "WWW.Example.com."));
        for deeper in ["login.example.com", "www.shop.example.com", "evil.example.com", "example.org"] {
            assert!(!site_is("example.com", deeper), "{deeper}");
        }
    }

    #[test]
    fn picks_the_closest_site_of_the_same_account_only() {
        let logins = vec![login("u1", "example.com", "kim"), login("u1", "shop.example.com", "kim-shop"), login("u2", "example.com", "other")];
        assert_eq!(pick(&logins, "u1", "shop.example.com").map(|l| l.username.as_str()), Some("kim-shop"));
        assert_eq!(pick(&logins, "u1", "www.example.com").map(|l| l.username.as_str()), Some("kim"));
        assert_eq!(pick(&logins, "u2", "shop.example.com").map(|l| l.username.as_str()), Some("other"));
        assert_eq!(pick(&logins, "u3", "example.com"), None);
        assert_eq!(pick(&logins, "u1", "example.org"), None);
    }

    #[test]
    fn reads_only_the_relays_own_question() {
        assert_eq!(question_host(br#"{"v":1,"op":"saved_login","host":"App.Example.com"}"#).as_deref(), Some("app.example.com"));
        for bad in [
            &br#"{"v":2,"op":"saved_login","host":"example.com"}"#[..],
            br#"{"v":1,"op":"list","host":"example.com"}"#,
            br#"{"v":1,"op":"saved_login","host":"example.com/login"}"#,
            br#"{"v":1,"op":"saved_login","host":"kim@example.com"}"#,
            br#"{"v":1,"op":"saved_login","host":"example.com:443"}"#,
            br#"{"v":1,"op":"saved_login","host":"localhost"}"#,
            br#"{"v":1,"op":"saved_login"}"#,
            b"GET / HTTP/1.1",
            b"",
        ] {
            assert_eq!(question_host(bad), None, "{}", String::from_utf8_lossy(bad));
        }
    }

    #[test]
    fn caps_the_answers_for_a_site_and_in_all_per_window() {
        let mut recent = Recent::default();
        let start = Instant::now();
        assert!(recent.take("example.com", start));
        assert!(recent.take("example.com", start));
        assert!(!recent.take("example.com", start), "a third for the same site");
        for i in 0..(ANSWERS_IN_ALL - 2) {
            assert!(recent.take(&format!("site{i}.example"), start));
        }
        assert!(!recent.take("one-more.example", start), "past the cap in all");
        // The window moves on.
        let later = start + ANSWER_WINDOW + Duration::from_secs(1);
        assert!(recent.take("example.com", later));
    }

    #[test]
    fn a_secrets_keystore_name_is_the_account_and_the_logins_id() {
        assert_eq!(secret_account(&login("u1", "example.com", "kim")), "u1:u1-example.com");
    }
}
