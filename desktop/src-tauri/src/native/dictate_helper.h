// Dictate anywhere (dial8-website/docs/plans/dictate-anywhere.md): the right-Option
// tap that starts and stops dictation, and the paste into the app being typed in.
#pragma once
#include <stdbool.h>

/// What the key watcher reports. The caller times the press: a quick clean
/// release is a tap, a long one a hold.
#define DICTATE_EVENT_ESCAPE 2     /* Esc pressed (any time; the caller decides) */
#define DICTATE_EVENT_DOWN 3       /* RIGHT Option pressed, alone */
#define DICTATE_EVENT_UP_CLEAN 4   /* released, nothing else meanwhile */
#define DICTATE_EVENT_UP_DIRTY 5   /* released after another key, modifier or click */
#define DICTATE_EVENT_DIRTY 6      /* another key, modifier or click while it's held (once per press) */

/// dictate_paste's answers. Anything but OK leaves the text on the clipboard.
#define DICTATE_PASTE_OK 0
#define DICTATE_PASTE_SECURE_INPUT -1  /* a password field: never typed into */
#define DICTATE_PASTE_FOCUS_CHANGED -2 /* another app is in front now */
#define DICTATE_PASTE_NO_KEYS -3       /* macOS refuses Dial8 posting ⌘V */

typedef void (*dictate_event_cb)(int event);

/// Start watching for the right-Option tap (a listen-only event tap: nothing is
/// swallowed). 0 on success, -1 when macOS gives no tap (the permission). Main thread.
int dictate_tap_start(dictate_event_cb cb);
/// Main thread.
void dictate_tap_stop(void);
/// While on (dictation listening), Esc is kept from the app in front: it only
/// cancels the dictation. Any thread.
void dictate_set_capture_escape(bool on);

/// The frontmost app's process id (0 when none).
int dictate_frontmost_pid(void);
/// The character before the caret in `pid`'s focused text field, or -1 when it
/// can't be read (no field, an app that doesn't share it, the very start).
int dictate_char_before_caret(int pid);

/* Learning from edits: the field a paste goes into, read again later.
 * Call `begin` just before the paste: it remembers the focused field of `pid`
 * and returns where the caret is (UTF-16 offset), or -1 (no readable field).
 * `read` returns that field's whole text now (malloc'd UTF-8; free it), or
 * NULL once it's gone: no longer the focused field, or its app not in front.
 * `end` lets it go. */
int dictate_watch_begin(int pid);
char *dictate_watch_read(void);
void dictate_watch_end(void);
/// Paste `text` into `pid`, which must still be frontmost: the clipboard is
/// saved, set, ⌘V posted, and put back ~0.5 s later unless it now holds
/// something else. Main thread.
int dictate_paste(int pid, const char *text);
/// Put `text` on the clipboard (when it can't be pasted).
void dictate_copy(const char *text);
bool dictate_accessibility_trusted(void);
bool dictate_may_post_keys(void);
void dictate_beep(void);
/// The window's class and its superclasses ("TaoWindow < NSWindow < …"), for the
/// log when it can't become a floating panel. Free with free().
const char *dictate_window_class_chain(void *ns_window);
/// Resize the panel to `width` × `height` (points), keeping its bottom edge and
/// centre, animated. Main thread.
/* Animate the window to width × height, keeping its bottom edge's centre, and
 * its glass's corners to `radius` alongside (a negative radius leaves them):
 * a change of shape (card ↔ circle) is slower, so it reads as a morph.
 * Main thread only. */
void dictate_resize_window(void *ns_window, double width, double height, double radius);
/* Tell `cb` when the mouse goes over the window (1) or leaves it (0), even
 * while another app is in front. Main thread only; once per window. */
typedef void (*dictate_hover_cb)(int inside);
void dictate_watch_hover(void *ns_window, dictate_hover_cb cb);
/* Round the window's frosted glass (its NSVisualEffectView) to `radius` and
 * redraw its shadow. Main thread only. */
void dictate_set_glass_radius(void *ns_window, double radius);
/* Hide the panel without leaving Dial8 in front: if hiding it left Dial8 the
 * active app while `return_pid` (the app the press began in) is another app,
 * that app is made active again. Returns what was so, for the log: 1 Dial8
 * was active before, 2 the panel was key, 4 Dial8 active after, 8 handed back.
 * Main thread only. */
int dictate_hide_window(void *ns_window, int return_pid);
