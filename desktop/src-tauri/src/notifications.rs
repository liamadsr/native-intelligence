//! Native OS notifications (macOS Notification Center / Windows toast).
//!
//! The web app (dial8.ai) decides WHEN to notify — it owns the realtime
//! subscription and the focus check. This module only knows how to put a banner
//! on screen and how to route a click back to the right webview. It is
//! deliberately payload-agnostic: `title`/`body` are rendered verbatim and
//! `payload` is an opaque JSON string echoed back on click, so new notification
//! types ship as a pure web deploy with no native release.
//!
//! ## Why not `tauri-plugin-notification`
//!
//! Tauri's plugin has no click event on desktop at all — the desktop backend
//! only registers notify/request_permission/is_permission_granted, and clicking
//! a banner tells the app nothing (tauri-apps/plugins-workspace#2150, open since
//! 2022). So we drive the two platform APIs directly.
//!
//! ## Backends
//!
//! - macOS: `objc2-user-notifications` driving `UNUserNotificationCenter`. Our
//!   own `UNUserNotificationCenterDelegate` subclass (see the `macos` module)
//!   receives `didReceiveNotificationResponse` and pulls our three user-info
//!   keys back out of the notification, which is what makes a click — including
//!   a click on a notification delivered before the app restarted — routable.
//! - Windows: `tauri-winrt-notification` toasts with an `on_activated` callback.
//!
//! Both are permissively licensed (Zlib/Apache-2.0/MIT and MIT/Apache-2.0), so
//! they can be statically linked into this proprietary binary without the
//! relinking obligations an LGPL dependency would impose.
//!
//! Everything below the platform modules is shared: the dedupe ring, the click
//! buffer, and the window focus/emit logic are platform-independent, and each
//! backend only has to call `handle_click_parts`.
//!
//! ## Show policy: skip when the app is frontmost
//!
//! `show` returns `Result<bool, String>`: `Ok(true)` means a banner went up,
//! `Ok(false)` means it was deliberately SKIPPED because some non-HUD Native Intelligence
//! window is currently focused. The app being frontmost makes the in-app toast
//! the right surface — the focused window either already toasted this same
//! notification, or (cross-workspace) the sender's own toast is the status-quo
//! behaviour. A skip is emphatically NOT an `Err`: the web side treats an `Err`
//! as "this binary can't do native notifications" and permanently disables the
//! path, whereas `Ok(false)` just means "toast this one instead". Old binaries
//! returned unit, so the web side reads `undefined`/`null` as `true`.
//!
//! The dedupe ring is only stamped AFTER the focus check, so a skipped id can
//! still get a real banner if it somehow re-fires, and a platform failure
//! un-stamps the id (`unmark_shown`) so one window's failed show cannot suppress
//! a sibling window's attempt or its toast fallback.
//!
//! ## Click delivery is window-TARGETED
//!
//! Every dashboard window mounts the click handler, so a broadcast `emit` would
//! make every open window navigate. Clicks go out with
//! `emit_to(EventTarget::labeled(label), ...)` instead — see `deliver_or_buffer`
//! for why `labeled` (and not `window`/`webview_window`) is the variant that
//! provably matches the web side's listener.
//!
//! Listener registration is per JS context, so it is dropped on
//! `WindowEvent::Destroyed` (lib.rs), on `PageLoadEvent::Started` (lib.rs — a
//! hard navigation replaces the JS context with no window event at all), and on
//! the explicit `notification_click_listener_gone` command (SPA unmount). All
//! three funnel into `forget_window`.
//!
//! ## Failure policy
//!
//! Every OS-level failure degrades to an `Err` string or `"unsupported"`. It
//! must never panic: an unbundled `cargo tauri dev` binary on macOS has no
//! bundle identifier, and UNUserNotificationCenter is unusable there — asking it
//! for `currentNotificationCenter` in that state raises an NSException, which
//! would abort the process, so `init` refuses to build one (see `macos::init`).
//!
//! ## A bot's banner (bots v3, phase 7)
//!
//! `show` takes three optional extras (`BannerExtras`): a thread id, so
//! Notification Center stacks each bot's banners together; a subtitle; and the
//! bot's still as a PNG, written to the app's cache dir and attached. And
//! `remove_delivered` takes a banner back out of Notification Center once its
//! item is read. None of it changes the alert style or the interruption level:
//! the banner stays the transient kind (macOS Banners, the default, since
//! Info.plist sets no `NSUserNotificationAlertStyle`). Windows ignores the
//! extras and can't remove (its toast crate has no history API).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager};

use crate::log_to_file;

/// user-info keys on the native notification. These survive a click across an
/// app restart (macOS UNNotificationContent.userInfo), which is what lets a
/// cold-start click still recover its payload.
const USER_INFO_KEY_ID: &str = "dial8_notification_id";
const USER_INFO_KEY_PAYLOAD: &str = "dial8_payload";
/// Window label that sent the notification, so a click can go back to the same
/// workspace window the user was working in.
const USER_INFO_KEY_WINDOW: &str = "dial8_window_label";

/// Event delivered to the webview when a native notification is clicked.
/// Matches the `notification-clicked` contract: `{ id, payload }`.
#[derive(Debug, Clone, Serialize)]
pub struct NotificationClickedPayload {
    pub id: String,
    /// The opaque JSON string handed to `show_native_notification`, or `None`
    /// when it could not be recovered — the web side treats null as "just open
    /// the Inbox".
    pub payload: Option<String>,
}

/// Ids already shown, newest last. Dedupes duplicate sends from multiple
/// workspace windows all observing the same realtime INSERT. Bounded ring —
/// oldest ids fall off, which is fine: a repeat that far back is not the
/// double-send this is defending against.
static SHOWN_IDS: Mutex<Vec<String>> = Mutex::new(Vec::new());
const SHOWN_IDS_MAX: usize = 200;

/// Clicks that arrived before the target webview registered its JS listener,
/// keyed by window label. A notification click can COLD START the app (macOS
/// relaunches the app to deliver it), in which case the click is handled long
/// before dial8.ai has loaded, let alone hydrated. Same problem — and same
/// solution — as AGENT_NUDGE_BUFFER in commands/hud.rs: hold the events until
/// the page calls `notification_click_listener_ready`, then flush in order.
static CLICK_BUFFER: Mutex<Vec<(String, NotificationClickedPayload)>> = Mutex::new(Vec::new());
/// Bounded so a webview that never becomes ready can't grow this without limit.
const CLICK_BUFFER_MAX: usize = 32;

/// Window labels that have registered their `notification-clicked` listener.
static READY_WINDOWS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Whether a usable notification backend was built by `init`. When false every
/// command degrades to "unsupported" rather than erroring or panicking.
static AVAILABLE: AtomicBool = AtomicBool::new(false);

/// The app handle, stashed by `init` so a platform click callback — which the OS
/// invokes with no context of ours — can reach Tauri. macOS delivers a
/// cold-start click through the delegate before any command has run, so there is
/// no `Window` to borrow one from at that point.
static APP_HANDLE: Mutex<Option<AppHandle>> = Mutex::new(None);

