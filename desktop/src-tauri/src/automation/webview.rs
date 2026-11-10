//! The bridge's macOS side: the main window's WKWebView.
//!
//! The web view is found in the window's view tree (`ns_window()`, then depth
//! first to the first WKWebView), the way
//! native/webcontent_watchdog.rs finds it, never through `with_webview`: on
//! tauri-runtime-wry 2.10.x that leaks the web view (see the watchdog's notes).
//! Everything that touches it runs on the main thread; the HTTP handler awaits
//! a oneshot.
//!
//!   - The page flag: a WKUserScript at document start, main frame only, page
//!     world, so it is there before the app's own scripts on every load. It is
//!     added after the first navigation has started (the window is created
//!     before `setup()`), so the main web view is then loaded again, once.
//!   - `/health`: the URL, the web view's frame in the window (points,
//!     top-left origin), pageZoom and magnification, so CSS pixels from
//!     `getBoundingClientRect()` map to window points.
//!   - `/eval`: `callAsyncJavaScript:arguments:inFrame:inContentWorld:` in the
//!     main frame and the page world (the app's globals), `args` passed as its
//!     named arguments. The script runs inside a wrapper (see [`wrap`]) that
//!     turns its outcome into the response body.

use std::ptr;
use std::sync::Mutex;

use block2::RcBlock;
use objc2::rc::{autoreleasepool, Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::{msg_send, ClassType};
use objc2_foundation::{NSData, NSJSONReadingOptions, NSJSONSerialization, NSRect, NSString};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

use super::server::{Backend, EvalRequest};
use super::PROTOCOL_VERSION;
use crate::log_to_file;

/// What the page sees while the bridge is up (web/src/lib/automation).
fn flag_source() -> String {
    format!("window.__NI_AUTOMATION__ = Object.freeze({{ version: {PROTOCOL_VERSION} }});")
}

/// The main window's web view, as the bridge's [`Backend`].
pub struct MainWebView {
    app: AppHandle,
}

impl MainWebView {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl Backend for MainWebView {
    async fn health(&self) -> Result<Map<String, Value>, String> {
        let view = on_main(&self.app, |app| {
            // SAFETY: on the main thread; `read_view` only sends documented
            // getters to the live window and web view `with_main` found.
            unsafe { with_main(app, |window, web_view| read_view(window, web_view)) }
        })
        .await??;
        let mut fields = Map::new();
        fields.insert("app".into(), json!(self.app.config().identifier));
        fields.insert("version".into(), json!(self.app.package_info().version.to_string()));
        fields.extend(view);
        Ok(fields)
    }

    async fn eval(&self, request: EvalRequest) -> Value {
        let (reply, answer) = oneshot::channel::<Value>();
        let body = wrap(&request.script);
        let args = request.args;
        let started = on_main(&self.app, move |app| {
            // SAFETY: on the main thread, with the live web view `with_main` found.
            unsafe { with_main(app, move |_, web_view| call_async(web_view, &body, &args, reply)) }
        })
        .await;
        match started {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(why))) | Ok(Err(why)) | Err(why) => return json!({ "ok": false, "error": why }),
        }
        // The server's timeout bounds this wait.
        answer
            .await
            .unwrap_or_else(|_| json!({ "ok": false, "error": "the web view went away before answering" }))
    }
}

/// Add the page flag to the main web view and load the page again so the
/// first page has it too. Call once, on the main thread (`setup()`).
pub fn install_flag(app: &AppHandle) {
    let handle = app.clone();
    let queued = app.run_on_main_thread(move || {
        // SAFETY: on the main thread, with the live web view `with_main` found.
        match unsafe { with_main(&handle, |_, web_view| add_flag_script(web_view)) } {
            Ok(Ok(())) => reload_main(&handle),
            Ok(Err(why)) | Err(why) => log_to_file(&format!("[automation] page flag not installed: {why}")),
        }
    });
    if let Err(e) = queued {
        log_to_file(&format!("[automation] page flag not installed: {e}"));
    }
}

/// Load the main window's page again: its current (or pending) URL when it is
/// the app's own (nativeintelligence.dev, or the dev server in a debug build, as `setup()`
/// points it), else the app's base URL. A navigation rather than `-reload`,
/// which does nothing while the first load hasn't committed.
fn reload_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let base = crate::tray::api_base_url();
    let url = window
        .url()
        .ok()
        .filter(|url| url.as_str().starts_with(base))
        .or_else(|| base.parse().ok());
    if let Some(url) = url {
        if let Err(e) = window.navigate(url) {
            log_to_file(&format!("[automation] reload after the page flag failed: {e}"));
        }
    }
}

/// Run `f` on the main thread and hand its result back.
async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&AppHandle) -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(f(&handle));
    })
    .map_err(|e| format!("the main thread is unavailable: {e}"))?;
    rx.await.map_err(|_| "the main thread dropped the call".to_string())
}

