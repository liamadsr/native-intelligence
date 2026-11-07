#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "selection_helper.h"

// ─── hotkey ─────────────────────────────────────────────────────────────────

static EventHotKeyRef g_hotkey = NULL;
static EventHandlerRef g_handler = NULL;
static selection_hotkey_cb g_cb = NULL;

static OSStatus on_hotkey(EventHandlerCallRef next, EventRef event, void *user_data) {
    (void)next;
    (void)event;
    (void)user_data;
    if (g_cb) g_cb();
    return noErr;
}

// ─── copy on select ─────────────────────────────────────────────────────────

/// The frontmost app, and the clipboard's change count when it came to the
/// front. Some apps copy on select (Warp, many terminals) and ignore every
/// copy another app asks for. When a copy changes nothing, a clipboard that
/// changed while the app was in front holds its selection.
static pid_t g_front_pid = 0;
static NSInteger g_front_change_count = 0;
static id g_activation_observer = nil;

static NSObject *state_lock(void) {
    static NSObject *lock;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ lock = [NSObject new]; });
    return lock;
}

static void note_front_app(NSRunningApplication *app) {
    @synchronized(state_lock()) {
        g_front_pid = app.processIdentifier;
        g_front_change_count = [NSPasteboard generalPasteboard].changeCount;
    }
}

static void watch_front_app(void) {
    if (g_activation_observer) return;
    note_front_app(NSWorkspace.sharedWorkspace.frontmostApplication);
    g_activation_observer = [NSWorkspace.sharedWorkspace.notificationCenter
        addObserverForName:NSWorkspaceDidActivateApplicationNotification
                    object:nil
                     queue:nil
                usingBlock:^(NSNotification *note) {
                    note_front_app(note.userInfo[NSWorkspaceApplicationKey]);
                }];
}

/// Whether the clipboard changed since `app` came to the front.
static bool clipboard_changed_while_front(NSRunningApplication *app, NSPasteboard *pasteboard) {
    @synchronized(state_lock()) {
        return app.processIdentifier == g_front_pid && pasteboard.changeCount != g_front_change_count;
    }
}

// ─── clipboard text history ─────────────────────────────────────────────────

/// Copying on select replaces whatever the user had copied, before the
/// shortcut is even pressed. So while the shortcut is on, the clipboard's
/// change count is checked a few times a second, and each new text (text
/// only) is kept with the app in front, so the text from before the
/// selection can be put back after reading it.
@interface D8ClipEntry : NSObject
@property(nonatomic, copy) NSString *text; // nil: not text
@property(nonatomic) pid_t pid;
@end
@implementation D8ClipEntry
@end

static const NSUInteger HISTORY_MAX = 12;
static const uint64_t HISTORY_POLL_NS = 250 * NSEC_PER_MSEC;
static NSMutableArray<D8ClipEntry *> *g_history = nil;
static NSInteger g_history_change_count = -1;
static dispatch_source_t g_history_timer = nil;
/// A read is copying and putting back: its own clipboard writes aren't the user's.
static bool g_reading = false;

/// macOS 15.4+ can show a paste prompt to apps the user hasn't allowed;
/// never risk that for a background read.
static bool may_read_clipboard_quietly(NSPasteboard *pasteboard) {
    if (@available(macOS 15.4, *)) return pasteboard.accessBehavior == NSPasteboardAccessBehaviorAlwaysAllow;
    return true;
}

static void record_clipboard(void) {
    @autoreleasepool {
        NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
        NSInteger count = pasteboard.changeCount;
        @synchronized(state_lock()) {
            if (count == g_history_change_count || g_reading) return;
        }
        if (!may_read_clipboard_quietly(pasteboard)) return;
        NSString *text = [pasteboard stringForType:NSPasteboardTypeString];
        @synchronized(state_lock()) {
            if (g_reading || pasteboard.changeCount != count) return;
            g_history_change_count = count;
            D8ClipEntry *entry = [D8ClipEntry new];
            entry.text = text;
            entry.pid = g_front_pid;
            D8ClipEntry *last = g_history.lastObject;
            if (last && last.pid == entry.pid && (last.text == text || [last.text isEqualToString:text])) return;
            [g_history addObject:entry];
            if (g_history.count > HISTORY_MAX) [g_history removeObjectAtIndex:0];
        }
    }
}

