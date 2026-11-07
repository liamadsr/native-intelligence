//! The retired in-app browser's data (dial8-website `docs/plans/cloud-browser.md`,
//! C5). Each workspace's tabs ran in a `WKWebsiteDataStore` of its own
//! (`+dataStoreForIdentifier:`, macOS 14+), which holds that workspace's
//! sign-ins, cookies and site storage. Nothing opens them now, and nothing else
//! can delete them, so they go at launch. The app's own web views use the
//! default store, which has no identifier (commands/workspace_window.rs), so
//! every identified store was the browser's. After the first launch the list
//! is empty; a store that fails to go is tried again at the next one.

// macOS-only; `native/mod.rs` gates the whole module on the target.

use block2::RcBlock;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::{msg_send, sel};

use crate::log_to_file;

/// Removes every identified website data store. Call on the main thread
/// (WebKit's own rule for these class methods); the work finishes in WebKit's
/// completion handlers.
pub fn remove_all() {
    let Some(store) = AnyClass::get(c"WKWebsiteDataStore") else { return };
    // SAFETY: NSObject's respondsToSelector:, on a class object.
    let available: Bool = unsafe { msg_send![store, respondsToSelector: sel!(fetchAllDataStoreIdentifiers:)] };
    if !available.as_bool() {
        // Before macOS 14 the browser couldn't have made one.
        return;
    }
    let fetched = RcBlock::new(move |identifiers: *mut AnyObject| {
        if identifiers.is_null() {
            return;
        }
        // SAFETY: an NSArray<NSUUID *> WebKit owns for the block's duration.
        let count: usize = unsafe { msg_send![identifiers, count] };
        if count > 0 {
            log_to_file(&format!("[browser] removing {count} retired data store(s)"));
        }
        for i in 0..count {
            let uuid: *mut AnyObject = unsafe { msg_send![identifiers, objectAtIndex: i] };
            let removed = RcBlock::new(move |error: *mut AnyObject| {
                if !error.is_null() {
                    log_to_file("[browser] a retired data store is still in use; trying again next launch");
                }
            });
            // SAFETY: +removeDataStoreForIdentifier:completionHandler: (macOS 14+,
            // checked above) with one of the identifiers WebKit just listed. It
            // copies the block, so ours may drop at the end of this iteration.
            unsafe {
                let _: () = msg_send![store, removeDataStoreForIdentifier: uuid, completionHandler: &*removed];
            }
        }
    });
    // SAFETY: +fetchAllDataStoreIdentifiers: (macOS 14+, checked above), which
    // copies the block.
    unsafe {
        let _: () = msg_send![store, fetchAllDataStoreIdentifiers: &*fetched];
    }
}
