//! The Mac exit for the agent's cloud browser (web
//! docs/plans/cloud-browser.md, C4): the app's side of `crates/browser-exit`.
//!
//! The signed-in main window hands over a token and the hub's URL when the
//! person's cloud browser comes up (its `browser-up` doorbell). Neither the
//! page nor the server is trusted with where this Mac's connection goes
//! (security review 2026-10-31 P1-3: a server that served its own key would
//! make this Mac its egress):
//! - the token is checked here against the public keys pinned in this binary
//!   ([`PINNED_KEYS`], like the updater's), and names the only hub it opens
//!   ([`browser_exit::ticket`]). The key the server serves is only compared
//!   with them (a debug build trusts it too: a local server signs with its own);
//! - it serves only the account this app is signed into (the session the main
//!   window hands over, commands/tray.rs): a token for any other account
//!   (someone else's browser, handed over by a page) is refused, without
//!   asking, and a sign-out or another account in the main window stops it.
//!   The page hands over that session too, so this guards against a wrong
//!   ticket from the app's own flows, not a hostile page (which can already
//!   drive the app's commands): it is the same trust as the rest of them;
//! - this Mac's public IP is never reached, whatever a hub says (a router
//!   answers there): the address the server saw, AND the one Cloudflare sees
//!   ([`OWN_IP_URL`], asked alongside: a view the server doesn't control), AND
//!   the one the hub saw are all refused, as are this Mac's own interfaces
//!   (a public IPv4 on one, and the /56 of each global IPv6, crates/browser-exit
//!   policy.rs). A server that lies about the address only adds one more.
//!
//! No switch and no question (Liam, 2026-10-23: the person's agent uses the
//! person's network whenever this Mac is online, as any app would). The menu
//! bar shows it while it runs, with the sites it reached today (kept in memory
//! on this Mac only).
//!
//! Commands (each in build.rs `APP_COMMANDS` and lib.rs `generate_handler!`):
//! `browser_exit_start`, `browser_exit_stop`, `browser_exit_status`. Status
//! changes go to the windows as `browser-exit://status`.

use std::collections::BTreeMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

use browser_exit::node::{run, EndReason, Event, Options};
use browser_exit::ticket::{public_key, verify, Claims, TicketError};
use chrono::{Local, NaiveDate};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, watch};

use crate::log_to_file;

pub const STATUS_EVENT: &str = "browser-exit://status";
/// Sites listed in the menu, at most.
pub const MENU_SITES: usize = 10;
/// The server's key and this Mac's IP are asked for again after this long.
const KEY_TTL: Duration = Duration::from_secs(300);
const KEY_TIMEOUT: Duration = Duration::from_secs(10);

/// The keys an exit token may be signed with: the public half of the
/// website's `CLOUD_BROWSER_SIGNING_KEY` (base64 SPKI DER, as
/// `/api/browser-exit/key` serves it). To rotate: add the new key here and
/// release, switch the server to it, then drop the old one in a later release.
pub const PINNED_KEYS: &[&str] = &["MCowBQYDK2VwAyEANCDKQZ7Oveymu6dwbB1nhBbUxDzMRnwmSmWHm+M0THk="];

/// This Mac's public address as Cloudflare sees it (its trace page: an `ip=`
/// line), over TLS, at an IPv4 address, so the answer is the address the
/// Mac's router shows the internet, whichever way the server was reached.
const OWN_IP_URL: &str = "https://1.1.1.1/cdn-cgi/trace";
/// Short: an unreachable 1.1.1.1 (some networks block it) must not hold the start up.
const OWN_IP_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExitState {
    Off,
    Connecting,
    Up,
    Down,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SiteCount {
    pub host: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitStatus {
    pub state: ExitState,
    /// The tunnel ended because its token did (or was refused): the page
    /// fetches a fresh one when the browser is still up.
    pub needs_token: bool,
    pub sites_today: Vec<SiteCount>,
}

struct Running {
    /// Which run this is: events of a run that was replaced change nothing.
    generation: u64,
    stop: watch::Sender<bool>,
    sandbox: String,
    hub: String,
}

/// This Mac's public address, kept a few minutes: as the server saw it (with
/// the key the server signs with now, only compared with [`PINNED_KEYS`]), and
/// as Cloudflare saw it.
#[derive(Clone)]
struct ServerView {
    key: Option<[u8; 32]>,
    ip: Option<IpAddr>,
    own_ip: Option<IpAddr>,
    at: Instant,
}

#[derive(Default)]
struct Inner {
    running: Option<Running>,
    generation: u64,
    state: Option<ExitState>,
    needs_token: bool,
    day: Option<NaiveDate>,
    sites: BTreeMap<String, u32>,
    server: Option<ServerView>,
}

#[derive(Default, Clone)]
pub struct BrowserExitService {
    inner: Arc<Mutex<Inner>>,
}

/// The sites reached today, most first.
pub fn top_sites(sites: &BTreeMap<String, u32>, limit: usize) -> Vec<SiteCount> {
    let mut list: Vec<SiteCount> = sites.iter().map(|(host, count)| SiteCount { host: host.clone(), count: *count }).collect();
    list.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.host.cmp(&b.host)));
    list.truncate(limit);
    list
}