static void start_clipboard_history(void) {
    if (g_history_timer) return;
    g_history = [NSMutableArray array];
    dispatch_queue_t queue = dispatch_queue_create("ai.dial8.read-selection.clipboard", DISPATCH_QUEUE_SERIAL);
    g_history_timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
    dispatch_source_set_timer(g_history_timer, dispatch_time(DISPATCH_TIME_NOW, 0), HISTORY_POLL_NS, HISTORY_POLL_NS / 2);
    dispatch_source_set_event_handler(g_history_timer, ^{ record_clipboard(); });
    dispatch_resume(g_history_timer);
}

static void stop_clipboard_history(void) {
    if (!g_history_timer) return;
    dispatch_source_cancel(g_history_timer);
    g_history_timer = nil;
    @synchronized(state_lock()) {
        g_history = nil;
        g_history_change_count = -1;
    }
}

static NSString *trimmed(NSString *text) {
    return [text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}

/// After reading `selection` from an app's copy on select, put back the text
/// the clipboard held before it: the newest entry that isn't part of the
/// selection made in that app (a drag can write several partial selections).
/// Nothing when that entry wasn't text. True if put back.
static bool restore_text_before_selection(NSPasteboard *pasteboard, NSString *selection, pid_t pid) {
    NSString *whole = trimmed(selection);
    @synchronized(state_lock()) {
        D8ClipEntry *target = nil;
        for (D8ClipEntry *entry in g_history.reverseObjectEnumerator) {
            NSString *text = trimmed(entry.text);
            if (entry.pid == pid && text.length > 0 && [whole containsString:text]) continue;
            target = entry;
            break;
        }
        if (!target.text) return false;
        [pasteboard clearContents];
        [pasteboard setString:target.text forType:NSPasteboardTypeString];
        // Its own write, not a new copy.
        g_history_change_count = pasteboard.changeCount;
        g_front_change_count = pasteboard.changeCount;
        return true;
    }
}

int selection_hotkey_register(unsigned int keycode, unsigned int carbon_mods, selection_hotkey_cb cb) {
    watch_front_app();
    start_clipboard_history();
    if (!g_handler) {
        EventTypeSpec spec = {kEventClassKeyboard, kEventHotKeyPressed};
        OSStatus status = InstallApplicationEventHandler(&on_hotkey, 1, &spec, NULL, &g_handler);
        if (status != noErr) return (int)status;
    }
    if (g_hotkey) {
        UnregisterEventHotKey(g_hotkey);
        g_hotkey = NULL;
    }
    g_cb = cb;
    EventHotKeyID hotkey_id = {'D8RS', 1};
    OSStatus status = RegisterEventHotKey(keycode, carbon_mods, hotkey_id, GetApplicationEventTarget(), 0, &g_hotkey);
    if (status != noErr) g_hotkey = NULL;
    return (int)status;
}

void selection_hotkey_unregister(void) {
    stop_clipboard_history();
    if (g_hotkey) {
        UnregisterEventHotKey(g_hotkey);
        g_hotkey = NULL;
    }
}

// ─── fn shortcuts and recording (event tap) ─────────────────────────────────

/// Carbon hotkeys can't use fn, so a shortcut with fn (or fn alone) is
/// matched by an event tap instead, as is recording a shortcut. The tap
/// runs only while one of those needs it, on the main run loop. It needs
/// the Accessibility permission, which the feature already requires.
static CFMachPortRef g_tap = NULL;
static CFRunLoopSourceRef g_tap_source = NULL;
/// fn is physically down (tracked from its own key, not the event flag:
/// arrows and F-keys carry the fn flag on their own).
static bool g_fn_down = false;
/// Another key or modifier was pressed while fn was down: not fn alone.
static bool g_fn_used = false;
/// The fn shortcut: -2 none, -1 fn alone, else a virtual key code.
static int g_fn_keycode = -2;
static unsigned int g_fn_mods = 0;
static selection_hotkey_cb g_fn_cb = NULL;
/// The key whose key-up to swallow after a matched or recorded key-down.
static int g_swallow_up = -1;
static selection_capture_cb g_capture_cb = NULL;

static const unsigned int CARBON_CMD = 0x0100, CARBON_SHIFT = 0x0200, CARBON_OPTION = 0x0800, CARBON_CONTROL = 0x1000;

static unsigned int carbon_mods(CGEventFlags flags) {
    return ((flags & kCGEventFlagMaskCommand) ? CARBON_CMD : 0) | ((flags & kCGEventFlagMaskShift) ? CARBON_SHIFT : 0) |
           ((flags & kCGEventFlagMaskAlternate) ? CARBON_OPTION : 0) |
           ((flags & kCGEventFlagMaskControl) ? CARBON_CONTROL : 0);
}

static void tap_update(void);

static void finish_capture(int keycode, unsigned int mods, bool fn, const char *typed) {
    selection_capture_cb cb = g_capture_cb;
    g_capture_cb = NULL;
    tap_update();
    if (cb) cb(keycode, mods, fn, typed);
}

static CGEventRef on_tap(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *user_data) {
    (void)proxy;
    (void)user_data;
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        if (g_tap) CGEventTapEnable(g_tap, true);
        return event;
    }
    int key = (int)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    CGEventFlags flags = CGEventGetFlags(event);
    unsigned int mods = carbon_mods(flags);

    if (type == kCGEventFlagsChanged) {
        if (key == kVK_Function) {
            bool down = (flags & kCGEventFlagMaskSecondaryFn) != 0;
            if (down && !g_fn_down) {
                g_fn_down = true;
                g_fn_used = mods != 0;
            } else if (!down && g_fn_down) {
                g_fn_down = false;
                if (!g_fn_used && mods == 0) {
                    if (g_capture_cb) finish_capture(-1, 0, true, "");
                    else if (g_fn_keycode == -1 && g_fn_cb) g_fn_cb();
                }
            }
        } else if (g_fn_down) {
            g_fn_used = true;
        }
        return event;
    }

    if (type == kCGEventKeyUp) {
        if (key == g_swallow_up) {
            g_swallow_up = -1;
            return NULL;
        }
        return event;
    }

    if (type != kCGEventKeyDown) return event;
    if (g_fn_down) g_fn_used = true;
    bool repeat = CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) != 0;

    if (g_capture_cb) {
        if (repeat) return NULL;
        g_swallow_up = key;
        if (key == kVK_Escape && mods == 0 && !g_fn_down) {
            finish_capture(-3, 0, false, "");
            return NULL;
        }
        UniChar chars[8];
        UniCharCount length = 0;
        CGEventKeyboardGetUnicodeString(event, 8, &length, chars);
        NSString *typed = [NSString stringWithCharacters:chars length:length];
        finish_capture(key, mods, g_fn_down, typed.UTF8String ?: "");
        return NULL;
    }

    if (g_fn_cb && g_fn_keycode >= 0 && g_fn_down && key == g_fn_keycode && mods == g_fn_mods) {
        g_swallow_up = key;
        if (!repeat) g_fn_cb();
        return NULL;
    }
    return event;
}

