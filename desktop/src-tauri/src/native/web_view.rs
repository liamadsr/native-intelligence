//! The app's own web view inside a Tauri window, found by walking the
//! window's view tree. Used by the desktop automation bridge
//! (automation/webview.rs) to reach the main window's WKWebView.

// macOS-only; `native/mod.rs` gates the whole module on the target.

use std::ffi::c_void;

use objc2::msg_send;
use objc2::rc::autoreleasepool;
use objc2::runtime::{AnyClass, AnyObject, Bool};


/// The web view in `ns_window` (a Tauri window has one), found as
/// window_helper.m's `ni_find_webview` finds it: depth first from the
/// window's content view. None if there isn't one.
///
/// # Safety
///
/// `ns_window` is a live NSWindow (or null), and this runs on the main thread.
pub unsafe fn web_view_in(ns_window: *mut c_void) -> Option<*mut AnyObject> {
    let window = ns_window.cast::<AnyObject>();
    let wk_web_view = AnyClass::get(c"WKWebView")?;
    if window.is_null() {
        return None;
    }
    autoreleasepool(|_| {
        // SAFETY (each message here): NSWindow's, NSView's and NSArray's own
        // getters, with their signatures, on the main thread.
        let content: *mut AnyObject = unsafe { msg_send![window, contentView] };
        let mut views = vec![content];
        while let Some(view) = views.pop() {
            if view.is_null() {
                continue;
            }
            let is_web_view: Bool = unsafe { msg_send![view, isKindOfClass: wk_web_view] };
            if is_web_view.as_bool() {
                return Some(view);
            }
            let subviews: *mut AnyObject = unsafe { msg_send![view, subviews] };
            if subviews.is_null() {
                continue;
            }
            let count: usize = unsafe { msg_send![subviews, count] };
            // Pushed last to first, so they're looked at first to last.
            for i in (0..count).rev() {
                let subview: *mut AnyObject = unsafe { msg_send![subviews, objectAtIndex: i] };
                views.push(subview);
            }
        }
        None
    })
}
