#pragma once

#include <stdbool.h>

/// Read selection aloud (src/read_selection.rs): a system-wide hotkey, and the
/// text selected in whichever app is frontmost.
///
/// Reading another app's selection needs the Accessibility permission, both
/// for the Accessibility API and for posting the ⌘C fallback. The hotkey
/// itself (Carbon RegisterEventHotKey) needs no permission.

/// Invoked on the main thread when the hotkey is pressed. Must return quickly.
typedef void (*selection_hotkey_cb)(void);

/// Register the system-wide hotkey (and start noting which app is in front,
/// for apps that copy on select): `keycode` is a virtual key code
/// (kVK_ANSI_R = 15), `carbon_mods` a Carbon modifier mask (cmdKey, optionKey,
/// controlKey, shiftKey). Replaces the previous one. Returns 0, or the
/// OSStatus RegisterEventHotKey failed with (another app holds the combo, or
/// macOS 15+ refused an Option-only / Option-Shift-only combo). Main thread.
int selection_hotkey_register(unsigned int keycode, unsigned int carbon_mods, selection_hotkey_cb cb);

/// Remove the hotkey, if one is registered. Main thread.
void selection_hotkey_unregister(void);

/// A shortcut with fn, which Carbon can't register: matched by an event tap
/// (Accessibility permission). `keycode` -1 is fn pressed and released on its
/// own; otherwise fn held with `carbon_mods` and that key. Replaces the
/// previous fn shortcut. Returns 0, or -1 when the tap can't be made. Main
/// thread.
int selection_fn_hotkey_register(int keycode, unsigned int carbon_mods, selection_hotkey_cb cb);

/// Remove the fn shortcut, if any. Main thread.
void selection_fn_hotkey_unregister(void);

/// The shortcut the user pressed while recording: `keycode` a virtual key
/// code, -1 for fn alone, -3 when cancelled (Esc, or
/// `selection_capture_cancel`); `carbon_mods` the modifiers held, `fn`
/// whether fn was, `typed` the character the key types (UTF-8, valid only
/// during the call). Main thread.
typedef void (*selection_capture_cb)(int keycode, unsigned int carbon_mods, bool fn, const char *typed);

/// Record the next shortcut pressed anywhere (the key is swallowed). Returns
/// 0, or -1 when the tap can't be made. Main thread.
int selection_capture_begin(selection_capture_cb cb);

/// Stop recording; the callback answers -3. Main thread.
void selection_capture_cancel(void);

/// Whether this process may use the Accessibility API. With `prompt`, macOS
/// shows its "would like to control this computer" prompt once (it never
/// prompts again after the first answer).
bool selection_accessibility_trusted(bool prompt);

/// Whether this process may post key events (the ⌘C fallback), a grant
/// separate from the Accessibility API's. With `request`, asks macOS for it,
/// at most once per launch.
bool selection_post_events_allowed(bool request);

/// Ask macOS for the key-event grant now (the settings page's "Allow access"),
/// however often it was asked before. True if granted.
bool selection_request_post_events(void);

/// How `selection_copy_text` found the text, or why it found none.
enum {
    SELECTION_NONE = 0,
    /// The focused element's AXSelectedText.
    SELECTION_ACCESSIBILITY = 1,
    /// The app's own Edit → Copy, pressed through Accessibility (the
    /// clipboard is put back after).
    SELECTION_COPY = 2,
    /// ⌘C posted to the frontmost app (the clipboard is put back after).
    SELECTION_KEYSTROKE = 3,
    /// Neither copy changed the clipboard, but it changed while the app was in
    /// front: an app that copies on select and ignores outside copies (Warp).
    SELECTION_COPIED_ON_SELECT = 4,
    /// As 4, and the text the clipboard held before the selection was put back.
    SELECTION_COPIED_ON_SELECT_RESTORED = 5,
    /// A password field has focus somewhere (secure input): nothing is read.
    SELECTION_SECURE_INPUT = -1,
    /// No Accessibility permission.
    SELECTION_UNTRUSTED = -2,
    /// The ⌘C left the clipboard as it was (the app has no Copy menu item):
    /// nothing selected, or the app ignored it.
    SELECTION_COPY_UNCHANGED = -3,
    /// The ⌘C put something on the clipboard, but no text.
    SELECTION_COPY_NO_TEXT = -4,
    /// The hotkey's modifiers were still held after 1.5 s.
    SELECTION_MODIFIERS_HELD = -5,
    /// The app's Copy menu item is disabled: it has nothing selected.
    SELECTION_COPY_DISABLED = -6,
    /// No Copy menu item, and macOS refuses this process posting key events.
    SELECTION_CANT_POST = -7,
    /// Neither Edit → Copy nor ⌘C changed the clipboard.
    SELECTION_COPY_UNCHANGED_BOTH = -8,
    /// Edit → Copy changed nothing, and macOS refuses posting key events.
    SELECTION_COPY_UNCHANGED_CANT_POST = -9,
};

/// The selected text of the frontmost app as malloc'd UTF-8 (free it with
/// `selection_free`), or NULL. Tries the Accessibility API first, then the
/// app's Edit → Copy, then ⌘C once the hotkey's modifiers are released.
/// `*out_source` is one of the codes above. Blocks for up to ~3 s (a slow
/// app's AX replies, the release, the copies), so never call it on the main
/// thread.
char *selection_copy_text(int *out_source);

/// The frontmost app's bundle id (else its name) as malloc'd UTF-8, for the
/// log; free it with `selection_free`.
char *selection_frontmost_app(void);

void selection_free(char *text);

/// The system alert sound: the hotkey's only feedback when there is nothing
/// to read. Any thread.
void selection_beep(void);