/// Longest thread id kept. A teammate id is a 36-char UUID; this only stops a
/// runaway string from reaching the OS.
const THREAD_ID_MAX_CHARS: usize = 256;
/// Longest subtitle kept (Notification Center truncates far shorter anyway).
const SUBTITLE_MAX_CHARS: usize = 200;
/// Biggest image accepted, decoded. A bot's still is a few KB; anything near
/// this is not one.
const IMAGE_MAX_BYTES: usize = 1024 * 1024;
/// Every PNG starts with these eight bytes. The image must be a PNG: the file
/// is named `.png`, and UNNotificationAttachment types it by extension.
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
/// Subdirectory of the app's cache dir the banner images are written to.
const IMAGE_DIR_NAME: &str = "notification-images";
/// A banner image older than this is a leftover: once attached, the OS MOVES
/// the file into its own attachment store, so only failed or abandoned writes
/// stay behind.
const IMAGE_MAX_AGE: Duration = Duration::from_secs(60 * 60);
/// At most this many banner images are kept in the dir at once.
const IMAGE_MAX_FILES: usize = 64;

/// What makes a bot's banner look like the bot. Every field is optional, and
/// an empty one is simply not set: an old page sends none of them.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct BannerExtras {
    /// Notification Center groups banners sharing it (macOS `threadIdentifier`).
    pub thread_id: Option<String>,
    /// A line between the title and the body.
    pub subtitle: Option<String>,
    /// PNG bytes, already checked to be a PNG of a sane size.
    pub image_png: Option<Vec<u8>>,
}

impl BannerExtras {
    /// From the command's raw args: blanks dropped, long strings cut, and an
    /// image that isn't a decodable PNG dropped (the banner goes up without
    /// it: an image never fails a banner).
    pub fn from_args(thread_id: Option<String>, subtitle: Option<String>, image: Option<&str>) -> Self {
        Self {
            thread_id: clean_text(thread_id, THREAD_ID_MAX_CHARS),
            subtitle: clean_text(subtitle, SUBTITLE_MAX_CHARS),
            image_png: image.and_then(decode_png_image),
        }
    }
}

/// Trimmed and cut to `max_chars`, or None when blank.
fn clean_text(value: Option<String>, max_chars: usize) -> Option<String> {
    let value = value?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(max_chars).collect())
}

/// PNG bytes from a `data:image/png;base64,...` URL or bare base64. None when
/// it isn't base64, isn't a PNG, is some other data URL type, or is bigger
/// than `IMAGE_MAX_BYTES`.
fn decode_png_image(input: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;

    let input = input.trim();
    let encoded = match input.strip_prefix("data:") {
        Some(rest) => {
            let (meta, data) = rest.split_once(',')?;
            if !meta.trim().eq_ignore_ascii_case("image/png;base64") {
                return None;
            }
            data
        }
        None => input,
    };
    // Refuse before decoding anything that would decode past the cap.
    if encoded.len() > IMAGE_MAX_BYTES / 3 * 4 + 4 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    if bytes.len() > IMAGE_MAX_BYTES || !bytes.starts_with(&PNG_SIGNATURE) {
        return None;
    }
    Some(bytes)
}

/// Where banner images are written: `<app cache dir>/notification-images`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn image_dir() -> Option<PathBuf> {
    let app = app_handle()?;
    app.path()
        .app_cache_dir()
        .ok()
        .map(|dir| dir.join(IMAGE_DIR_NAME))
}

/// A file name for notification `id`'s image: the id's safe characters only
/// (it's a UUID, but it came from the web), plus the time, so two writes never
/// collide.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn image_file_name(id: &str, now: SystemTime) -> String {
    let safe: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(80)
        .collect();
    let stamp = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let safe = if safe.is_empty() { "banner".to_string() } else { safe };
    format!("{}-{}.png", safe, stamp)
}

/// Write `bytes` as notification `id`'s image in `dir`, pruning old ones first.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn write_image_file(dir: &Path, id: &str, bytes: &[u8], now: SystemTime) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    // Room for the one about to be written.
    prune_image_dir(dir, now, IMAGE_MAX_AGE, IMAGE_MAX_FILES.saturating_sub(1));
    let path = dir.join(image_file_name(id, now));
    std::fs::write(&path, bytes)?;
    Ok(path)
}

