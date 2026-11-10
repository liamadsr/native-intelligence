//! Detect a WKWebView's WebContent (renderer) process dying — a jetsam OOM
//! kill, a WebKit crash, or `kill -9` on the WebContent pid — and recover by
//! reloading the window.
//!
//! WHY THIS EXISTS: when the WebContent process dies, the WKWebView's NSWindow
//! stays alive and on screen, holding a blank (or frozen) surface forever. In
//! Safari/Chrome the tab dies with the process and the browser shows its own
//! "this page was reloaded" UI; a Tauri/wry app gets neither — it just has a
//! dead window with no recovery path anywhere in the crate before this module.
//! The forensics that motivated this measured a 948 MB WebContent heap after
//! 7 h (1.82 GB peak), which is squarely in jetsam-kill territory, so this is
//! a reachable state and not a theoretical one.
//!
//! MECHANISM: wry 0.54.3's own navigation delegate class (`WryNavigationDelegate`,
//! installed as every WKWebView's `navigationDelegate` at construction) already
//! implements the `webViewWebContentProcessDidTerminate:` selector. It just
//! no-ops, because the only thing that can populate its handler ivar is wry's
//! macOS-only `WebViewBuilderExtDarwin::with_on_web_content_process_terminate_handler`,
//! and tauri 2.10.3 / tauri-runtime-wry 2.10.1 never call it (verified by
//! grepping both crate sources — zero hits); the ivar has no public setter after
//! construction either, and tauri's own `WebviewEvent` has exactly one variant
//! (`DragDrop`), so there is no cross-platform crash signal to subscribe to.
//!
//! So rather than installing a *new* delegate — which would silently drop wry's
//! own `didCommitNavigation:` script injection and download handling — we
//! SWIZZLE the IMP of that single already-registered selector on the delegate's
//! class, chaining to the original IMP first (a no-op today, but this keeps
//! working if wry ever wires its handler up).
//!
//! WHY NOT `with_webview`: the web view is found in the window's own view tree
//! instead — `ns_window()`, then depth first from its `contentView` to the
//! first `WKWebView`, as window_helper.m's `ni_find_webview` does. On macOS,
//! tauri-runtime-wry 2.10.1 builds the `Webview` it hands a `with_webview`
//! closure from `Retained::into_raw(webview.webview())`,
//! `Retained::into_raw(webview.manager())` and
//! `Retained::into_raw(webview.ns_window())` (src/lib.rs:3862-3869, the
//! `WebviewMessage::WithWebview` arm), and neither that type
//! (src/webview.rs:20) nor tauri 2.10.3's `PlatformWebview` wrapper
//! (src/webview/mod.rs:152) has a `Drop`. So every call leaves one retain each
//! on the WKWebView, its WKUserContentController and the NSWindow, and nothing
//! ever releases them. wry's `impl Drop for InnerWebView` (wry 0.54.3
//! src/wkwebview/mod.rs:1396) only takes the web view out of its superview; it
//! never closes the page. So a web view kept alive that way outlives its
//! closed window with the page still loaded, and its WebContent process keeps
//! running the page's JS. In a standalone Tauri 2.10.3 harness, three windows
//! opened and closed after one `with_webview` call each left all three web
//! views allocated and all three WebContent processes running (about 52 MB
//! each, the page's timer still firing); found in the view tree instead, all
//! three web views were freed and their processes exited. `ns_window()` itself
//! is balanced: tauri 2.10.3 returns the window autoreleased
//! (src/window/mod.rs:1553), and [`install`] drains its own autorelease pool.
//!
//! WHY THIS CANNOT FIRE ON A NORMAL NAVIGATION: WebKit calls
//! `webViewWebContentProcessDidTerminate:` only when the separate WebContent
//! process itself dies. An ordinary reload or `location.assign` keeps the same
//! WebContent process and drives `didStartProvisionalNavigation:` /
//! `didCommitNavigation:` / `didFinishNavigation:` instead — none of which this
//! module touches.

// macOS-only; `native/mod.rs` gates the whole module on the target.

use objc2::rc::autoreleasepool;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{msg_send, sel};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::log_to_file;

/// Automatic reloads allowed per window inside [`RELOAD_WINDOW`] before this
/// module gives up and only logs.
///
/// The failure mode being guarded against: if the page crashes the renderer
/// *while loading* (a genuinely broken build, or an OOM that recurs
/// immediately), reload-on-terminate becomes a crash→reload→crash loop that
/// burns CPU and fires a notification banner every cycle. Three tries is enough
/// to ride out a one-off jetsam kill plus a retry, and few enough that a real
/// loop stops within seconds.
const MAX_RELOADS: usize = 3;

/// Rolling window for [`MAX_RELOADS`]. Long enough that three unrelated OOM
/// kills spread over a working session are each still recovered; short enough
/// that giving up is not permanent for the app's lifetime.
const RELOAD_WINDOW: Duration = Duration::from_secs(600);