/// Start the tap when something needs it, stop it when nothing does.
static void tap_update(void) {
    bool needed = g_capture_cb || g_fn_keycode != -2;
    if (needed && !g_tap) {
        CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) |
                           CGEventMaskBit(kCGEventFlagsChanged);
        g_tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, mask, on_tap, NULL);
        if (!g_tap) return;
        g_tap_source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, g_tap, 0);
        CFRunLoopAddSource(CFRunLoopGetMain(), g_tap_source, kCFRunLoopCommonModes);
        CGEventTapEnable(g_tap, true);
        g_fn_down = false;
        g_swallow_up = -1;
    } else if (!needed && g_tap) {
        // A key-up still owed a swallow never reaches a torn-down tap.
        g_swallow_up = -1;
        CGEventTapEnable(g_tap, false);
        CFRunLoopRemoveSource(CFRunLoopGetMain(), g_tap_source, kCFRunLoopCommonModes);
        CFRelease(g_tap_source);
        CFRelease(g_tap);
        g_tap_source = NULL;
        g_tap = NULL;
    }
}

int selection_fn_hotkey_register(int keycode, unsigned int carbon_mods_mask, selection_hotkey_cb cb) {
    g_fn_keycode = keycode;
    g_fn_mods = carbon_mods_mask;
    g_fn_cb = cb;
    tap_update();
    if (g_tap) return 0;
    g_fn_keycode = -2;
    g_fn_cb = NULL;
    return -1;
}

