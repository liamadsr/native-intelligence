//! Frontend-facing commands for native OS notifications.
//!
//! The web app owns most of the policy (which notifications deserve a banner,
//! and whether its own document is focused); these six commands are the whole
//! native surface. See `crate::notifications` for the manager and click
//! plumbing — including the native-side focus check that `show` layers on top
//! of the web's, and the window-targeted click delivery.
//!
//! Every command returns `Result<_, String>` and never panics — an older native
//! binary simply won't have these commands registered, and the web side already
//! falls back to an in-app toast when an invoke fails, so failing loudly here
//! would gain nothing.

use tauri::{Manager, Window};

/// Show a native notification for Dial8 notification row `id`.
///
/// `title`/`body` are displayed verbatim (the server owns the copy) and
/// `payload` is an opaque JSON string echoed back on click. Duplicate `id`s are
/// dropped, so several workspace windows observing the same realtime INSERT
/// produce one banner.
///
/// Returns `Ok(true)` when a banner was shown and `Ok(false)` when it was
/// deliberately skipped because a non-HUD Dial8 window is currently focused —
/// the app is frontmost, so the in-app toast is the right surface. The web side
/// must show its toast on `false` and treat anything else as shown; in
/// particular `undefined`/`null`, which is what an OLD binary returns from the
/// unit-returning version of this command, means "shown".
///
/// A skip is `Ok(false)`, never `Err`, precisely because the web side latches on
/// `Err` and permanently disables the native path for the session.
///
/// Returns `Err` when the OS refuses — most often an unbundled dev build, where
/// there is no bundle identifier for UNUserNotificationCenter to attribute the
/// notification to.
///
/// Three optional extras make a bot's banner look like the bot (bots v3,
/// phase 7). Every one is optional, so a page that predates them still works,
/// and a binary that predates them ignores them (Tauri only reads the args a
/// command names):
///
/// - `thread_id`: Notification Center groups banners that share it (macOS
///   `threadIdentifier`). The web passes the bot's teammate id, so each bot gets
///   its own stack.
/// - `subtitle`: a line between the title and the body (the workspace).
/// - `image`: the bot's still as a PNG, either a `data:image/png;base64,...`
///   URL or bare base64. Written to a file in the app's cache dir and attached
///   (`UNNotificationAttachment` needs a local file). A bad or oversized image
///   is dropped and the banner goes up without it: an image never fails a
///   banner.
///
/// None of these touch the alert style or the interruption level: the banner
/// stays the transient kind.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn show_native_notification(
    window: Window,
    id: String,
    title: String,
    body: Option<String>,
    payload: Option<String>,
    thread_id: Option<String>,
    subtitle: Option<String>,
    image: Option<String>,
) -> Result<bool, String> {
    check_web_id(&id)?;
    let extras = crate::notifications::BannerExtras::from_args(thread_id, subtitle, image.as_deref());
    crate::notifications::show(
        window.label(),
        &id,
        &title,
        body.as_deref(),
        payload.as_deref(),
        extras,
    )
    .await
}

/// A page's banner id, refused when it is one of Rust's own
/// ([`crate::notifications::NATIVE_ID_PREFIX`]): a page could otherwise pass
/// its banner off as the local agent's notice, or replace one.
fn check_web_id(id: &str) -> Result<(), String> {
    if crate::notifications::web_may_use_id(id) {
        Ok(())
    } else {
        Err(format!(
            "notification ids starting with {:?} are Dial8's own",
            crate::notifications::NATIVE_ID_PREFIX
        ))
    }
}

/// Take a delivered banner for Dial8 notification row `id` out of Notification
/// Center, once its item has been opened or the notice read elsewhere.
///
/// `Ok(true)` when the OS was asked to remove it (removing an id that isn't
/// there is a no-op), `Ok(false)` when this platform or build can't (no
/// backend, or Windows, whose toast crate has no history API). Never `Err` for
/// those, and the web side must treat a rejection (an OLDER binary without this
/// command) as "can't remove" only: it must never disable the banner path.
#[tauri::command]
pub fn remove_delivered_notification(id: String) -> Result<bool, String> {
    crate::notifications::remove_delivered(&id)
}

/// Current OS notification permission: "granted" | "denied" | "prompt" | "unsupported".
///
/// "unsupported" covers any environment where notifications can't initialize
/// (notably a non-bundled macOS dev run) — that's a normal state, not an error.
#[tauri::command]
pub async fn notification_permission_state() -> Result<String, String> {
    crate::notifications::permission_state().await
}

/// Trigger the OS permission prompt and return the resulting state, using the
/// same vocabulary as `notification_permission_state`. macOS only really
/// prompts once; afterwards this reports the standing answer.
#[tauri::command]
pub async fn request_notification_permission() -> Result<String, String> {
    crate::notifications::request_permission().await
}

/// Called by the webview once its `notification-clicked` listener is live.
/// Flushes clicks that arrived first — the cold-start case, where clicking a
/// notification launches the app and the click is handled long before dial8.ai
/// has loaded. Mirrors `agent_hud_ready` in `hud.rs`.
#[tauri::command]
pub fn notification_click_listener_ready(window: Window) -> Result<(), String> {
    let app = window.app_handle().clone();
    crate::notifications::mark_listener_ready(&app, window.label());
    Ok(())
}

/// Called by the webview when its `notification-clicked` listener is torn down
/// WITHOUT the page going away — the SPA-unmount case, where the React effect's
/// cleanup runs but the JS context survives.
///
/// Hard navigations and window teardown are covered natively (`on_page_load` /
/// `WindowEvent::Destroyed` in lib.rs); this command exists for the one case the
/// native side cannot observe. Without it the window stays marked ready and the
/// next click is emitted into a page with nothing listening — a successful emit
/// that silently drops the click instead of buffering it.
#[tauri::command]
pub fn notification_click_listener_gone(window: Window) -> Result<(), String> {
    crate::notifications::forget_window(window.label());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_cant_use_the_local_agents_banner_ids() {
        for theirs in ["local-agent-1234", "LOCAL-AGENT-x", "Local-Agent-", "local-agent-"] {
            assert!(check_web_id(theirs).is_err(), "{theirs}");
        }
        for ok in ["0b5e2d6c-aaaa-4bbb-8ccc-dddddddddddd", "local-agent", "my-local-agent-1", "", "é"] {
            assert_eq!(check_web_id(ok), Ok(()), "{ok}");
        }
    }
}