/// The original implementation of `webViewWebContentProcessDidTerminate:`,
/// captured once so the swizzled IMP can chain to it.
///
/// A single global slot is correct because wry declares `WryNavigationDelegate`
/// with one `define_class!` block and installs that SAME Objective-C class for
/// every WKWebView in the process — swizzling its method table affects all
/// instances, and there is exactly one original IMP to remember.
static ORIGINAL_IMP: OnceLock<Imp> = OnceLock::new();

/// Guards the class-level swizzle so it happens exactly once no matter how many
/// windows install a callback.
static SWIZZLED: AtomicBool = AtomicBool::new(false);

/// Per-webview handlers, so the one class-wide swizzle can still notify the
/// right window. Keyed by the raw `WKWebView*`, which is stable for the
/// window's lifetime and is exactly the pointer WebKit hands back as the
/// delegate callback's argument.
///
/// A `Vec` rather than a map because this holds at most a handful of entries
/// (main plus a few workspace popouts) and is walked only on a renderer crash.
///
/// The window LABEL is stored alongside the pointer so [`forget_window`] can
/// evict an entry when its window is destroyed. Without that, a destroyed
/// window's closure stays registered forever and a LATER webview allocated at
/// the same address (malloc reuses freed addresses aggressively) would fire the
/// dead window's handler — reloading, or refusing to reload, the wrong window.
///
/// `Arc` rather than `Box` so [`dispatch`] can clone the matching handlers out
/// from under the lock and invoke them with the mutex released: a handler that
/// ever re-entered `install()` (or `forget_window`) under the guard would
/// self-deadlock, and that coupling is invisible at the call site.
#[allow(clippy::type_complexity)]
static CALLBACKS: Mutex<Vec<(usize, String, Arc<dyn Fn() + Send + Sync>)>> = Mutex::new(Vec::new());

/// Reload timestamps per window label, for the [`MAX_RELOADS`] rate limit.
static RELOAD_HISTORY: Mutex<Vec<(String, Vec<Instant>)>> = Mutex::new(Vec::new());

/// Process-global sequence number for recovery events, used to build the
/// notification id.
///
/// It deliberately does NOT come from [`RELOAD_HISTORY`]: that history is
/// per-label, ages out of [`RELOAD_WINDOW`], and — decisively — is CLEARED by
/// [`forget_window`] on `WindowEvent::Destroyed`. A reopened window would
/// therefore restart its count at 1 and rebuild an id it already used, which
/// `notifications::show` swallows as a duplicate against its process-lifetime
/// SHOWN_IDS ring, silently suppressing the banner for the reopened window.
/// A monotonic counter that only ever increases for the life of the process
/// cannot collide no matter how the per-label state is reset.
static RECOVERY_EVENT_SEQ: AtomicUsize = AtomicUsize::new(0);

/// Take the next recovery-event sequence number (starting at 1).
fn next_recovery_event() -> usize {
    RECOVERY_EVENT_SEQ.fetch_add(1, Ordering::SeqCst) + 1
}

/// Register `cb` for the webview at `key`, owned by window `label`.
///
/// Replaces any existing entry for the same `key`: a label can be recreated (a
/// reopened workspace popout gets a fresh WKWebView, which may land on a
/// recycled address), and firing two handlers for one crash would double the
/// reload. Returns `false` if the registry lock is poisoned and nothing was
/// registered.
fn register(key: usize, label: &str, cb: Arc<dyn Fn() + Send + Sync>) -> bool {
    let Ok(mut callbacks) = CALLBACKS.lock() else {
        return false;
    };
    callbacks.retain(|(ptr, _, _)| *ptr != key);
    callbacks.push((key, label.to_string(), cb));
    true
}

/// Invoke every handler registered for `key`, returning how many ran.
///
/// The handlers are cloned into a local `Vec` under the lock and called after
/// the guard is dropped — see the [`CALLBACKS`] note on re-entrancy.
fn dispatch(key: usize) -> usize {
    // Scoped so the guard is DROPPED before any handler runs: a handler that
    // re-enters `register`/`forget_window` (which both take this same mutex)
    // would otherwise self-deadlock on the non-reentrant `std::sync::Mutex`.
    let matched: Vec<Arc<dyn Fn() + Send + Sync>> = {
        let Ok(callbacks) = CALLBACKS.lock() else {
            log_to_file("[webcontent-watchdog] callback registry poisoned — cannot recover");
            return 0;
        };
        callbacks
            .iter()
            .filter(|(ptr, _, _)| *ptr == key)
            .map(|(_, _, cb)| Arc::clone(cb))
            .collect()
        // guard dropped here, at the end of this block
    };

    for cb in &matched {
        cb();
    }
    matched.len()
}

/// Drop every trace of `label`: its registered handler and its reload budget.
///
/// Called from the `WindowEvent::Destroyed` arm in `lib.rs`. Destroyed ONLY —
/// `CloseRequested` can be cancelled, and deregistering there would leave a
/// still-live window unprotected.
pub fn forget_window(label: &str) {
    if let Ok(mut callbacks) = CALLBACKS.lock() {
        callbacks.retain(|(_, l, _)| l != label);
    }
    if let Ok(mut history) = RELOAD_HISTORY.lock() {
        history.retain(|(l, _)| l != label);
    }
}