/// Delete the `.png` files in `dir` older than `max_age`, then the oldest of
/// the rest until at most `keep` remain. Only `.png` files, only in `dir`:
/// it's our own folder, but nothing else in it is ours to delete. Returns how
/// many were deleted. Errors are skipped: cleanup never fails a banner.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn prune_image_dir(dir: &Path, now: SystemTime, max_age: Duration, keep: usize) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut files: Vec<(SystemTime, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            let is_png = path
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("png"))
                .unwrap_or(false);
            let meta = entry.metadata().ok()?;
            if !is_png || !meta.is_file() {
                return None;
            }
            Some((meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), path))
        })
        .collect();

    let mut removed = 0;
    files.retain(|(modified, path)| {
        let age = now.duration_since(*modified).unwrap_or(Duration::ZERO);
        if age > max_age {
            if std::fs::remove_file(path).is_ok() {
                removed += 1;
            }
            false
        } else {
            true
        }
    });

    if files.len() > keep {
        files.sort_by_key(|(modified, _)| *modified);
        let excess = files.len() - keep;
        for (_, path) in files.into_iter().take(excess) {
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/// Windows: the AUMID toasts are attributed to. The NSIS installer already
/// stamps this exact id onto the Start Menu / Desktop shortcuts, so toasts from
/// an INSTALLED build resolve to the real Native Intelligence identity. An unbundled
/// `cargo run` has no such shortcut, so Windows refuses the toast — `show` maps
/// that to an `Err`, and the web side falls back to an in-app toast.
#[cfg(target_os = "windows")]
const APP_ID: &str = "ai.dial8.desktop";

/// Build the platform notification backend and register the click handler.
/// Call ONCE from `.setup()` — that runs on the main thread, which macOS
/// requires for setting the UNUserNotificationCenter delegate.
///
/// Never panics: on macOS without a bundle id (a plain `cargo tauri dev`
/// binary) the backend is simply left unavailable, so the commands below degrade
/// to "unsupported" instead of taking the app down.
pub fn init(app: &AppHandle) {
    match APP_HANDLE.lock() {
        Ok(mut guard) => *guard = Some(app.clone()),
        Err(e) => {
            log_to_file(&format!("[notify] app handle lock poisoned during init: {}", e));
            return;
        }
    }

    #[cfg(target_os = "macos")]
    let ok = macos::init();

    // Windows toasts need no process-wide setup: the AUMID and the Activated
    // callback are both attached per-toast at show time, so the backend is
    // available as soon as the app handle is stashed. Other platforms have no
    // backend at all and stay "unsupported".
    #[cfg(target_os = "windows")]
    let ok = true;

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let ok = false;

    AVAILABLE.store(ok, Ordering::SeqCst);
    log_to_file(&format!("[notify] init — backend available: {}", ok));
}

/// Clone the app handle stashed by `init`.
fn app_handle() -> Option<AppHandle> {
    APP_HANDLE.lock().ok().and_then(|guard| guard.clone())
}

/// Record `id` as shown. Returns false when it was already there (a duplicate
/// send from another window), in which case the caller must not show anything.
fn mark_shown(id: &str) -> bool {
    let Ok(mut seen) = SHOWN_IDS.lock() else {
        // Poisoned lock: prefer showing a possible duplicate over dropping a
        // real notification.
        return true;
    };
    if seen.iter().any(|existing| existing == id) {
        return false;
    }
    if seen.len() >= SHOWN_IDS_MAX {
        seen.remove(0);
    }
    seen.push(id.to_string());
    true
}

/// Undo a `mark_shown` after the platform show FAILED.
///
/// Without this a failed banner still poisons the ring, so a sibling workspace
/// window observing the same realtime INSERT would be told "already shown" and
/// skip both the banner AND (because that path returns `Ok`) its toast fallback
/// — the notification would vanish entirely.
fn unmark_shown(id: &str) {
    if let Ok(mut seen) = SHOWN_IDS.lock() {
        seen.retain(|existing| existing != id);
    }
}

/// Labels that are floating overlays, not the app itself. Their focus does not
/// mean the user is looking at Native Intelligence's content, so it must not suppress a
/// banner.
///
/// The set has ONE owner (`crate::HUD_LABELS`); this is a re-export so the
/// classification can never drift between subsystems.
use crate::is_hud_label;

/// Whether any non-HUD Native Intelligence webview window currently has OS focus.
///
/// This is the native-side half of the "don't banner while the app is
/// frontmost" policy. The web side already refuses to call `show` when ITS OWN
/// document has focus, but that check is per-window: a second workspace window
/// observing the same realtime INSERT would happily banner while the user is
/// staring at the first one. Asking Tauri which of our windows is focused
/// closes that gap for the whole process.
fn any_app_window_focused(app: &AppHandle) -> bool {
    app.webview_windows()
        .iter()
        .any(|(label, window)| !is_hud_label(label) && window.is_focused().unwrap_or(false))
}

/// Show a native notification. `payload` is stored in the OS notification's
/// user-info so a click — even one that cold-starts the app — can recover it.
///
/// `window_label` is the webview that asked for this, so the click can go back
/// to that same window rather than always jumping to "main".
///
/// title/body are rendered verbatim — never parsed or templated, so the server
/// stays the single author of notification copy. `extras` (thread id, subtitle,
/// image) only dress the banner; none of them can make it fail.
///
/// Returns `Ok(true)` when a banner was shown, `Ok(false)` when it was
/// deliberately skipped because the app is frontmost (see the module docs) —
/// the caller should fall back to an in-app toast for `false`, and must NOT
/// treat it as a failure.
pub async fn show(
    window_label: &str,
    id: &str,
    title: &str,
    body: Option<&str>,
    payload: Option<&str>,
    extras: BannerExtras,
) -> Result<bool, String> {
    if !AVAILABLE.load(Ordering::SeqCst) {
        return Err("unsupported".to_string());
    }

    // ORDER MATTERS: focus check BEFORE mark_shown. Stamping the ring on a skip
    // would mean a later, genuine re-fire of the same id (the app now in the
    // background) is silently swallowed, and it would also let one window's
    // skip suppress a sibling window's banner. A skip must leave no trace.
    if let Some(app) = app_handle() {
        if any_app_window_focused(&app) {
            return Ok(false);
        }
    }

    // Dedupe BEFORE showing: several workspace windows can each observe the
    // same realtime INSERT and independently ask for the same notification.
    if !mark_shown(id) {
        return Ok(true);
    }

    #[cfg(target_os = "macos")]
    let result = show_with_image_fallback(id, extras, |extras| async move {
        macos::show(window_label, id, title, body, payload, &extras).await
    })
    .await;

    // The toast crate has no thread grouping or history, and the extras are
    // dress only, so Windows shows the banner it always has.
    #[cfg(target_os = "windows")]
    let result = {
        let _ = &extras;
        windows_impl::show(window_label, id, title, body, payload).await
    };

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result: Result<(), String> = {
        let _ = (window_label, title, body, payload, &extras);
        Err("unsupported".to_string())
    };

    match result {
        Ok(()) => Ok(true),
        Err(e) => {
            // Un-poison the ring so a sibling window's attempt (or its toast
            // fallback) isn't wrongly suppressed by our failure.
            unmark_shown(id);
            Err(e)
        }
    }
}

/// Show with `extras`, and when that fails while they carry an image, once
/// more without it: an image never fails a banner. The OS checks an attached
/// file again when the request is added (a corrupt PNG, or a file it can't move
/// into its store, e.g. a full disk), and that refusal arrives as the request's
/// error, after `image_attachment` already said yes. Failing the banner there
/// would turn native banners off on the web side for the session. A file left
/// behind by the refused try is swept by the next prune.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
async fn show_with_image_fallback<F, Fut>(id: &str, extras: BannerExtras, mut attempt: F) -> Result<(), String>
where
    F: FnMut(BannerExtras) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let had_image = extras.image_png.is_some();
    let without_image = BannerExtras { image_png: None, ..extras.clone() };
    match attempt(extras).await {
        Err(e) if had_image => {
            log_to_file(&format!("[notify] banner with image failed for {}: {}; retrying without it", id, e));
            attempt(without_image).await
        }
        other => other,
    }
}

/// The ids of [`show_native`]'s banners start with this, and the web's may
/// not (`commands::notifications::show_native_notification` refuses them): a
/// page can't pass its banner off as Rust's, or replace one of Rust's.
pub const NATIVE_ID_PREFIX: &str = "local-agent-";

/// Whether the web may use `id` for a banner: never one of Rust's
/// ([`NATIVE_ID_PREFIX`], in any case).
pub fn web_may_use_id(id: &str) -> bool {
    !id.get(..NATIVE_ID_PREFIX.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(NATIVE_ID_PREFIX))
}

/// A banner whose words are Rust's own, never the web's: the local agent's
/// notices (a job a cloud agent or a loop started on this Mac, the hour's
/// launches used up; `crate::local_agent`'s `starts`). Unlike [`show`] it
/// isn't skipped while a Native Intelligence window is focused (the page in front runs code
/// the server sends, so its own toast can't be the only word), it isn't
/// deduped (each `id` is new), and it carries no payload: a click opens the
/// home thread, where a loop's job reports.
///
/// It shows even while Native Intelligence is frontmost, when the delegate's `will_present`
/// keeps every other banner off screen, provided `id` starts `local-agent-`
/// ([`shows_over_the_app`]). `Err` when this build has no backend (an unbundled
/// dev binary) or the OS refused it.
/// Whether a banner shows while Native Intelligence is frontmost: only [`show_native`]'s
/// local-agent ones (see the delegate's `will_present`).
fn shows_over_the_app(id: &str) -> bool {
    id.starts_with("local-agent-")
}

pub async fn show_native(id: &str, title: &str, body: &str) -> Result<(), String> {
    if !AVAILABLE.load(Ordering::SeqCst) {
        return Err("unsupported".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        macos::show("main", id, title, Some(body), None, &BannerExtras::default()).await
    }

    #[cfg(target_os = "windows")]
    {
        windows_impl::show("main", id, title, Some(body), None).await
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (id, title, body);
        Err("unsupported".to_string())
    }
}

/// Take notification row `id`'s delivered banner out of Notification Center
/// (its item was opened, or the notice read elsewhere).
///
/// `Ok(true)` when the OS was asked (removing one that isn't there is a no-op),
/// `Ok(false)` when there is no backend or the platform can't (Windows). Never
/// `Err` for either: the web side must never treat a failed remove as "native
/// notifications don't work".
pub fn remove_delivered(id: &str) -> Result<bool, String> {
    if !AVAILABLE.load(Ordering::SeqCst) {
        return Ok(false);
    }
    let id = id.trim();
    if id.is_empty() {
        return Ok(false);
    }

    #[cfg(target_os = "macos")]
    {
        Ok(macos::remove_delivered(id))
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

/// Current OS permission state as one of the four contract strings.
///
/// macOS reports the real UNUserNotificationCenter authorization status, so
/// "denied" and "prompt" are genuinely distinguished (NotDetermined → "prompt",
/// Denied → "denied", Authorized/Provisional → "granted"). Windows has no
/// consent prompt for desktop toasts, so this returns "granted". When no backend
/// was built this is "unsupported", NOT an error — an unbundled dev build is an
/// expected environment, not a failure.
pub async fn permission_state() -> Result<String, String> {
    if !AVAILABLE.load(Ordering::SeqCst) {
        return Ok("unsupported".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        Ok(macos::permission_state().await)
    }

    #[cfg(target_os = "windows")]
    {
        Ok("granted".to_string())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok("unsupported".to_string())
    }
}

/// Trigger the OS permission prompt and report the resulting state. On macOS
/// the system only actually prompts the first time; later calls just return the
/// standing answer.
pub async fn request_permission() -> Result<String, String> {
    if !AVAILABLE.load(Ordering::SeqCst) {
        return Ok("unsupported".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        Ok(macos::request_permission().await)
    }

    #[cfg(target_os = "windows")]
    {
        Ok("granted".to_string())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok("unsupported".to_string())
    }
}

/// Handle a click on a native notification, given the three user-info values the
/// platform backend recovered. Shared by both backends: everything from here on
/// is window plumbing, not OS API.
///
/// A dismiss must never reach this — the backends filter those out, since
/// swiping a banner away is the user explicitly declining and must not steal
/// focus.
fn handle_click_parts(id: String, payload: Option<String>, origin_label: Option<String>) {
    log_to_file(&format!(
        "[notify] clicked id={} (payload {})",
        id,
        if payload.is_some() { "present" } else { "missing" }
    ));

    let Some(app) = app_handle() else {
        log_to_file("[notify] click ignored — no app handle");
        return;
    };

    // Bring the app forward first so the window is visible by the time the web
    // side navigates.
    let target = focus_target_window(&app, origin_label.as_deref());

    // Even with no recoverable payload we still focus and emit — the contract
    // says a payload-less click means "open the Inbox", which is strictly
    // better than a click that appears to do nothing.
    let event = NotificationClickedPayload { id, payload };

    let Some(target) = target else {
        // No window at all to deliver to (all closed). Buffer against "main",
        // which is the label a relaunched window will use.
        buffer_click("main", event);
        return;
    };

    deliver_or_buffer(&app, &target, event);
}

/// Pick the window a click should land in, bring it forward, and return its
/// label. Preference order: the window that sent the notification, then "main",
/// then any non-HUD window. `None` when no app window exists at all.
///
/// SELF-CONTAINED on purpose. The obvious alternative — delegating to
/// `tray::focus_main_window` — is wrong here in two ways: it returns a bare
/// bool, so the caller has to GUESS which window it picked (and then emit the
/// click at a window that may not be the focused one), and its first branch
/// only calls `show()` on an already-focused window without unminimizing it.
/// Click delivery has to know the exact label it focused, because that label is
/// also the emit target and the buffer key.
fn focus_target_window(app: &AppHandle, origin_label: Option<&str>) -> Option<String> {
    // unminimize → show → set_focus, all three in that order: set_focus alone
    // is unreliable on a hidden or minimized window.
    fn bring_forward(window: &tauri::WebviewWindow) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }

    // The originating window, when it's still around — a click on a
    // notification from a workspace popout should return to that popout.
    if let Some(label) = origin_label {
        if let Some(window) = app.get_webview_window(label) {
            bring_forward(&window);
            return Some(label.to_string());
        }
    }

    // "main" is the ordinary dashboard window and the overwhelmingly common
    // answer.
    if let Some(window) = app.get_webview_window("main") {
        bring_forward(&window);
        return Some("main".to_string());
    }

    // Last resort: any remaining app window — a workspace popout when "main"
    // has been closed. Never a HUD: those are floating overlays with no router,
    // so a click routed there would go nowhere.
    let (label, window) = app
        .webview_windows()
        .into_iter()
        .find(|(label, _)| !is_hud_label(label))?;
    bring_forward(&window);
    Some(label)
}

/// The event target a `notification-clicked` emit must use.
///
/// MUST BE `AnyLabel` (`EventTarget::labeled`), and the pairing is verified
/// against the vendored tauri 2.10.3 source:
///
/// - The web side listens with `getCurrentWebviewWindow().listen(...)`, which
///   registers the target `{ kind: 'WebviewWindow', label }`
///   (`@tauri-apps/api/webviewWindow.js` ~:130) — i.e. Rust
///   `EventTarget::WebviewWindow { label }`.
/// - `Manager::emit_to` matches emitter target against listener target with
///   `filter_target` (tauri-2.10.3 `src/manager/mod.rs` ~:601). Its `AnyLabel`
///   arm accepts candidates of kind `Window | Webview | WebviewWindow |
///   AnyLabel` with an equal label, so `labeled(l)` DOES reach a
///   `WebviewWindow { label: l }` listener. Its `Window` arm accepts only
///   `AnyLabel | Window`, so `EventTarget::window(l)` would NOT — it would be a
///   silent no-op against the web listener.
/// - `EventTarget::webview_window(l)` would also match, but `labeled` is
///   strictly wider (it additionally covers a plain `listen` registered against
///   a label) at no cost in cross-window leakage: the label comparison is exact
///   and a global `listen` (target `Any`) is short-circuited by
///   `match_any_or_filter` regardless of which labeled variant we pick
///   (`src/event/listener.rs` ~:306), so the web side must use the
///   window-targeted listener either way.
///
/// A plain `window.emit(...)` is what this replaces: `Emitter::emit` broadcasts
/// to EVERY window (`src/lib.rs` ~:952), and since every dashboard window mounts
/// the click handler that made all of them navigate on one click.
fn click_event_target(label: &str) -> EventTarget {
    EventTarget::labeled(label)
}

/// Emit the click to `label` if its listener is up, otherwise buffer it.
///
/// The READY_WINDOWS lock is held across the emit so this can't interleave with
/// `mark_listener_ready`. Without that, a click could observe "not ready",
/// then have the flush run before it pushed to the buffer, leaving the event
/// stranded until some later ready call.
fn deliver_or_buffer(app: &AppHandle, label: &str, event: NotificationClickedPayload) {
    if let Ok(ready) = READY_WINDOWS.lock() {
        if ready.iter().any(|l| l == label) {
            if let Some(window) = app.get_webview_window(label) {
                if window
                    .emit_to(click_event_target(label), "notification-clicked", &event)
                    .is_ok()
                {
                    return;
                }
            }
        }
        // Buffer while still holding the ready lock, so a concurrent
        // mark_listener_ready either sees us in the buffer or hasn't flushed yet.
        buffer_click(label, event);
        return;
    }

    buffer_click(label, event);
}

/// Hold a click until the target window's listener registers.
fn buffer_click(label: &str, event: NotificationClickedPayload) {
    let Ok(mut buffer) = CLICK_BUFFER.lock() else {
        return;
    };
    if buffer.len() >= CLICK_BUFFER_MAX {
        buffer.remove(0); // drop oldest
    }
    buffer.push((label.to_string(), event));
}

/// Mark `label`'s listener as live and flush anything buffered for it, in
/// arrival order. Idempotent — the page may call it again after a reload.
pub fn mark_listener_ready(app: &AppHandle, label: &str) {
    // Mark ready and drain in one critical section, holding READY_WINDOWS for
    // both. deliver_or_buffer takes the same two locks in the same order
    // (READY_WINDOWS then CLICK_BUFFER), so this can't deadlock and a click
    // racing this call is either emitted directly or found in the drain below.
    let pending: Vec<NotificationClickedPayload> = {
        let Ok(mut ready) = READY_WINDOWS.lock() else {
            return;
        };
        if !ready.iter().any(|l| l == label) {
            ready.push(label.to_string());
        }

        match CLICK_BUFFER.lock() {
            Ok(mut buffer) => {
                let mut mine = Vec::new();
                buffer.retain(|(buffered_label, event)| {
                    if buffered_label == label {
                        mine.push(event.clone());
                        false
                    } else {
                        true
                    }
                });
                mine
            }
            Err(_) => return,
        }
    };

    if pending.is_empty() {
        return;
    }

    if let Some(window) = app.get_webview_window(label) {
        // Same window-targeted delivery as deliver_or_buffer — see
        // `click_event_target` for why `labeled` is the matching variant. A
        // broadcast here would be just as wrong: the flush usually runs at
        // startup, when several windows are mounting their handlers at once.
        let target = click_event_target(label);
        for event in pending {
            let _ = window.emit_to(target.clone(), "notification-clicked", &event);
        }
    }
}

/// Forget `label`'s listener registration. Called from THREE places, because a
/// JS listener can die three different ways:
///
/// 1. `WindowEvent::Destroyed` (lib.rs) — a window that is closed and later
///    RECREATED with the same label would otherwise inherit the old one's
///    "ready" flag.
/// 2. `PageLoadEvent::Started` (lib.rs) — a hard navigation, e.g. the click
///    handler's own `window.location.assign('/account/agent-runs/<id>')`,
///    replaces the JS context without any window event at all.
/// 3. The `notification_click_listener_gone` command — the SPA-unmount case,
///    where the page survives but the React effect's cleanup ran.
///
/// The failure this prevents is silent: `deliver_or_buffer` sees "ready", emits
/// into a page with no listener, and the emit SUCCEEDS at the Tauri level — so
/// the click is dropped instead of being buffered and flushed on the next
/// `notification_click_listener_ready`.
pub fn forget_window(label: &str) {
    if let Ok(mut ready) = READY_WINDOWS.lock() {
        ready.retain(|l| l != label);
    }
}

// ---------------------------------------------------------------------------
// macOS backend — UNUserNotificationCenter via objc2
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod macos {
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, ProtocolObject};
    use objc2::{ClassType, MainThreadOnly, define_class, msg_send};
    use objc2_foundation::{
        NSArray, NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString, NSURL,
    };
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
        UNNotificationAttachment, UNNotificationDefaultActionIdentifier,
        UNNotificationDismissActionIdentifier,
        UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
        UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
    };

    use super::{
        BannerExtras, USER_INFO_KEY_ID, USER_INFO_KEY_PAYLOAD, USER_INFO_KEY_WINDOW,
        handle_click_parts, image_dir, write_image_file,
    };
    use crate::log_to_file;

    /// Whether the delegate has been installed. The delegate object itself is
    /// deliberately LEAKED rather than stored in a static: it is a
    /// `MainThreadOnly` class, so `Retained<NiNotificationDelegate>` is
    /// neither `Send` nor `Sync` and cannot live in a static at all. It must
    /// outlive every notification the process shows anyway —
    /// UNUserNotificationCenter holds its delegate WEAKLY, so dropping our
    /// Retained would silently stop click delivery — which makes a one-time
    /// intentional leak exactly the right lifetime. This flag keeps that leak
    /// strictly once-only.
    static DELEGATE_INSTALLED: AtomicBool = AtomicBool::new(false);

    define_class!(
        // Plain NSObject subclass: the only state it needs lives in module
        // statics, so it carries no ivars.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "NiNotificationDelegate"]
        struct NiNotificationDelegate;

        unsafe impl NSObjectProtocol for NiNotificationDelegate {}

        unsafe impl UNUserNotificationCenterDelegate for NiNotificationDelegate {
            /// A click (or dismiss) on one of our notifications. This is also the
            /// COLD-START path: macOS relaunches the app to deliver a click on a
            /// notification from a previous session, and the OS calls this before
            /// the webview exists — hence the click buffer on the other side.
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive_response(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion_handler: &block2::DynBlock<dyn Fn()>,
            ) {
                // Tell the OS we're done FIRST and unconditionally. If this block
                // is never called, macOS eventually kills the app for being
                // unresponsive, so it must not be gated on any of our own logic
                // succeeding.
                completion_handler.call(());

                let action = response.actionIdentifier();
                // SAFETY: these are framework string constants (already
                // `&'static NSString`), immutable and valid for the process
                // lifetime; reading them is the only access we make.
                let (default_action, dismiss_action) = unsafe {
                    (
                        UNNotificationDefaultActionIdentifier,
                        UNNotificationDismissActionIdentifier,
                    )
                };

                if &*action == dismiss_action {
                    // Swiping a banner away is the user explicitly declining —
                    // never steal focus for it.
                    return;
                }
                if &*action != default_action {
                    // No action buttons are registered in v1, so this is
                    // unreachable today; ignore rather than guess at a route.
                    log_to_file(&format!("[notify] ignoring unknown action: {}", action));
                    return;
                }

                let content = response.notification().request().content();
                let user_info = content.userInfo();

                let id = dict_string(&user_info, USER_INFO_KEY_ID)
                    // Fall back to the request identifier, which we set to the
                    // Native Intelligence row id in `show` anyway.
                    .unwrap_or_else(|| response.notification().request().identifier().to_string());
                let payload = dict_string(&user_info, USER_INFO_KEY_PAYLOAD);
                let origin_label = dict_string(&user_info, USER_INFO_KEY_WINDOW);

                handle_click_parts(id, payload, origin_label);
            }

            /// Called when a notification would arrive while Native Intelligence is FRONTMOST.
            /// Return EMPTY presentation options: no banner, no sound.
            ///
            /// This is the BACKSTOP for the skip-when-focused policy in
            /// `super::show`. That check runs at show time; the OS delivers a
            /// moment later, and the user can cmd-tab back to Native Intelligence in between.
            /// Without this the banner would land on top of the app the user is
            /// already looking at — where the in-app toast is the right surface.
            /// (An empty options set is also the macOS DEFAULT behaviour, so
            /// this delegate method exists purely to make that explicit and
            /// prevent a future edit from re-enabling the banner by accident.)
            ///
            /// The one exception: `super::show_native`'s local-agent banners
            /// (`local-agent-…` ids) show even over Native Intelligence, because the page in
            /// front runs code the server sends and can't be their only word
            /// (security review 2026-10-31).
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                notification: &UNNotification,
                completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                let id = notification.request().identifier().to_string();
                let options = if super::shows_over_the_app(&id) {
                    UNNotificationPresentationOptions::Banner
                        | UNNotificationPresentationOptions::List
                        | UNNotificationPresentationOptions::Sound
                } else {
                    UNNotificationPresentationOptions::empty()
                };
                completion_handler.call((options,));
            }
        }
    );

    /// Read a string value out of a notification's userInfo dictionary.
    /// Returns None when the key is absent or its value isn't an NSString.
    fn dict_string(dict: &NSDictionary, key: &str) -> Option<String> {
        let key = NSString::from_str(key);
        // SAFETY: userInfo is a plain (id -> id) dictionary; objectForKey on the
        // untyped NSDictionary hands back an AnyObject we must class-check
        // before treating it as a string, which is exactly what the
        // isKindOfClass check below does.
        let value: Option<Retained<AnyObject>> = unsafe { msg_send![dict, objectForKey: &*key] };
        let value = value?;
        let is_string: Bool =
            unsafe { msg_send![&*value, isKindOfClass: NSString::class()] };
        if !is_string.as_bool() {
            return None;
        }
        // SAFETY: just verified the object is an NSString.
        let value: &NSString = unsafe { &*(Retained::as_ptr(&value) as *const NSString) };
        Some(value.to_string())
    }

    /// True when this process has a bundle identifier.
    ///
    /// THIS GUARD IS LOad-BEARING: `UNUserNotificationCenter.currentNotificationCenter`
    /// raises an NSException ("bundleProxyForCurrentProcess is nil") in a binary
    /// with no bundle id — i.e. a plain `cargo tauri dev` run — and an
    /// Objective-C exception crossing back into Rust aborts the process. Every
    /// entry point below checks this before touching the center.
    fn has_bundle_id() -> bool {
        NSBundle::mainBundle().bundleIdentifier().is_some()
    }

    /// Grab the notification center, or None when this build can't have one.
    fn center() -> Option<Retained<UNUserNotificationCenter>> {
        if !has_bundle_id() {
            return None;
        }
        Some(UNUserNotificationCenter::currentNotificationCenter())
    }

    /// Install the delegate. Must run on the main thread (the caller in
    /// `lib.rs` setup already guarantees that; we assert it via MainThreadMarker
    /// rather than trusting it). Returns whether notifications are usable.
    pub fn init() -> bool {
        // MainThreadMarker::new() returns None off the main thread, which lets
        // us refuse instead of aborting the way an .expect() would.
        let Some(mtm) = objc2_foundation::MainThreadMarker::new() else {
            log_to_file("[notify] init skipped — not on the main thread");
            return false;
        };

        let Some(center) = center() else {
            log_to_file(
                "[notify] no bundle identifier — notifications unavailable (unbundled dev build)",
            );
            return false;
        };

        // Register the delegate BEFORE anything can be shown, so a click on a
        // notification left over from a previous session is still delivered.
        if DELEGATE_INSTALLED
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            let delegate: Retained<NiNotificationDelegate> = {
                let this = NiNotificationDelegate::alloc(mtm);
                unsafe { msg_send![this, init] }
            };
            // Leak it: the center only holds a weak reference, so this Retained
            // is the sole owner and must never be dropped (see DELEGATE_INSTALLED).
            // into_raw gives up ownership without releasing; we never reclaim it.
            let delegate: &'static NiNotificationDelegate =
                // SAFETY: into_raw returns the +1-retained pointer we just
                // created and never release, so it stays valid for the process
                // lifetime — which is exactly the 'static we claim here.
                unsafe { &*Retained::into_raw(delegate) };
            center.setDelegate(Some(ProtocolObject::from_ref(delegate)));
            log_to_file("[notify] delegate registered");
        }

        true
    }

    pub async fn show(
        window_label: &str,
        id: &str,
        title: &str,
        body: Option<&str>,
        payload: Option<&str>,
        extras: &BannerExtras,
    ) -> Result<(), String> {
        // All the Objective-C objects below (Retained<...>, RcBlock) are neither
        // Send nor Sync, so they must be created AND dropped inside this scope:
        // holding any of them across the `.await` would make this future non-Send
        // and Tauri's async command handler requires Send. Only the plain
        // std::sync::mpsc Receiver escapes.
        let rx = {
            let Some(center) = center() else {
                return Err("unsupported".to_string());
            };

            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(title));
            if let Some(body) = body {
                content.setBody(&NSString::from_str(body));
            }
            content.setSound(Some(&UNNotificationSound::defaultSound()));

            // A bot's banner (phase 7). Dress only: the alert style and the
            // interruption level are left exactly as they were, so the banner
            // stays transient.
            if let Some(thread_id) = extras.thread_id.as_deref() {
                content.setThreadIdentifier(&NSString::from_str(thread_id));
            }
            if let Some(subtitle) = extras.subtitle.as_deref() {
                content.setSubtitle(&NSString::from_str(subtitle));
            }
            if let Some(bytes) = extras.image_png.as_deref() {
                if let Some(attachment) = image_attachment(id, bytes) {
                    content.setAttachments(&NSArray::from_retained_slice(&[attachment]));
                }
            }

            // The three keys a click needs to route itself. They live in the OS
            // notification, so they survive an app restart.
            let mut keys: Vec<Retained<NSString>> = vec![
                NSString::from_str(USER_INFO_KEY_ID),
                NSString::from_str(USER_INFO_KEY_WINDOW),
            ];
            let mut values: Vec<Retained<NSString>> =
                vec![NSString::from_str(id), NSString::from_str(window_label)];
            if let Some(payload) = payload {
                keys.push(NSString::from_str(USER_INFO_KEY_PAYLOAD));
                values.push(NSString::from_str(payload));
            }
            let key_refs: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
            let value_refs: Vec<&NSString> = values.iter().map(|v| &**v).collect();
            let user_info = NSDictionary::from_slices(&key_refs, &value_refs);
            // setUserInfo takes the untyped NSDictionary<AnyObject, AnyObject>.
            // The generic parameters are phantom — every NSDictionary is the
            // same Objective-C class — so erasing them is a pure type-level
            // cast with no representation change.
            // SAFETY: the dictionary is NSString -> NSString, which is a valid
            // userInfo payload (property-list types only), and the cast only
            // widens the key/value types to AnyObject.
            unsafe {
                let erased = &*(Retained::as_ptr(&user_info) as *const NSDictionary);
                content.setUserInfo(erased);
            };

            // Identify the request by the Native Intelligence row id: showing the same id twice
            // then REPLACES the banner rather than stacking a duplicate, which
            // matches the dedupe intent one layer up.
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSString::from_str(id),
                &content,
                // No trigger = deliver immediately.
                None,
            );

            // Bridge the completion block back to async. The block fires on an
            // arbitrary OS queue, so a std channel + blocking recv on a worker
            // thread is the safe pairing — never block the main thread here.
            let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
            let completion = RcBlock::new(move |error: *mut NSError| {
                let message = if error.is_null() {
                    None
                } else {
                    // SAFETY: non-null NSError owned by the caller for the
                    // duration of this block.
                    Some(unsafe { &*error }.localizedDescription().to_string())
                };
                let _ = tx.send(message);
            });
            // addNotificationRequest COPIES the block, so letting our RcBlock
            // drop at the end of this scope is safe.
            center.addNotificationRequest_withCompletionHandler(&request, Some(&completion));
            rx
        };

        match tokio::task::spawn_blocking(move || rx.recv()).await {
            Ok(Ok(None)) => Ok(()),
            Ok(Ok(Some(message))) => {
                log_to_file(&format!("[notify] send failed for {}: {}", id, message));
                Err(message)
            }
            // Sender dropped without firing, or the join failed. Neither should
            // happen; report rather than hang.
            Ok(Err(_)) | Err(_) => {
                log_to_file(&format!("[notify] send completion lost for {}", id));
                Err("notification completion handler did not run".to_string())
            }
        }
    }

    /// The bot's still as a banner attachment: written to a file in the cache
    /// dir (UNNotificationAttachment only takes a local file URL, and on
    /// success the OS moves the file into its own store). None, and the file
    /// removed, when anything fails: the banner then goes up without it.
    fn image_attachment(id: &str, bytes: &[u8]) -> Option<Retained<UNNotificationAttachment>> {
        let dir = image_dir()?;
        let path = match write_image_file(&dir, id, bytes, std::time::SystemTime::now()) {
            Ok(path) => path,
            Err(e) => {
                log_to_file(&format!("[notify] image write failed for {}: {}", id, e));
                return None;
            }
        };
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        // SAFETY: no options dictionary is passed, so there is no generic to
        // get wrong; the URL is a file URL we just wrote.
        let attachment = unsafe {
            UNNotificationAttachment::attachmentWithIdentifier_URL_options_error(
                &NSString::from_str("bot"),
                &url,
                None,
            )
        };
        match attachment {
            Ok(attachment) => Some(attachment),
            Err(error) => {
                log_to_file(&format!(
                    "[notify] image attachment refused for {}: {}",
                    id,
                    error.localizedDescription()
                ));
                let _ = std::fs::remove_file(&path);
                None
            }
        }
    }

    /// Ask Notification Center to drop the delivered banner with request id
    /// `id` (the Native Intelligence row id, see `show`). False when this build has no
    /// center.
    pub fn remove_delivered(id: &str) -> bool {
        let Some(center) = center() else {
            return false;
        };
        let ids = NSArray::from_retained_slice(&[NSString::from_str(id)]);
        center.removeDeliveredNotificationsWithIdentifiers(&ids);
        true
    }

    /// Map UNAuthorizationStatus onto the contract vocabulary. Unlike the old
    /// backend (which collapsed authorization to a bool) this distinguishes a
    /// real "denied" from a not-yet-asked "prompt".
    pub async fn permission_state() -> String {
        // Scoped so the non-Send ObjC values drop before the await (see `show`).
        let rx = {
            let Some(center) = center() else {
                return "unsupported".to_string();
            };

            let (tx, rx) = std::sync::mpsc::channel::<UNAuthorizationStatus>();
            let completion = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
                // SAFETY: the framework hands us a valid settings object for the
                // duration of this block.
                let status = unsafe { settings.as_ref() }.authorizationStatus();
                let _ = tx.send(status);
            });
            center.getNotificationSettingsWithCompletionHandler(&completion);
            rx
        };

        let status = match tokio::task::spawn_blocking(move || rx.recv()).await {
            Ok(Ok(status)) => status,
            _ => return "unsupported".to_string(),
        };

        match status {
            UNAuthorizationStatus::NotDetermined => "prompt".to_string(),
            UNAuthorizationStatus::Denied => "denied".to_string(),
            UNAuthorizationStatus::Authorized | UNAuthorizationStatus::Provisional => {
                "granted".to_string()
            }
            // Ephemeral (App Clips) and any future status: treat as usable
            // rather than blocking the feature on an unknown value.
            _ => "granted".to_string(),
        }
    }

    /// Ask for authorization, then report the state the OS settled on. macOS
    /// only really prompts the first time; afterwards the completion handler
    /// just echoes the standing answer.
    pub async fn request_permission() -> String {
        // Scoped so the non-Send ObjC values drop before the await (see `show`).
        let rx = {
            let Some(center) = center() else {
                return "unsupported".to_string();
            };

            let (tx, rx) = std::sync::mpsc::channel::<()>();
            let completion = RcBlock::new(move |_granted: Bool, error: *mut NSError| {
                if !error.is_null() {
                    // SAFETY: non-null NSError valid for this block's duration.
                    let message = unsafe { &*error }.localizedDescription().to_string();
                    log_to_file(&format!("[notify] request_permission failed: {}", message));
                }
                let _ = tx.send(());
            });
            center.requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert
                    | UNAuthorizationOptions::Sound
                    | UNAuthorizationOptions::Badge,
                &completion,
            );
            rx
        };

        if tokio::task::spawn_blocking(move || rx.recv()).await.is_err() {
            return "unsupported".to_string();
        }

        // Read back the authoritative state rather than trusting the `granted`
        // bool: it reports what THIS call decided, while the settings object is
        // the standing status (and distinguishes denied from not-determined).
        permission_state().await
    }
}