void selection_fn_hotkey_unregister(void) {
    g_fn_keycode = -2;
    g_fn_cb = NULL;
    tap_update();
}

int selection_capture_begin(selection_capture_cb cb) {
    g_capture_cb = cb;
    tap_update();
    if (g_tap) return 0;
    g_capture_cb = NULL;
    return -1;
}

void selection_capture_cancel(void) {
    if (g_capture_cb) finish_capture(-3, 0, false, "");
}

// ─── permission ─────────────────────────────────────────────────────────────

bool selection_accessibility_trusted(bool prompt) {
    NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @(prompt)};
    return AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
}

bool selection_post_events_allowed(bool request) {
    static bool requested = false;
    if (CGPreflightPostEventAccess()) return true;
    if (!request || requested) return false;
    requested = true;
    return CGRequestPostEventAccess();
}

bool selection_request_post_events(void) {
    return CGPreflightPostEventAccess() || CGRequestPostEventAccess();
}

// ─── selection ──────────────────────────────────────────────────────────────

/// Longest an app may take to answer one Accessibility request. A hung app
/// otherwise blocks the call for the system default of 6 s.
static const float AX_TIMEOUT_S = 0.4f;
/// How long the frontmost app gets to put its selection on the clipboard.
static const useconds_t COPY_POLL_US = 10000;
static const int COPY_POLLS = 25;
/// How long the user may keep holding the hotkey's modifiers before the ⌘C.
static const int RELEASE_POLLS = 150;
static const CGEventFlags HELD_MODIFIERS =
    kCGEventFlagMaskCommand | kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskShift |
    kCGEventFlagMaskSecondaryFn;

static NSString *non_blank(NSString *text) {
    if (!text) return nil;
    NSString *trimmed = [text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    return trimmed.length > 0 ? text : nil;
}

/// The focused element's selected text. Works in native AppKit apps
/// (Notes, Mail, Safari, Xcode, Terminal, iTerm2). Chromium and Electron
/// apps, and GPU terminals, mostly answer nothing here.
static NSString *ax_selected_text(void) {
    AXUIElementRef system = AXUIElementCreateSystemWide();
    if (!system) return nil;
    AXUIElementSetMessagingTimeout(system, AX_TIMEOUT_S);
    CFTypeRef focused = NULL;
    AXError err = AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute, &focused);
    CFRelease(system);
    if (err != kAXErrorSuccess || !focused) return nil;

    CFTypeRef value = NULL;
    err = AXUIElementCopyAttributeValue((AXUIElementRef)focused, kAXSelectedTextAttribute, &value);
    CFRelease(focused);
    if (err != kAXErrorSuccess || !value) return nil;
    if (CFGetTypeID(value) != CFStringGetTypeID()) {
        CFRelease(value);
        return nil;
    }
    return non_blank((__bridge_transfer NSString *)value);
}