/// Whether `label` may be reloaded right now, WITHOUT spending a budget slot.
///
/// Split from [`record_reload`] so a reload that never happened (the window was
/// already gone, or `reload()` errored) does not burn one of the
/// [`MAX_RELOADS`] tries and push a genuinely recoverable window over the cap.
///
/// FAILS OPEN on a poisoned lock: a redundant reload only costs a page load,
/// while refusing one leaves the user staring at a dead window.
fn would_allow(label: &str) -> bool {
    let Ok(mut history) = RELOAD_HISTORY.lock() else {
        return true;
    };
    let now = Instant::now();
    let Some(entry) = history.iter_mut().find(|(l, _)| l == label) else {
        return true;
    };
    // Drop attempts that have aged out of the rolling window before counting.
    entry.1.retain(|t| now.duration_since(*t) < RELOAD_WINDOW);
    entry.1.len() < MAX_RELOADS
}

/// Spend one reload slot for `label`. Call ONLY after a reload actually
/// succeeded. Returns how many reloads are now recorded in the rolling window
/// (useful for logging; NOT suitable as a notification id — see
/// [`RECOVERY_EVENT_SEQ`]).
fn record_reload(label: &str) -> usize {
    let Ok(mut history) = RELOAD_HISTORY.lock() else {
        return 0;
    };
    let now = Instant::now();
    let entry = match history.iter_mut().find(|(l, _)| l == label) {
        Some(entry) => entry,
        None => {
            history.push((label.to_string(), Vec::new()));
            history.last_mut().expect("just pushed")
        }
    };
    entry.1.retain(|t| now.duration_since(*t) < RELOAD_WINDOW);
    entry.1.push(now);
    entry.1.len()
}

/// Replacement IMP for `webViewWebContentProcessDidTerminate:`.
///
/// The signature must match what the Objective-C runtime pushes positionally:
/// `(id self, SEL _cmd, WKWebView *webView)`, with the `extern "C-unwind"` ABI
/// that `objc2::runtime::Imp` itself is defined as. wry declares the method as
/// `fn web_content_process_did_terminate(&self, webview: &WKWebView)` — one
/// object argument after the implicit self/_cmd pair — so `*mut AnyObject` for
/// that argument is the faithful erased form.
///
/// `this` is taken as a raw pointer rather than a reference because nothing
/// here guarantees non-null harder than the runtime already does, and a raw
/// pointer is the shape the transmute back to the original IMP needs anyway.
unsafe extern "C-unwind" fn swizzled_terminate(
    this: *mut AnyObject,
    cmd: Sel,
    webview: *mut AnyObject,
) {
    // Chain to the original FIRST. It is a no-op in wry 0.54.3 (the handler
    // ivar is None because tauri never populates it), but calling it keeps this
    // swizzle additive rather than replacing behaviour we did not inspect.
    if let Some(&original) = ORIGINAL_IMP.get() {
        let original: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) =
            unsafe { std::mem::transmute(original) };
        unsafe { original(this, cmd, webview) };
    }

    log_to_file(&format!(
        "[webcontent-watchdog] WebContent process terminated (webview {:p})",
        webview
    ));

    // WebKit delivers WKNavigationDelegate callbacks on the main thread, so the
    // handlers run on the AppKit/Tauri main thread and may touch windows
    // directly. `dispatch` releases the registry lock before invoking them.
    if dispatch(webview as usize) == 0 {
        log_to_file(
            "[webcontent-watchdog] no handler registered for that webview — not recovering",
        );
    }
}

/// Install the watchdog on `window`'s WKWebView.
///
/// Call once per dashboard window, any time after the window exists (in
/// `setup()` for `main`, right after `builder.build()` for a workspace popout).
/// HUD windows are deliberately excluded by the callers — they are transient
/// overlays, recreatable on demand, and carry no persisted state worth
/// recovering.
///
/// The web view is found in the window's view tree, never through
/// `with_webview` (see the module docs: that leaks the web view). All of it
/// runs on the main thread. Both callers are already there (`setup()`, and the
/// sync `open_workspace_window` command, which Tauri runs on the main thread),
/// and there `run_on_main_thread` runs the closure inline, before this
/// returns; from any other thread it queues the closure to the main thread,
/// the same dispatch `with_webview` used. The window is looked up by label
/// inside the closure, so one closed in between is skipped, not touched.
///
/// `on_terminated` runs on the MAIN thread, so it must not block; calling
/// `WebviewWindow` methods from it directly is safe.
///
/// Every failure path here logs and returns rather than panicking: a window
/// left unprotected is a regression to today's behaviour, while a panic on the
/// main thread, inside Tauri's event-loop dispatch, would take down a working
/// app.
pub fn install<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    on_terminated: impl Fn() + Send + Sync + 'static,
) {
    use tauri::Manager;

    let label = window.label().to_string();
    let main_thread_label = label.clone();
    let app = window.app_handle().clone();

    let result = window.run_on_main_thread(move || {
        let label = main_thread_label;
        let Some(window) = app.get_webview_window(&label) else {
            log_to_file(&format!(
                "[webcontent-watchdog] '{label}': window is gone, skipping install"
            ));
            return;
        };

        // Drains what the lookup autoreleases, the NSWindow that tauri's
        // `ns_window()` hands back included, before this closure returns.
        autoreleasepool(|_| {
            let ns_window = match window.ns_window() {
                Ok(ns_window) => ns_window,
                Err(e) => {
                    log_to_file(&format!(
                        "[webcontent-watchdog] '{label}': ns_window failed: {e}"
                    ));
                    return;
                }
            };

            // SAFETY: this runs on the main thread, where AppKit and WebKit
            // objects may be messaged, and `ns_window` is the live NSWindow of
            // the window just looked up (the pool holds it until it drains).
            unsafe {
                let Some(webview) = web_view_in(ns_window) else {
                    log_to_file(&format!(
                        "[webcontent-watchdog] '{label}': no WKWebView in the window, \
                         skipping install"
                    ));
                    return;
                };
                watch_web_view(webview, &label, on_terminated);
            }
        });
    });

    if let Err(e) = result {
        log_to_file(&format!(
            "[webcontent-watchdog] '{label}': run_on_main_thread failed: {e}"
        ));
    }
}