// ---------------------------------------------------------------------------
// Windows backend — WinRT toasts via tauri-winrt-notification
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod windows_impl {
    use tauri_winrt_notification::{Sound, Toast};

    use super::{APP_ID, handle_click_parts};
    use crate::log_to_file;

    /// Show a toast attributed to our AUMID, with the click handler capturing
    /// everything the routing needs.
    ///
    /// COLD-START LIMITATION (unchanged from the previous backend): the
    /// `on_activated` callback only exists while THIS process is alive. Clicking
    /// a toast sitting in the Action Center after the app has exited just
    /// launches Native Intelligence via the shortcut's AUMID — it does not deliver the id or
    /// payload, so the click lands on whatever the app opens by default.
    /// Wiring that up would mean routing toast activation through the
    /// `dial8desktop://` deep-link handler, i.e. a second divergent click path;
    /// deliberately out of scope for v1.
    pub async fn show(
        window_label: &str,
        id: &str,
        title: &str,
        body: Option<&str>,
        payload: Option<&str>,
    ) -> Result<(), String> {
        // Captured by value so the callback stays valid for the toast's life —
        // this is the Windows equivalent of macOS's userInfo dictionary, except
        // it lives in the process rather than in the OS notification.
        let click_id = id.to_string();
        let click_payload = payload.map(|p| p.to_string());
        let click_window = window_label.to_string();

        let mut toast = Toast::new(APP_ID)
            .title(title)
            .sound(Some(Sound::Default))
            .on_activated(move |_action| {
                handle_click_parts(
                    click_id.clone(),
                    click_payload.clone(),
                    Some(click_window.clone()),
                );
                Ok(())
            });

        // title/body verbatim; text1 is the first body line.
        if let Some(body) = body {
            toast = toast.text1(body);
        }

        toast.show().map_err(|e| {
            let message = e.to_string();
            log_to_file(&format!("[notify] send failed for {}: {}", id, message));
            message
        })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_local_agent_banners_show_over_ni() {
        assert!(super::shows_over_the_app("local-agent-3f2c"));
        assert!(!super::shows_over_the_app("chat-reply-1"));
        assert!(!super::shows_over_the_app("x-local-agent-1"));
        assert!(!super::shows_over_the_app(""));
    }

    use super::*;
    use base64::Engine as _;

    /// The smallest file that starts like a PNG (the signature, then junk): the
    /// decoder checks the signature, not the whole image.
    fn png_bytes() -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend_from_slice(b"rest-of-a-png");
        bytes
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn a_png_data_url_decodes_to_its_bytes() {
        let url = format!("data:image/png;base64,{}", b64(&png_bytes()));
        assert_eq!(decode_png_image(&url), Some(png_bytes()));
    }

    #[test]
    fn bare_base64_decodes_too() {
        assert_eq!(decode_png_image(&b64(&png_bytes())), Some(png_bytes()));
    }

    #[test]
    fn anything_but_a_png_is_dropped() {
        // Another type's data URL, even holding PNG bytes.
        let jpeg_url = format!("data:image/jpeg;base64,{}", b64(&png_bytes()));
        assert_eq!(decode_png_image(&jpeg_url), None);
        // Base64, but not a PNG.
        assert_eq!(decode_png_image(&b64(b"GIF89a-not-a-png")), None);
        // Not base64 at all.
        assert_eq!(decode_png_image("data:image/png;base64,***"), None);
        assert_eq!(decode_png_image(""), None);
        // A data URL with no comma.
        assert_eq!(decode_png_image("data:image/png;base64"), None);
    }

    #[test]
    fn an_oversized_image_is_dropped() {
        let mut big = png_bytes();
        big.resize(IMAGE_MAX_BYTES + 1, 0);
        assert_eq!(decode_png_image(&b64(&big)), None);
    }

    #[test]
    fn extras_drop_blanks_and_cut_long_strings() {
        let extras = BannerExtras::from_args(Some("   ".into()), Some(" Acme ".into()), Some("nope"));
        assert_eq!(extras, BannerExtras { thread_id: None, subtitle: Some("Acme".into()), image_png: None });

        let long = "x".repeat(THREAD_ID_MAX_CHARS + 10);
        let extras = BannerExtras::from_args(Some(long), None, None);
        assert_eq!(extras.thread_id.map(|t| t.chars().count()), Some(THREAD_ID_MAX_CHARS));
    }

    #[tokio::test]
    async fn a_refused_image_retries_the_banner_once_without_it() {
        let extras = BannerExtras::from_args(Some("tm-1".into()), Some("Acme".into()), Some(&b64(&png_bytes())));
        assert!(extras.image_png.is_some());
        let mut seen: Vec<BannerExtras> = Vec::new();
        let result = show_with_image_fallback("n1", extras.clone(), |e| {
            let refused = e.image_png.is_some();
            seen.push(e);
            async move { if refused { Err("attachment refused".to_string()) } else { Ok(()) } }
        })
        .await;
        assert_eq!(result, Ok(()));
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0], extras);
        // The second try keeps the thread and subtitle, drops only the image.
        assert_eq!(seen[1], BannerExtras { image_png: None, ..extras });
    }

    #[tokio::test]
    async fn a_failure_with_no_image_is_not_retried() {
        let mut tries = 0;
        let result = show_with_image_fallback("n1", BannerExtras::default(), |_| {
            tries += 1;
            async { Err::<(), _>("denied".to_string()) }
        })
        .await;
        assert_eq!(result, Err("denied".to_string()));
        assert_eq!(tries, 1);
    }

    #[tokio::test]
    async fn a_failure_without_the_image_too_is_the_error() {
        let extras = BannerExtras::from_args(None, None, Some(&b64(&png_bytes())));
        let mut tries = 0;
        let result = show_with_image_fallback("n1", extras, |_| {
            tries += 1;
            async { Err::<(), _>("denied".to_string()) }
        })
        .await;
        assert_eq!(result, Err("denied".to_string()));
        assert_eq!(tries, 2);
    }

    #[test]
    fn no_extras_is_the_banner_as_it_always_was() {
        assert_eq!(BannerExtras::from_args(None, None, None), BannerExtras::default());
    }

    #[test]
    fn image_file_names_keep_only_safe_characters() {
        // 4200 ns: Windows keeps time in 100 ns ticks, so 42 ns would read 0.
        let now = SystemTime::UNIX_EPOCH + Duration::from_nanos(4200);
        assert_eq!(image_file_name("abc-123_x", now), "abc-123_x-4200.png");
        assert_eq!(image_file_name("../../etc/passwd", now), "etcpasswd-4200.png");
        assert_eq!(image_file_name("///", now), "banner-4200.png");
    }

    #[test]
    fn writing_an_image_puts_it_in_the_dir() {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join(IMAGE_DIR_NAME);
        let path = write_image_file(&images, "n-1", &png_bytes(), SystemTime::now()).unwrap();
        assert_eq!(path.parent(), Some(images.as_path()));
        assert_eq!(std::fs::read(&path).unwrap(), png_bytes());
    }

    #[test]
    fn pruning_deletes_old_pngs_and_the_oldest_past_the_cap_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, b"x").unwrap();
            path
        };
        let a = write("a.png");
        let b = write("b.png");
        let c = write("c.png");
        let other = write("notes.txt");

        // Everything is "new" now: only the cap applies, so the oldest by
        // mtime go first. Space the mtimes so the order is certain.
        let base = SystemTime::now();
        for (i, path) in [&a, &b, &c].iter().enumerate() {
            let file = std::fs::File::options().write(true).open(path).unwrap();
            file.set_modified(base - Duration::from_secs(30 - i as u64 * 10)).unwrap();
        }
        assert_eq!(prune_image_dir(dir.path(), base, Duration::from_secs(3600), 2), 1);
        assert!(!a.exists() && b.exists() && c.exists());

        // An hour later, both are past the age limit.
        let later = base + Duration::from_secs(2 * 3600);
        assert_eq!(prune_image_dir(dir.path(), later, Duration::from_secs(3600), 10), 2);
        assert!(!b.exists() && !c.exists());

        // Never anything that isn't a .png.
        assert!(other.exists());
    }

    #[test]
    fn pruning_a_missing_dir_is_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(prune_image_dir(&dir.path().join("nope"), SystemTime::now(), IMAGE_MAX_AGE, 1), 0);
    }

    #[test]
    fn removing_with_no_backend_is_false_not_an_error() {
        // No `init` ran in the test binary, so there is no backend.
        assert_eq!(remove_delivered("n-1"), Ok(false));
        assert_eq!(remove_delivered("  "), Ok(false));
    }
}