/// Every item on the clipboard, with the data of every type it holds, so it
/// can be put back after the ⌘C.
static NSArray<NSPasteboardItem *> *snapshot(NSPasteboard *pasteboard) {
    NSMutableArray<NSPasteboardItem *> *items = [NSMutableArray array];
    for (NSPasteboardItem *item in pasteboard.pasteboardItems) {
        NSPasteboardItem *copy = [[NSPasteboardItem alloc] init];
        for (NSPasteboardType type in item.types) {
            NSData *data = [item dataForType:type];
            if (data) [copy setData:data forType:type];
        }
        [items addObject:copy];
    }
    return items;
}

/// Wait (up to 1.5 s) for the user to let go of the hotkey's modifiers.
/// macOS merges the modifiers physically held into a posted key event, so a
/// ⌘C sent while ⌃⌥ are still down reaches the app as ⌃⌥⌘C, which copies
/// nothing. False if they are still held.
static bool wait_for_modifiers_released(void) {
    for (int i = 0; i < RELEASE_POLLS; i++) {
        if ((CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState) & HELD_MODIFIERS) == 0) return true;
        usleep(COPY_POLL_US);
    }
    return false;
}

/// Gap between the posted ⌘C's events, so apps that track modifiers through
/// their own key-down/up events see each one land in order.
static const useconds_t KEY_GAP_US = 3000;

static void post_key(CGEventTapLocation tap, pid_t pid, CGEventSourceRef source, CGKeyCode key, bool down, CGEventFlags flags) {
    CGEventRef event = CGEventCreateKeyboardEvent(source, key, down);
    if (!event) return;
    CGEventSetFlags(event, flags);
    if (pid > 0) CGEventPostToPid(pid, event); else CGEventPost(tap, event);
    CFRelease(event);
    usleep(KEY_GAP_US);
}

/// Post ⌘C to the frontmost app as a real keyboard would: ⌘ down, C down,
/// C up, ⌘ up, from `state`'s source, at `tap` (or straight to `pid`).
/// A bare C with the ⌘ flag is not enough: apps that follow the ⌘ key's own
/// press, not the flag on C (Warp and other non-AppKit apps), see a plain
/// "c" and copy nothing.
static void post_copy(CGEventTapLocation tap, pid_t pid, CGEventSourceStateID state, bool with_command_key) {
    CGEventSourceRef source = CGEventSourceCreate(state);
    if (with_command_key) post_key(tap, pid, source, (CGKeyCode)kVK_Command, true, kCGEventFlagMaskCommand);
    post_key(tap, pid, source, (CGKeyCode)kVK_ANSI_C, true, kCGEventFlagMaskCommand);
    post_key(tap, pid, source, (CGKeyCode)kVK_ANSI_C, false, kCGEventFlagMaskCommand);
    if (with_command_key) post_key(tap, pid, source, (CGKeyCode)kVK_Command, false, 0);
    if (source) CFRelease(source);
}

static CFTypeRef copy_attribute(AXUIElementRef element, CFStringRef attribute) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess) return NULL;
    return value;
}

static NSArray *ax_children(AXUIElementRef element) {
    CFTypeRef value = copy_attribute(element, kAXChildrenAttribute);
    if (!value) return @[];
    if (CFGetTypeID(value) != CFArrayGetTypeID()) {
        CFRelease(value);
        return @[];
    }
    return (__bridge_transfer NSArray *)value;
}