/// The web view in `ns_window` (a Tauri window has one), found as
/// window_helper.m's `ni_find_webview` finds it: depth first from the
/// window's content view, the first view that is a `WKWebView`. None if there
/// isn't one.
///
/// # Safety
///
/// `ns_window` is a live NSWindow (or null), and this runs on the main thread.
unsafe fn web_view_in(ns_window: *mut c_void) -> Option<*mut AnyObject> {
    let window = ns_window.cast::<AnyObject>();
    let wk_web_view = AnyClass::get(c"WKWebView")?;
    if window.is_null() {
        return None;
    }
    autoreleasepool(|_| {
        // SAFETY (each message here): NSWindow's, NSView's and NSArray's own
        // getters, with their signatures, on the main thread.
        let content: *mut AnyObject = unsafe { msg_send![window, contentView] };
        if content.is_null() {
            return None;
        }
        first_depth_first(
            content,
            |view| {
                let is_web_view: Bool = unsafe { msg_send![view, isKindOfClass: wk_web_view] };
                is_web_view.as_bool()
            },
            |view| {
                let subviews: *mut AnyObject = unsafe { msg_send![view, subviews] };
                if subviews.is_null() {
                    return Vec::new();
                }
                let count: usize = unsafe { msg_send![subviews, count] };
                (0..count)
                    .map(|i| -> *mut AnyObject { unsafe { msg_send![subviews, objectAtIndex: i] } })
                    .filter(|subview| !subview.is_null())
                    .collect()
            },
        )
    })
}

/// Depth first from `root`, a node before its children and children first to
/// last: the first node `is_match` accepts. Split out of [`web_view_in`] so
/// the order can be tested without AppKit.
fn first_depth_first<T: Copy>(
    root: T,
    mut is_match: impl FnMut(T) -> bool,
    mut children: impl FnMut(T) -> Vec<T>,
) -> Option<T> {
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if is_match(node) {
            return Some(node);
        }
        // Pushed last to first, so they're looked at first to last.
        stack.extend(children(node).into_iter().rev());
    }
    None
}

/// Swizzle wry's delegate class once, then register `on_terminated` for
/// `webview`.
///
/// # Safety
///
/// Runs on the main thread, with `webview` a live WKWebView. Every message
/// sent below is a documented, public selector.
unsafe fn watch_web_view(
    webview: *mut AnyObject,
    label: &str,
    on_terminated: impl Fn() + Send + Sync + 'static,
) {
    unsafe {
        let delegate: *mut AnyObject = msg_send![webview, navigationDelegate];
        if delegate.is_null() {
            // Reachable in principle if install() ever runs before wry has
            // attached its delegate. Skipping leaves the window exactly as
            // unprotected as it is today — no crash, just no recovery.
            log_to_file(&format!(
                "[webcontent-watchdog] '{label}': navigationDelegate is nil, skipping install"
            ));
            return;
        }

        let class: *const AnyClass = msg_send![delegate, class];
        if class.is_null() {
            log_to_file(&format!(
                "[webcontent-watchdog] '{label}': delegate has no class, skipping install"
            ));
            return;
        }
        let class: &AnyClass = &*class;

        let selector = sel!(webViewWebContentProcessDidTerminate:);
        let Some(method) = class.instance_method(selector) else {
            // A future wry could restructure its delegate. The selector
            // itself is public WKNavigationDelegate API and very unlikely to
            // disappear, but if wry stops implementing it there is nothing
            // to swizzle and this must degrade to today's behaviour, loudly.
            log_to_file(&format!(
                "[webcontent-watchdog] '{label}': {} does not implement \
                 webViewWebContentProcessDidTerminate:, skipping install",
                class.name().to_string_lossy()
            ));
            return;
        };

        // ORDER MATTERS: install the replacement IMP FIRST and only then
        // mark SWIZZLED. Claiming the flag up front would mean any panic or
        // early return between the claim and `set_implementation` leaves
        // the flag set with the original IMP still in place — the watchdog
        // permanently disabled for the process, with no second attempt
        // possible. `compare_exchange` on the trailing mark keeps the
        // one-swizzle guarantee: a concurrent installer that lost the race
        // re-does an idempotent `set_implementation` to the same IMP, and
        // `ORIGINAL_IMP` is a `OnceLock` so the chained-to original can
        // never be overwritten with our own replacement.
        if !SWIZZLED.load(Ordering::SeqCst) {
            let _ = ORIGINAL_IMP.set(method.implementation());
            // SAFETY of set_implementation: (1) the new IMP's signature
            // matches the Objective-C method exactly — self, _cmd, and the
            // one WKWebView* argument wry declares, with Imp's own
            // `extern "C-unwind"` ABI; (2) it is at least as safe as what it
            // replaces, since it calls the original first and then only
            // logs and dispatches Rust closures, dereferencing neither
            // pointer it is handed.
            let replacement: Imp = std::mem::transmute(
                swizzled_terminate
                    as unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
            );
            method.set_implementation(replacement);
            // Mark only now that the method table actually carries our IMP.
            let _ = SWIZZLED.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst);
            log_to_file(&format!(
                "[webcontent-watchdog] swizzled webViewWebContentProcessDidTerminate: on {}",
                class.name().to_string_lossy()
            ));
        }

        if !register(webview as usize, label, Arc::new(on_terminated)) {
            log_to_file(&format!(
                "[webcontent-watchdog] '{label}': callback registry poisoned, skipping install"
            ));
            return;
        }
        log_to_file(&format!(
            "[webcontent-watchdog] '{label}': watching webview {webview:p}"
        ));
    }
}