/// The account a session token belongs to: its `sub`. Read, not verified: it
/// only picks whose browser this Mac serves; the exit token itself is checked
/// against the server's key.
pub fn session_user(token: &str) -> Option<String> {
    let payload = URL_SAFE_NO_PAD.decode(token.split('.').nth(1)?.trim_end_matches('=')).ok()?;
    serde_json::from_slice::<serde_json::Value>(&payload).ok()?.get("sub")?.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// The keys a token may be signed with: the pinned ones, and with `dev` (a
/// debug build) the one the server serves, as a local server signs with its own.
pub fn trusted_keys(served: Option<[u8; 32]>, dev: bool) -> Vec<[u8; 32]> {
    let mut keys: Vec<[u8; 32]> = PINNED_KEYS.iter().filter_map(|k| public_key(k).ok()).collect();
    if dev {
        keys.extend(served.filter(|k| !keys.contains(k)));
    }
    keys
}

/// The token's claims once one of `keys` signed it ([`verify`] with each in
/// turn; any other refusal is the token's own, whichever key signed it).
pub fn verify_with(token: &str, url: &str, keys: &[[u8; 32]], now_ms: u64, loopback_ok: bool) -> Result<Claims, TicketError> {
    for key in keys {
        match verify(token, url, key, now_ms, loopback_ok) {
            Err(TicketError::BadSignature) => continue,
            other => return other,
        }
    }
    Err(TicketError::BadSignature)
}

/// The address in a Cloudflare trace (its `ip=` line).
pub fn trace_ip(body: &str) -> Option<IpAddr> {
    body.lines().find_map(|line| line.strip_prefix("ip="))?.trim().parse().ok()
}

/// The public addresses this Mac refuses as destinations: each view once.
pub fn public_ips(server: Option<IpAddr>, own: Option<IpAddr>) -> Vec<IpAddr> {
    let mut ips: Vec<IpAddr> = server.into_iter().collect();
    ips.extend(own.filter(|ip| Some(*ip) != server));
    ips
}

/// This Mac's public address as Cloudflare sees it ([`OWN_IP_URL`]), or None.
async fn own_ip() -> Option<IpAddr> {
    let client = reqwest::Client::builder().timeout(OWN_IP_TIMEOUT).redirect(reqwest::redirect::Policy::none()).build().ok()?;
    let response = client.get(OWN_IP_URL).send().await.ok()?.error_for_status().ok()?;
    trace_ip(&response.text().await.ok()?)
}

/// The account this app is signed into, from the session the main window handed over.
fn signed_in_user(app: &AppHandle) -> Option<String> {
    let token = app.state::<crate::state::AppState>().auth_token.lock().unwrap().clone()?;
    session_user(&token)
}

/// The signed-in account changed (another one, or none): the exit served the
/// one before, so it stops. A token refresh for the same account changes nothing.
pub fn on_session_change(app: &AppHandle, before: Option<&str>, after: Option<&str>) {
    let (before, after) = (before.and_then(session_user), after.and_then(session_user));
    if before.is_some() && before != after {
        if let Some(svc) = app.try_state::<BrowserExitService>() {
            log_to_file("[browser-exit] the signed-in account changed: stopping");
            svc.stop(app);
        }
    }
}

impl BrowserExitService {
    fn status(&self) -> ExitStatus {
        let inner = self.inner.lock().unwrap();
        ExitStatus {
            state: inner.state.unwrap_or(ExitState::Off),
            needs_token: inner.needs_token,
            sites_today: top_sites(&inner.sites, usize::MAX),
        }
    }

    fn publish(&self, app: &AppHandle) {
        let status = self.status();
        let tray = (status.state != ExitState::Off).then(|| crate::tray::BrowserExitTray {
            up: status.state == ExitState::Up,
            sites: top_sites(&self.inner.lock().unwrap().sites, MENU_SITES),
            total: status.sites_today.len(),
        });
        crate::tray::set_browser_exit(app, tray);
        let _ = app.emit(STATUS_EVENT, status);
    }

    fn on_event(&self, app: &AppHandle, generation: u64, event: Event) {
        let publish = {
            let mut inner = self.inner.lock().unwrap();
            // A run that was replaced (another browser, a fresh token) changes nothing any more.
            if inner.running.as_ref().map(|r| r.generation) != Some(generation) {
                return;
            }
            let today = Local::now().date_naive();
            if inner.day != Some(today) {
                inner.day = Some(today);
                inner.sites.clear();
            }
            match &event {
                Event::Connecting => { inner.state = Some(ExitState::Connecting); true }
                Event::Up { .. } => { inner.state = Some(ExitState::Up); true }
                Event::Down { .. } => { inner.state = Some(ExitState::Down); true }
                Event::Opened { host } => {
                    let count = inner.sites.entry(host.to_ascii_lowercase()).or_insert(0);
                    *count += 1;
                    // A new site shows in the menu and the card at once; more of the same don't redraw.
                    *count == 1
                }
                Event::Refused { .. } => false,
                Event::Ended { reason } => {
                    inner.state = Some(ExitState::Off);
                    inner.running = None;
                    inner.needs_token = matches!(reason, EndReason::Unauthorized | EndReason::Expired);
                    true
                }
            }
        };
        match &event {
            Event::Down { reason } => log_to_file(&format!("[browser-exit] down: {reason}")),
            Event::Ended { reason } => log_to_file(&format!("[browser-exit] ended: {reason:?}")),
            Event::Up { .. } => log_to_file("[browser-exit] up"),
            _ => {}
        }
        if publish {
            self.publish(app);
        }
    }

    /// This Mac's public address, from the app's own API origin (with the key
    /// it serves) and from Cloudflare, asked together; `fresh` skips the kept ones.
    async fn server(&self, fresh: bool) -> Result<ServerView, String> {
        if !fresh {
            if let Some(view) = self.inner.lock().unwrap().server.clone().filter(|v| v.at.elapsed() < KEY_TTL) {
                return Ok(view);
            }
        }
        #[derive(serde::Deserialize)]
        struct KeyResponse {
            key: String,
            ip: Option<String>,
        }
        let url = format!("{}/api/browser-exit/key", crate::tray::api_base_url());
        let client = reqwest::Client::builder().timeout(KEY_TIMEOUT).build().map_err(|e| e.to_string())?;
        let (response, own_ip) = tokio::join!(client.get(&url).send(), own_ip());
        let response = response.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("the server's key: {}", response.status()));
        }
        let body: KeyResponse = response.json().await.map_err(|e| e.to_string())?;
        let key = public_key(&body.key).ok();
        if !trusted_keys(None, false).iter().any(|k| Some(*k) == key) {
            let what = if cfg!(debug_assertions) { "trusted: a debug build" } else { "its tokens are refused" };
            log_to_file(&format!("[browser-exit] the server's key isn't one this build pins ({what})"));
        }
        if own_ip.is_none() {
            log_to_file("[browser-exit] Cloudflare didn't say this Mac's address: only the server's view of it is refused");
        }
        let view = ServerView { key, ip: body.ip.and_then(|ip| ip.trim().parse().ok()), own_ip, at: Instant::now() };
        self.inner.lock().unwrap().server = Some(view.clone());
        Ok(view)
    }

    pub fn stop(&self, app: &AppHandle) {
        let running = self.inner.lock().unwrap().running.take();
        if let Some(running) = running {
            let _ = running.stop.send(true);
        }
        self.inner.lock().unwrap().state = Some(ExitState::Off);
        self.publish(app);
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

async fn verified(svc: &BrowserExitService, url: &str, token: &str) -> Result<(Claims, ServerView), String> {
    let dev = cfg!(debug_assertions);
    let check = |view: &ServerView| verify_with(token, url, &trusted_keys(view.key, dev), now_ms(), dev);
    let view = svc.server(false).await?;
    match check(&view) {
        Ok(claims) => Ok((claims, view)),
        // A debug build's local server may have a new key: ask again once before refusing.
        Err(TicketError::BadSignature) if dev => {
            let view = svc.server(true).await?;
            check(&view).map(|claims| (claims, view)).map_err(|e| e.to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Start (or keep) the tunnel to the hub `url` with `token`, once the token
/// checks out and is for the account this app is signed into.
#[tauri::command]
pub async fn browser_exit_start(app: AppHandle, svc: State<'_, BrowserExitService>, url: String, token: String) -> Result<ExitStatus, String> {
    let svc = svc.inner().clone();
    let (claims, view) = verified(&svc, &url, &token).await?;
    // Without a word on this Mac's address, its own router could be reached: don't start.
    let public_ips = public_ips(view.ip, view.own_ip);
    if public_ips.is_empty() {
        return Err("neither the server nor Cloudflare said this Mac's public address".into());
    }
    if public_ips.len() > 1 {
        log_to_file("[browser-exit] the server and Cloudflare see this Mac at different addresses: both refused");
    }
    {
        let mut inner = svc.inner.lock().unwrap();
        // Someone else's browser (a page can hand over any token) never uses this Mac: refused, not asked.
        // Checked under the lock, so a sign-out landing now stops what starts here (set_auth_token stores
        // the session before it takes this lock, and never holds both).
        if signed_in_user(&app).as_deref() != Some(claims.user_id.as_str()) {
            log_to_file("[browser-exit] refused: the token is not for the account this app is signed into");
            return Err("this Mac's connection serves the signed-in account's browser only".into());
        }
        if let Some(running) = &inner.running {
            if running.sandbox == claims.sandbox && running.hub == claims.hub {
                drop(inner);
                return Ok(svc.status());
            }
            let _ = running.stop.send(true);
        }
        inner.generation += 1;
        let generation = inner.generation;
        let (stop, stop_rx) = watch::channel(false);
        inner.running = Some(Running { generation, stop, sandbox: claims.sandbox.clone(), hub: claims.hub.clone() });
        inner.needs_token = false;
        let (events, mut rx) = mpsc::unbounded_channel();
        tauri::async_runtime::spawn(run(Options::new(url, token, claims, public_ips), events, stop_rx));
        let (svc2, app2) = (svc.clone(), app.clone());
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                svc2.on_event(&app2, generation, event);
            }
        });
    }
    Ok(svc.status())
}

#[tauri::command]
pub async fn browser_exit_stop(app: AppHandle, svc: State<'_, BrowserExitService>) -> Result<ExitStatus, String> {
    svc.stop(&app);
    Ok(svc.status())
}

#[tauri::command]
pub async fn browser_exit_status(svc: State<'_, BrowserExitService>) -> Result<ExitStatus, String> {
    Ok(svc.status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_the_busiest_sites_first() {
        let sites = BTreeMap::from([("b.example".to_string(), 2), ("a.example".to_string(), 2), ("c.example".to_string(), 9)]);
        let top = top_sites(&sites, 2);
        assert_eq!(top, vec![SiteCount { host: "c.example".into(), count: 9 }, SiteCount { host: "a.example".into(), count: 2 }]);
    }

    // Two throwaway keys (their private halves were never kept) and a token
    // key B signed for HUB_URL's hub, good until a minute past NOW.
    const KEY_A: &str = "MCowBQYDK2VwAyEAAxYoc6ChXTF3IZdRelFTPfVUZztUK5LiY1/jAwRC7ak=";
    const KEY_B: &str = "MCowBQYDK2VwAyEAYdo0RqLK5+TL3Pu8JehtyuEBNdEiw6QyZaX0u6xmOe4=";
    const BY_B: &str = "eyJhdWQiOiJicm93c2VyLWV4aXQiLCJ1c2VySWQiOiJ1MSIsIndvcmtzcGFjZUlkIjoidzEiLCJzYW5kYm94IjoiYnJvd3Nlci1hIiwiaHViIjoic2ItYWJjMTIzLnZlcmNlbC5ydW4iLCJleHAiOjE4MDAwMDAwNjAwMDB9.muJwSVJtTwb0CLrDzwK3NcEDITfNNeouvSJY19uY9029KKesAISSTUNUP09ckakognc-ef04RdTGyW4XFANtCQ";
    const HUB_URL: &str = "wss://sb-abc123.vercel.run/exit";
    const NOW: u64 = 1_800_000_000_000;

    #[test]
    fn the_pinned_keys_are_ed25519_keys() {
        assert!(!PINNED_KEYS.is_empty());
        for key in PINNED_KEYS {
            assert!(public_key(key).is_ok(), "{key}");
        }
        assert_eq!(trusted_keys(None, false).len(), PINNED_KEYS.len());
    }

    #[test]
    fn a_release_build_never_trusts_the_key_the_server_serves() {
        let served = public_key(KEY_B).unwrap();
        // Release: whatever the server says, only the pinned keys.
        let release = trusted_keys(Some(served), false);
        assert!(!release.contains(&served));
        assert_eq!(verify_with(BY_B, HUB_URL, &release, NOW, false), Err(TicketError::BadSignature));
        // A debug build's local server signs with its own.
        let dev = trusted_keys(Some(served), true);
        assert!(dev.contains(&served));
        assert!(verify_with(BY_B, HUB_URL, &dev, NOW, false).is_ok());
        // A pinned key served again isn't listed twice.
        let pinned = public_key(PINNED_KEYS[0]).unwrap();
        assert_eq!(trusted_keys(Some(pinned), true).len(), PINNED_KEYS.len());
    }

    #[test]
    fn any_listed_key_signs_and_the_rest_of_the_check_still_holds() {
        let (a, b) = (public_key(KEY_A).unwrap(), public_key(KEY_B).unwrap());
        // Rotation: the old key and the new one, either order.
        assert_eq!(verify_with(BY_B, HUB_URL, &[a, b], NOW, false).unwrap().sandbox, "browser-a");
        assert!(verify_with(BY_B, HUB_URL, &[b, a], NOW, false).is_ok());
        assert_eq!(verify_with(BY_B, HUB_URL, &[a], NOW, false), Err(TicketError::BadSignature));
        assert_eq!(verify_with(BY_B, HUB_URL, &[], NOW, false), Err(TicketError::BadSignature));
        // Signed by a listed key, but for another hub, or old: refused for that.
        assert_eq!(verify_with(BY_B, "wss://sb-evil.vercel.run/exit", &[a, b], NOW, false), Err(TicketError::WrongHub));
        assert_eq!(verify_with(BY_B, HUB_URL, &[a, b], NOW + 60_000, false), Err(TicketError::Expired));
    }

    #[test]
    fn reads_this_macs_address_from_a_cloudflare_trace() {
        let trace = "fl=123\nh=1.1.1.1\nip=203.0.113.7\nts=1730000000.1\nvisit_scheme=https\nwarp=off\n";
        assert_eq!(trace_ip(trace), Some("203.0.113.7".parse().unwrap()));
        assert_eq!(trace_ip("ip=2001:db8::1\n"), Some("2001:db8::1".parse().unwrap()));
        for bad in ["", "h=1.1.1.1\n", "ip=\n", "ip=not-an-address\n", "<html>ip=1.2.3.4</html>"] {
            assert_eq!(trace_ip(bad), None, "{bad}");
        }
    }

    #[test]
    fn every_view_of_this_macs_address_is_refused_once() {
        let (server, own) = ("24.193.1.2".parse().unwrap(), "24.193.9.9".parse().unwrap());
        // A server that lies about the address only adds one: Cloudflare's is refused too.
        assert_eq!(public_ips(Some(server), Some(own)), vec![server, own]);
        assert_eq!(public_ips(Some(server), Some(server)), vec![server]);
        assert_eq!(public_ips(None, Some(own)), vec![own]);
        assert_eq!(public_ips(Some(server), None), vec![server]);
        assert!(public_ips(None, None).is_empty());
    }

    fn session(payload: &str) -> String {
        format!("eyJhbGciOiJIUzI1NiJ9.{}.sig", URL_SAFE_NO_PAD.encode(payload))
    }

    #[test]
    fn reads_the_account_a_session_belongs_to() {
        assert_eq!(session_user(&session(r#"{"sub":"user-1","role":"authenticated"}"#)).as_deref(), Some("user-1"));
        // Padded segments too (some encoders keep the =).
        let padded = format!("h.{}=.s", URL_SAFE_NO_PAD.encode(r#"{"sub":"user-22"}"#));
        assert_eq!(session_user(&padded).as_deref(), Some("user-22"));
        for bad in ["", "not-a-jwt", "a.%%%.c", &session(r#"{"role":"anon"}"#), &session(r#"{"sub":""}"#), &session("not json")] {
            assert_eq!(session_user(bad), None, "{bad}");
        }
    }
}