/// The menu bar item that copies (its shortcut is plain ⌘C, whatever its
/// title's language), in the focused app: 1 pressed, -1 there but disabled
/// (the app has nothing selected), 0 not found. An app's own Edit → Copy
/// needs no synthetic keystroke, so it works in apps that ignore posted
/// keys (Warp).
static int press_copy_menu_item(void) {
    AXUIElementRef system = AXUIElementCreateSystemWide();
    if (!system) return 0;
    AXUIElementRef app = (AXUIElementRef)copy_attribute(system, kAXFocusedApplicationAttribute);
    CFRelease(system);
    if (!app) return 0;
    AXUIElementRef bar = (AXUIElementRef)copy_attribute(app, kAXMenuBarAttribute);
    CFRelease(app);
    if (!bar) return 0;

    int result = 0;
    for (id bar_item in ax_children(bar)) {
        for (id menu in ax_children((__bridge AXUIElementRef)bar_item)) {
            for (id item in ax_children((__bridge AXUIElementRef)menu)) {
                AXUIElementRef element = (__bridge AXUIElementRef)item;
                NSString *key = (__bridge_transfer NSString *)copy_attribute(element, kAXMenuItemCmdCharAttribute);
                NSNumber *mods = (__bridge_transfer NSNumber *)copy_attribute(element, kAXMenuItemCmdModifiersAttribute);
                // Modifiers 0 = ⌘ alone (kAXMenuItemModifierNone).
                bool is_cmd_c = [key isKindOfClass:NSString.class] && [key caseInsensitiveCompare:@"c"] == NSOrderedSame &&
                                [mods isKindOfClass:NSNumber.class] && mods.intValue == 0;
                // Some apps (Warp) don't expose the shortcut: the English title.
                NSString *title = is_cmd_c ? nil : (__bridge_transfer NSString *)copy_attribute(element, kAXTitleAttribute);
                if (!is_cmd_c && !([title isKindOfClass:NSString.class] && [title isEqualToString:@"Copy"])) continue;
                NSNumber *enabled = (__bridge_transfer NSNumber *)copy_attribute(element, kAXEnabledAttribute);
                if ([enabled isKindOfClass:NSNumber.class] && !enabled.boolValue) {
                    result = -1;
                } else {
                    result = AXUIElementPerformAction(element, kAXPressAction) == kAXErrorSuccess ? 1 : 0;
                }
                goto done;
            }
        }
    }
done:
    CFRelease(bar);
    return result;
}

static bool wait_for_change(NSPasteboard *pasteboard, NSInteger before) {
    for (int i = 0; i < COPY_POLLS && pasteboard.changeCount == before; i++) usleep(COPY_POLL_US);
    return pasteboard.changeCount != before;
}

/// Copy the selection, read it, and put the clipboard back as it was: the
/// app's own Edit → Copy, else ⌘C posted to it. Works almost everywhere
/// (every terminal, every browser), at the cost of a moment's use of the
/// clipboard. `*how` is the method on success, the reason on nil.
static NSString *copied_selected_text(int *how) {
    NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
    NSArray<NSPasteboardItem *> *saved = snapshot(pasteboard);
    NSInteger before = pasteboard.changeCount;

    int menu = press_copy_menu_item();
    bool changed = menu == 1 && wait_for_change(pasteboard, before);
    *how = SELECTION_COPY;
    if (!changed) {
        if (menu == -1) {
            *how = SELECTION_COPY_DISABLED;
            return nil;
        }
        // Posted keys need their own grant: with it refused they're dropped,
        // and the answer names the reason in the log.
        bool may_post = selection_post_events_allowed(true);
        if (!wait_for_modifiers_released()) {
            *how = SELECTION_MODIFIERS_HELD;
            return nil;
        }
        post_copy(kCGHIDEventTap, 0, kCGEventSourceStateHIDSystemState, true);
        changed = wait_for_change(pasteboard, before);
        *how = SELECTION_KEYSTROKE;
        if (!changed) {
            NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
            if (clipboard_changed_while_front(front, pasteboard)) {
                // The app's own copy (on select).
                NSString *text = non_blank([pasteboard stringForType:NSPasteboardTypeString]);
                *how = text && restore_text_before_selection(pasteboard, text, front.processIdentifier)
                           ? SELECTION_COPIED_ON_SELECT_RESTORED
                           : SELECTION_COPIED_ON_SELECT;
                return text;
            }
        }
        if (!changed && !may_post) {
            *how = menu == 1 ? SELECTION_COPY_UNCHANGED_CANT_POST : SELECTION_CANT_POST;
            return nil;
        }
    }
    // Nothing selected: the app put nothing on the clipboard, so there is
    // nothing to put back either.
    if (!changed) {
        *how = menu == 1 ? SELECTION_COPY_UNCHANGED_BOTH : SELECTION_COPY_UNCHANGED;
        return nil;
    }

    NSString *text = [pasteboard stringForType:NSPasteboardTypeString];
    [pasteboard clearContents];
    if (saved.count > 0) [pasteboard writeObjects:saved];
    @synchronized(state_lock()) {
        // The copy and the putting back were ours: not the app copying on
        // select, which a stale baseline would make the next empty read speak.
        g_front_change_count = pasteboard.changeCount;
    }
    if (!non_blank(text)) *how = SELECTION_COPY_NO_TEXT;
    return non_blank(text);
}