/// The standard recovery: log, reload the window, and tell the user.
///
/// Factored out so `lib.rs` (the `main` window) and `workspace_window.rs` (each
/// popout) install literally the same behaviour.
///
/// Reload is enough to restore the user's place: `WebviewWindow::reload()`
/// bottoms out in WKWebView's native `-reload`, which re-fetches the
/// last-committed URL independently of the destroyed JS/DOM context, and the
/// web app rehydrates its open tabs from localStorage (disk-resident, untouched
/// by a renderer crash). Unsaved in-page state is lost — an accepted tradeoff
/// against a permanently blank window.
pub fn install_default_recovery<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use tauri::Manager;

    let app = window.app_handle().clone();
    let label = window.label().to_string();

    install(window, move || {
        // Check the budget without spending it: only a reload that actually
        // happened should count against MAX_RELOADS.
        if !would_allow(&label) {
            log_to_file(&format!(
                "[webcontent-watchdog] '{label}' WebContent terminated — {MAX_RELOADS} reloads \
                 already in the last {}s, not reloading again (likely a crash loop)",
                RELOAD_WINDOW.as_secs()
            ));
            return;
        }

        log_to_file(&format!(
            "[webcontent-watchdog] '{label}' WebContent terminated — reloading"
        ));

        let reloads_in_window = match app.get_webview_window(&label) {
            Some(window) => match window.reload() {
                Ok(()) => record_reload(&label),
                Err(e) => {
                    log_to_file(&format!(
                        "[webcontent-watchdog] '{label}' reload failed: {e}"
                    ));
                    return;
                }
            },
            None => {
                log_to_file(&format!(
                    "[webcontent-watchdog] '{label}' no longer exists — nothing to reload"
                ));
                return;
            }
        };

        // Best-effort banner. `notifications::show` is async and this callback
        // runs on the main thread, so it is spawned rather than blocked on —
        // the reload above already happened and does not depend on it.
        //
        // NOTE: `show` deliberately returns Ok(false) without a banner while any
        // non-HUD Native Intelligence window is focused (its documented "app is frontmost"
        // policy). A renderer crash usually happens while the user IS looking at
        // the app, so the common outcome is a silent recovery plus the log line
        // above — which is the right behaviour: the window visibly reloads in
        // front of them, and a banner would be noise.
        //
        // The id MUST be unique per termination event. `show` dedupes on id via
        // a process-lifetime SHOWN_IDS ring that is never cleared per window, so
        // a constant "webcontent-recovered:{label}" would surface a banner at
        // most ONCE for the whole run of the app — the second real OOM recovery
        // would be swallowed as a duplicate.
        //
        // The sequence number comes from the process-global
        // RECOVERY_EVENT_SEQ, NOT from this label's reload count: that count
        // ages out of RELOAD_WINDOW and is cleared outright by
        // `forget_window` when the window is destroyed, so a reopened window
        // would restart at 1 and rebuild an id already in SHOWN_IDS — banner
        // silently suppressed. A monotonic process counter cannot collide.
        let event_n = next_recovery_event();
        log_to_file(&format!(
            "[webcontent-watchdog] '{label}' reloaded (event {event_n}, \
             {reloads_in_window}/{MAX_RELOADS} in the last {}s)",
            RELOAD_WINDOW.as_secs()
        ));

        let label_for_notify = label.clone();
        tauri::async_runtime::spawn(async move {
            let id = format!("webcontent-recovered:{label_for_notify}:{event_n}");
            match crate::notifications::show(
                &label_for_notify,
                &id,
                "Native Intelligence recovered",
                Some("The window ran out of memory and reloaded."),
                None,
                crate::notifications::BannerExtras::default(),
            )
            .await
            {
                Ok(true) => {}
                // Distinct from a delivered banner: `show` returns Ok(false)
                // for its documented "a Native Intelligence window is focused" skip, which is
                // the COMMON outcome here (the user is usually looking at the
                // window that just crashed). Logging it separately keeps a
                // silent recovery distinguishable from a broken notifier.
                Ok(false) => log_to_file(&format!(
                    "[webcontent-watchdog] '{label_for_notify}' banner suppressed \
                     (app focused) — reload was silent"
                )),
                Err(e) => log_to_file(&format!(
                    "[webcontent-watchdog] '{label_for_notify}' notification failed: {e}"
                )),
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::AtomicUsize;

    /// A view tree as child lists (node `n`'s children are `tree[n]`), walked
    /// by `first_depth_first` with every node it looks at recorded.
    fn walk(tree: &[Vec<usize>], matches: &[usize]) -> (Option<usize>, Vec<usize>) {
        let mut seen = Vec::new();
        let found = first_depth_first(
            0,
            |node| {
                seen.push(node);
                matches.contains(&node)
            },
            |node| tree[node].clone(),
        );
        (found, seen)
    }

    /// The content view itself counts: a window whose content view IS the
    /// web view (no wrapper) must still be found, without looking further.
    #[test]
    fn depth_first_returns_the_root_when_it_matches() {
        let tree = vec![vec![1], vec![]];
        assert_eq!(walk(&tree, &[0, 1]), (Some(0), vec![0]));
    }

    /// Depth first, like `ni_find_webview`: all of the first subview's
    /// subtree before the second subview, children first to last. With a
    /// match deep under the first subview and another as the second subview,
    /// the deep one is found; breadth first would return the other.
    ///
    /// ```text
    /// 0 ┬ 1 ┬ 2
    ///   │   └ 3
    ///   └ 4
    /// ```
    #[test]
    fn depth_first_goes_deep_before_wide() {
        let tree = vec![vec![1, 4], vec![2, 3], vec![], vec![], vec![]];
        assert_eq!(walk(&tree, &[3, 4]), (Some(3), vec![0, 1, 2, 3]));
        assert_eq!(walk(&tree, &[]), (None, vec![0, 1, 2, 3, 4]));
    }

    /// A window without a web view gives None after looking at every view once.
    #[test]
    fn depth_first_finds_nothing_in_a_tree_without_a_match() {
        let tree = vec![vec![1, 2], vec![], vec![3], vec![]];
        assert_eq!(walk(&tree, &[]), (None, vec![0, 1, 2, 3]));
    }

    /// A counting handler plus the `Arc` the registry stores.
    fn counter() -> (Arc<AtomicUsize>, Arc<dyn Fn() + Send + Sync>) {
        let hits = Arc::new(AtomicUsize::new(0));
        let for_cb = Arc::clone(&hits);
        let cb: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            for_cb.fetch_add(1, Ordering::SeqCst);
        });
        (hits, cb)
    }

    /// The rate limit must allow exactly MAX_RELOADS recoveries and then stop,
    /// which is what keeps a crash→reload→crash loop from hammering the user.
    #[test]
    fn rate_limit_stops_after_max_reloads() {
        let label = "test-window-rate-limit";
        for attempt in 0..MAX_RELOADS {
            assert!(would_allow(label), "attempt {attempt} should be allowed");
            record_reload(label);
        }
        assert!(!would_allow(label), "attempt past the cap must be refused");
    }

    /// Separate windows must not share a budget — one popout crash-looping
    /// cannot be allowed to block recovery of the main window.
    #[test]
    fn rate_limit_is_per_label() {
        let a = "test-window-per-label-a";
        let b = "test-window-per-label-b";
        for _ in 0..MAX_RELOADS {
            assert!(would_allow(a));
            record_reload(a);
        }
        assert!(!would_allow(a));
        assert!(would_allow(b), "a different label has its own budget");
    }

    /// NIT 6: a probe must not spend budget. Calling `would_allow` any number of
    /// times without a successful reload has to leave all MAX_RELOADS tries
    /// intact — otherwise a window whose `reload()` kept erroring would exhaust
    /// its budget and be refused recovery once reload started working again.
    #[test]
    fn would_allow_does_not_consume_budget() {
        let label = "test-window-probe-only";
        for _ in 0..(MAX_RELOADS * 3) {
            assert!(would_allow(label), "probing must never exhaust the budget");
        }
        // The full budget is still there to spend.
        for _ in 0..MAX_RELOADS {
            assert!(would_allow(label));
            record_reload(label);
        }
        assert!(!would_allow(label));
    }

    /// `record_reload` returns the rolling-window count. It is a logging/budget
    /// figure only — the notification id must NOT be built from it (see
    /// `notification_id_survives_forget_window`).
    #[test]
    fn record_reload_returns_increasing_attempt_numbers() {
        let label = "test-window-attempt-seq";
        let seen: Vec<usize> = (0..MAX_RELOADS).map(|_| record_reload(label)).collect();
        assert_eq!(seen, (1..=MAX_RELOADS).collect::<Vec<_>>());
    }

    /// Build the notification id exactly as `install_default_recovery` does, so
    /// the test exercises the real id shape and not a paraphrase of it.
    fn notification_id(label: &str, event_n: usize) -> String {
        format!("webcontent-recovered:{label}:{event_n}")
    }

    /// MUST_FIX 2, round 2: two terminations for the SAME label with a
    /// `forget_window` in between (window closed and reopened) must still
    /// produce DISTINCT notification ids.
    ///
    /// Fails on the old code, which derived the id from `record_reload`'s
    /// per-label rolling count: `forget_window` wipes that history, so the
    /// reopened window restarts at 1 and rebuilds an id already sitting in
    /// `notifications::show`'s process-lifetime SHOWN_IDS ring — the banner is
    /// silently swallowed as a duplicate.
    #[test]
    fn notification_id_survives_forget_window() {
        let label = "test-window-reopened";

        // First termination for this window.
        let first_count = record_reload(label);
        let first_id = notification_id(label, next_recovery_event());

        // Window is closed: lib.rs's Destroyed arm clears every trace of it.
        forget_window(label);

        // Reopened window, fresh WKWebView, renderer dies again.
        let second_count = record_reload(label);
        let second_id = notification_id(label, next_recovery_event());

        // The per-label count really did reset — this is the trap the old id
        // walked into.
        assert_eq!(first_count, 1);
        assert_eq!(second_count, 1, "forget_window resets the rolling count");

        assert_ne!(
            first_id, second_id,
            "a reopened window's banner id must not collide with its own \
             earlier id, or notifications::show swallows it"
        );

        forget_window(label);
    }

    /// The recovery sequence is process-global and strictly increasing, so ids
    /// cannot collide across windows either.
    #[test]
    fn recovery_event_sequence_is_strictly_increasing() {
        let a = next_recovery_event();
        let b = next_recovery_event();
        let c = next_recovery_event();
        assert!(a < b && b < c, "sequence must be strictly increasing");
        assert_ne!(
            notification_id("win-a", b),
            notification_id("win-b", c),
            "different events must yield different ids"
        );
    }

    /// SHOULD_FIX 5: registering the SAME key twice must leave ONE handler, so a
    /// recreated window at a recycled address does not reload twice per crash.
    #[test]
    fn register_same_key_twice_leaves_one_handler() {
        let key = 0x1001;
        let (first, first_cb) = counter();
        let (second, second_cb) = counter();
        assert!(register(key, "dup-a", first_cb));
        assert!(register(key, "dup-b", second_cb));

        assert_eq!(dispatch(key), 1, "only the latest registration may fire");
        assert_eq!(
            first.load(Ordering::SeqCst),
            0,
            "stale handler must be gone"
        );
        assert_eq!(second.load(Ordering::SeqCst), 1);

        forget_window("dup-b");
    }

    /// An unregistered key dispatches to nothing — this is the "no handler for
    /// that webview" branch that must log rather than recover something random.
    #[test]
    fn dispatch_unregistered_key_runs_nothing() {
        assert_eq!(dispatch(0xdead_beef), 0);
    }

    /// Two live windows must stay independent: a crash in one fires only its own
    /// handler.
    #[test]
    fn two_keys_dispatch_independently() {
        let (hits_a, cb_a) = counter();
        let (hits_b, cb_b) = counter();
        assert!(register(0x2001, "indep-a", cb_a));
        assert!(register(0x2002, "indep-b", cb_b));

        assert_eq!(dispatch(0x2001), 1);
        assert_eq!(hits_a.load(Ordering::SeqCst), 1);
        assert_eq!(hits_b.load(Ordering::SeqCst), 0, "sibling must not fire");

        forget_window("indep-a");
        forget_window("indep-b");
    }

    /// MUST_FIX 1: when a window is destroyed its handler must be dropped, so a
    /// LATER webview allocated at the same address cannot fire the dead
    /// window's closure. Reproduces the reviewer's scenario directly: register,
    /// destroy, then dispatch the recycled pointer.
    #[test]
    fn forget_window_drops_handler_so_recycled_address_is_inert() {
        let recycled_key = 0x3001;
        let (hits, cb) = counter();
        assert!(register(recycled_key, "destroyed-window", cb));

        // The window is destroyed -> lib.rs's Destroyed arm calls this.
        forget_window("destroyed-window");

        // malloc hands the same address to a brand-new WKWebView, whose renderer
        // then dies. Nothing must fire: the old window is gone, and the new one
        // has not installed yet.
        assert_eq!(
            dispatch(recycled_key),
            0,
            "a destroyed window's handler must not fire for a recycled address"
        );
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }

    /// MUST_FIX 1, second half: `forget_window` must also clear the reload
    /// budget, so a reopened window starts fresh instead of inheriting the dead
    /// one's exhausted count and being refused its first recovery.
    #[test]
    fn forget_window_clears_reload_budget() {
        let label = "test-window-budget-reset";
        for _ in 0..MAX_RELOADS {
            record_reload(label);
        }
        assert!(!would_allow(label), "budget is exhausted before destroy");

        forget_window(label);

        assert!(
            would_allow(label),
            "a recreated window must get a fresh reload budget"
        );
    }

    /// SHOULD_FIX 3: the registry lock must NOT be held while handlers run — a
    /// handler that re-enters install()/forget_window() would otherwise
    /// self-deadlock. Re-entering from inside the callback is the direct probe.
    ///
    /// The re-entrant dispatch runs on a SPAWNED thread and the result is
    /// awaited with a bounded `recv_timeout`: if the guard-held-across-callbacks
    /// shape ever returns, the worker blocks forever, and running it inline
    /// would hang the whole test binary (a silent, indistinguishable-from-CI-
    /// slowness failure) instead of failing loudly here.
    #[test]
    fn dispatch_releases_lock_before_invoking_handlers() {
        use std::sync::mpsc;

        let key = 0x4001;
        let reentered = Arc::new(AtomicUsize::new(0));
        let for_cb = Arc::clone(&reentered);
        let cb: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            // Would deadlock if `dispatch` still held the CALLBACKS guard.
            let (_, other) = counter();
            register(0x4002, "reentrant-inner", other);
            forget_window("reentrant-inner");
            for_cb.fetch_add(1, Ordering::SeqCst);
        });
        assert!(register(key, "reentrant-outer", cb));

        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            // A deadlock parks this thread here; the send never happens and the
            // recv_timeout below fails the test.
            let _ = tx.send(dispatch(key));
        });

        let fired = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("dispatch deadlocked — the CALLBACKS guard is held across handler calls");

        assert_eq!(fired, 1);
        assert_eq!(reentered.load(Ordering::SeqCst), 1);

        forget_window("reentrant-outer");
    }

    /// Companion to the re-entrancy test, from the OTHER side of the lock: while
    /// a handler is running, a DIFFERENT thread must be able to take the
    /// CALLBACKS mutex.
    ///
    /// This pins the guarantee even on a hypothetical reentrant mutex, where the
    /// same-thread probe above could pass with the lock still held.
    ///
    /// The probe window is bounded by the HANDLER's own lifetime, not by a wall
    /// clock: the handler signals the helper, then BLOCKS waiting for the
    /// helper's verdict. So the helper's `try_lock` spin can only ever succeed
    /// while `cb()` is genuinely mid-flight — it cannot "win" by outlasting the
    /// handler and grabbing the lock after `dispatch` already returned, which is
    /// exactly how a naive timeout-bounded probe passes on the broken code.
    ///
    /// The helper's spin is still capped so that the guard-held shape reports
    /// `false` (a clean assert failure) instead of hanging the test binary.
    #[test]
    fn callbacks_lock_is_free_to_other_threads_during_handler() {
        use std::sync::mpsc;

        let key = 0x4101;
        let (started_tx, started_rx) = mpsc::channel::<()>();
        let (acquired_tx, acquired_rx) = mpsc::channel::<bool>();

        let helper = std::thread::spawn(move || {
            // Wait until the handler is mid-flight before probing.
            if started_rx.recv_timeout(Duration::from_secs(10)).is_err() {
                let _ = acquired_tx.send(false);
                return;
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut got = false;
            while Instant::now() < deadline {
                if CALLBACKS.try_lock().is_ok() {
                    got = true;
                    break;
                }
                std::thread::yield_now();
            }
            let _ = acquired_tx.send(got);
        });

        // The handler owns the verdict channel: it does not return until the
        // helper has reported, which is what keeps the probe inside `cb()`.
        //
        // `Sender`/`Receiver` are `Send` but not `Sync`, and the registry stores
        // `Arc<dyn Fn() + Send + Sync>`, so both ends are parked behind mutexes
        // the handler takes them out of.
        let started_tx = Mutex::new(Some(started_tx));
        let acquired_rx = Mutex::new(Some(acquired_rx));
        let verdict = Arc::new(Mutex::new(None::<bool>));
        let verdict_for_cb = Arc::clone(&verdict);
        let cb: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let tx = started_tx
                .lock()
                .expect("tx mutex")
                .take()
                .expect("one call");
            let rx = acquired_rx
                .lock()
                .expect("rx mutex")
                .take()
                .expect("one call");
            let _ = tx.send(());
            let reported = rx
                .recv_timeout(Duration::from_secs(15))
                .expect("helper thread never reported");
            *verdict_for_cb.lock().expect("verdict mutex") = Some(reported);
        });
        assert!(register(key, "lockfree-outer", cb));

        assert_eq!(dispatch(key), 1);
        helper.join().expect("helper thread panicked");

        let acquired = verdict
            .lock()
            .expect("verdict mutex")
            .expect("handler never recorded a verdict");
        assert!(
            acquired,
            "another thread must be able to lock CALLBACKS while a handler runs — \
             dispatch is holding the guard across cb()"
        );

        forget_window("lockfree-outer");
    }
}