/// `f` with the main window's NSWindow and WKWebView, inside an autorelease
/// pool (it drains what the lookup autoreleases, the NSWindow included).
///
/// # Safety
///
/// Main thread only.
unsafe fn with_main<T>(app: &AppHandle, f: impl FnOnce(*mut AnyObject, *mut AnyObject) -> T) -> Result<T, String> {
    let window = app.get_webview_window("main").ok_or("the main window is gone")?;
    autoreleasepool(|_| {
        let ns_window = window.ns_window().map_err(|e| format!("the main window has no NSWindow: {e}"))?;
        // SAFETY: a live NSWindow, on the main thread.
        let web_view = unsafe { crate::native::web_view::web_view_in(ns_window) }
            .ok_or("the main window has no web view")?;
        Ok(f(ns_window.cast(), web_view))
    })
}

/// # Safety
///
/// Main thread; `web_view` is a live WKWebView.
unsafe fn page_world() -> Result<*mut AnyObject, String> {
    let class = AnyClass::get(c"WKContentWorld").ok_or("WKContentWorld is unavailable")?;
    let world: *mut AnyObject = unsafe { msg_send![class, pageWorld] };
    if world.is_null() {
        return Err("WKContentWorld.pageWorld is nil".into());
    }
    Ok(world)
}

/// # Safety
///
/// Main thread; `web_view` is a live WKWebView.
unsafe fn add_flag_script(web_view: *mut AnyObject) -> Result<(), String> {
    unsafe {
        let world = page_world()?;
        let class = AnyClass::get(c"WKUserScript").ok_or("WKUserScript is unavailable")?;
        let source = NSString::from_str(&flag_source());
        let allocated: Allocated<AnyObject> = msg_send![class, alloc];
        // WKUserScriptInjectionTimeAtDocumentStart = 0.
        let script: Option<Retained<AnyObject>> = msg_send![
            allocated,
            initWithSource: &*source,
            injectionTime: 0isize,
            forMainFrameOnly: Bool::YES,
            inContentWorld: world
        ];
        let script = script.ok_or("WKUserScript didn't initialize")?;
        // `configuration` is a copy, but it shares the web view's user content
        // controller (WebKit copies the reference, not the controller).
        let configuration: *mut AnyObject = msg_send![web_view, configuration];
        let controller: *mut AnyObject = msg_send![configuration, userContentController];
        if controller.is_null() {
            return Err("the web view has no user content controller".into());
        }
        let _: () = msg_send![controller, addUserScript: &*script];
        Ok(())
    }
}

/// `/health`'s fields about the web view.
///
/// # Safety
///
/// Main thread; `window` and `web_view` are live and the view is in the window.
unsafe fn read_view(window: *mut AnyObject, web_view: *mut AnyObject) -> Map<String, Value> {
    unsafe {
        let url: Option<Retained<AnyObject>> = msg_send![web_view, URL];
        let url = url.and_then(|url| {
            let text: Option<Retained<NSString>> = msg_send![&*url, absoluteString];
            text.map(|t| t.to_string())
        });
        // The web view's bounds in the window's base coordinates (points,
        // bottom-left origin), flipped against the window's frame so the
        // origin is the window's top-left, as a window capture sees it.
        let bounds: NSRect = msg_send![web_view, bounds];
        let in_window: NSRect = msg_send![web_view, convertRect: bounds, toView: ptr::null_mut::<AnyObject>()];
        let frame: NSRect = msg_send![window, frame];
        let top = frame.size.height - (in_window.origin.y + in_window.size.height);
        let page_zoom: f64 = msg_send![web_view, pageZoom];
        let magnification: f64 = msg_send![web_view, magnification];
        let Value::Object(fields) = json!({
            "url": url,
            "webviewFrame": {
                "x": in_window.origin.x,
                "y": top,
                "width": in_window.size.width,
                "height": in_window.size.height,
            },
            "pageZoom": page_zoom,
            "magnification": magnification,
        }) else {
            unreachable!("a JSON object literal")
        };
        fields
    }
}

/// Start the script; its outcome goes to `reply` when WebKit calls back.
///
/// # Safety
///
/// Main thread; `web_view` is a live WKWebView.
unsafe fn call_async(
    web_view: *mut AnyObject,
    body: &str,
    args: &Map<String, Value>,
    reply: oneshot::Sender<Value>,
) -> Result<(), String> {
    unsafe {
        let world = page_world()?;
        // `args` as the named arguments: JSON → Foundation objects, which
        // WebKit hands the function as the same JavaScript values.
        let arguments: Option<Retained<AnyObject>> = if args.is_empty() {
            None
        } else {
            let bytes = serde_json::to_vec(args).map_err(|e| format!("args: {e}"))?;
            let data = NSData::with_bytes(&bytes);
            Some(
                NSJSONSerialization::JSONObjectWithData_options_error(&data, NSJSONReadingOptions::empty())
                    .map_err(|e| format!("args: {}", e.localizedDescription()))?,
            )
        };
        let arguments: *const AnyObject = arguments.as_deref().map_or(ptr::null(), |a| a as *const AnyObject);
        let source = NSString::from_str(body);
        // WebKit calls this once; the sender is taken out of the Mutex because
        // a block's closure is `Fn`.
        let reply = Mutex::new(Some(reply));
        let completion = RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
            // SAFETY (the enclosing `unsafe`): WebKit's own result and error,
            // valid for this call, on the main thread.
            let outcome = outcome_of(result, error);
            if let Some(reply) = reply.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = reply.send(outcome);
            }
        });
        // WebKit copies the block; ours can go when this returns.
        let _: () = msg_send![
            web_view,
            callAsyncJavaScript: &*source,
            arguments: arguments,
            inFrame: ptr::null::<AnyObject>(),
            inContentWorld: world,
            completionHandler: &*completion
        ];
        Ok(())
    }
}