/// A Chromium browser or an Electron app (Claude, Slack, Teams, Discord, VS
/// Code…): their accessibility text runs a page's blocks together, a list's
/// items with no line between them ("…storyboard• Phase three…", "presetsEach
/// step"), so the voice garbled them and read-along lost its place (Liam,
/// 10-25). A copy keeps the lines, and these mostly answer nothing to
/// accessibility anyway.
static bool reads_web_content(NSRunningApplication *app) {
    if (!app) return false;
    static NSSet<NSString *> *browsers;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        browsers = [NSSet setWithArray:@[
            @"com.google.Chrome", @"com.google.Chrome.beta", @"com.google.Chrome.canary", @"org.chromium.Chromium",
            @"com.brave.Browser", @"com.microsoft.edgemac", @"company.thebrowser.Browser", @"com.vivaldi.Vivaldi",
            @"com.operasoftware.Opera",
        ]];
    });
    if (app.bundleIdentifier && [browsers containsObject:app.bundleIdentifier]) return true;
    NSURL *electron = [app.bundleURL URLByAppendingPathComponent:@"Contents/Frameworks/Electron Framework.framework"];
    return electron && [NSFileManager.defaultManager fileExistsAtPath:electron.path];
}

char *selection_copy_text(int *out_source) {
    int source = SELECTION_NONE;
    char *result = NULL;
    @autoreleasepool {
        NSString *text = nil;
        if (IsSecureEventInputEnabled()) {
            // A password field has focus somewhere: read nothing.
            source = SELECTION_SECURE_INPUT;
        } else if (!AXIsProcessTrusted()) {
            source = SELECTION_UNTRUSTED;
        } else if (!reads_web_content(NSWorkspace.sharedWorkspace.frontmostApplication) && (text = ax_selected_text())) {
            source = SELECTION_ACCESSIBILITY;
        } else {
            @synchronized(state_lock()) {
                g_reading = true;
            }
            text = copied_selected_text(&source);
            @synchronized(state_lock()) {
                g_reading = false;
                // The copy and the putting back were this read's, not the user's.
                g_history_change_count = [NSPasteboard generalPasteboard].changeCount;
            }
        }
        const char *utf8 = text.UTF8String;
        if (utf8) result = strdup(utf8);
    }
    if (out_source) *out_source = source;
    return result;
}

char *selection_frontmost_app(void) {
    @autoreleasepool {
        NSRunningApplication *app = NSWorkspace.sharedWorkspace.frontmostApplication;
        const char *utf8 = (app.bundleIdentifier ?: app.localizedName).UTF8String;
        return utf8 ? strdup(utf8) : NULL;
    }
}

void selection_free(char *text) {
    free(text);
}

void selection_beep(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSBeep();
    });
}