/// The response body from WebKit's callback: the wrapper's JSON string, or an
/// error WebKit raised itself (a syntax error, the page going away).
///
/// # Safety
///
/// `result` and `error` are WebKit's, each an object or null.
unsafe fn outcome_of(result: *mut AnyObject, error: *mut AnyObject) -> Value {
    unsafe {
        if !error.is_null() {
            return json!({ "ok": false, "error": error_message(error) });
        }
        if result.is_null() {
            return json!({ "ok": false, "error": "the page returned nothing" });
        }
        let is_string: Bool = msg_send![result, isKindOfClass: NSString::class()];
        if !is_string.as_bool() {
            return json!({ "ok": false, "error": "the page returned an unexpected type" });
        }
        let text = (*result.cast::<NSString>()).to_string();
        match serde_json::from_str::<Value>(&text) {
            Ok(outcome) if outcome.get("ok").is_some_and(Value::is_boolean) => outcome,
            _ => json!({ "ok": false, "error": "the page returned an unexpected result" }),
        }
    }
}

/// A WebKit error's JavaScript exception message (`SyntaxError: …`), else its
/// description.
///
/// # Safety
///
/// `error` is a live NSError.
unsafe fn error_message(error: *mut AnyObject) -> String {
    unsafe {
        let user_info: *mut AnyObject = msg_send![error, userInfo];
        if !user_info.is_null() {
            let key = NSString::from_str("WKJavaScriptExceptionMessage");
            let message: *mut AnyObject = msg_send![user_info, objectForKey: &*key];
            if !message.is_null() {
                let is_string: Bool = msg_send![message, isKindOfClass: NSString::class()];
                if is_string.as_bool() {
                    return (*message.cast::<NSString>()).to_string();
                }
            }
        }
        let description: Option<Retained<NSString>> = msg_send![error, localizedDescription];
        description.map_or_else(|| "the script failed".to_string(), |d| d.to_string())
    }
}

/// The function body WebKit runs: the script as the body of an inner async
/// function (so `return` and `await` work and `args` are in scope as the outer
/// function's parameters), its outcome as a JSON string:
///
///   - `{"ok":true,"value":…}`; `undefined` becomes `null`;
///   - a throw: `{"ok":false,"error":<message>,"stack":<if any>}`;
///   - a value JSON can't carry faithfully (a DOM node, a function, a class
///     instance, a cycle): `{"ok":false,"error":"result is not JSON-serializable"}`.
///     Plain objects and arrays only, after `toJSON` (so a Date or a DOMRect
///     is fine).
///
/// The script goes on its own lines so a trailing `//` comment can't swallow
/// the wrapper.
fn wrap(script: &str) -> String {
    const BEFORE: &str = "let __ni_value;\ntry {\n__ni_value = await (async () => {\n";
    const AFTER: &str = r#"
})();
} catch (__ni_error) {
  let __ni_message = 'the script threw', __ni_stack;
  try {
    __ni_message = __ni_error instanceof Error
      ? String(__ni_error.message || __ni_error.name || 'Error')
      : String(__ni_error);
    if (__ni_error && typeof __ni_error.stack === 'string' && __ni_error.stack) __ni_stack = __ni_error.stack;
  } catch (_) {}
  return JSON.stringify(__ni_stack === undefined
    ? { ok: false, error: __ni_message }
    : { ok: false, error: __ni_message, stack: __ni_stack });
}
let __ni_json;
try {
  __ni_json = JSON.stringify(__ni_value === undefined ? null : __ni_value, function (_key, __ni_v) {
    const __ni_type = typeof __ni_v;
    if (__ni_type === 'function' || __ni_type === 'symbol' || __ni_type === 'bigint') throw 0;
    if (__ni_v !== null && __ni_type === 'object' && !Array.isArray(__ni_v)) {
      const __ni_proto = Object.getPrototypeOf(__ni_v);
      if (__ni_proto !== Object.prototype && __ni_proto !== null) throw 0;
    }
    return __ni_v;
  });
} catch (_) {
  return '{"ok":false,"error":"result is not JSON-serializable"}';
}
return '{"ok":true,"value":' + (__ni_json === undefined ? 'null' : __ni_json) + '}';
"#;
    [BEFORE, script, AFTER].concat()
}
