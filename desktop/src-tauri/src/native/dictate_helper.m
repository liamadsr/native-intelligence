// Dictate anywhere: see dictate_helper.h. The spike that settled the approach:
// web/docs/plans/dictate-anywhere.md §6.
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <QuartzCore/QuartzCore.h>
#include <string.h>
#include <unistd.h>
#include "dictate_helper.h"

// Device-dependent modifier bits (IOLLEvent.h): which Option key is down.
#define NI_NX_DEVICERALTKEYMASK 0x00000040
/// When the clipboard is put back after ⌘V: late enough for the app to have read it.
static const double RESTORE_AFTER_SECONDS = 0.5;

static dictate_event_cb g_cb = NULL;
static CFMachPortRef g_tap = NULL;
static CFRunLoopSourceRef g_source = NULL;
/// When right Option went down (0: it isn't down).
static CFAbsoluteTime g_right_down_at = 0;
/// Something else happened while it was down: not a tap.
static bool g_other = false;
/// Dictation is listening: Esc is Native Intelligence's (it cancels), not the app's in front.
static volatile bool g_capture_escape = false;
/// The Esc whose key-down was kept back: its key-up is kept back too.
static bool g_escape_held_back = false;

static const CGEventFlags OTHER_MODIFIERS = kCGEventFlagMaskCommand | kCGEventFlagMaskControl |
                                            kCGEventFlagMaskShift | kCGEventFlagMaskSecondaryFn;

/// Something else happened while right ⌥ is held: say so once.
static void mark_other(void) {
    if (!g_other && g_cb) g_cb(DICTATE_EVENT_DIRTY);
    g_other = true;
}

static CGEventRef on_event(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *refcon) {
    (void)proxy;
    (void)refcon;
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        if (g_tap) CGEventTapEnable(g_tap, true);
        return event;
    }
    int64_t code = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    CGEventFlags flags = CGEventGetFlags(event);
    if (type == kCGEventFlagsChanged) {
        if (code == kVK_RightOption) {
            if (flags & NI_NX_DEVICERALTKEYMASK) {
                if (g_right_down_at > 0) return event; // a repeat: already down
                g_right_down_at = CFAbsoluteTimeGetCurrent();
                // Pressed with ⌘, ⌃, ⇧ or fn already held: a shortcut, not ours.
                g_other = (flags & OTHER_MODIFIERS) != 0;
                if (!g_other && g_cb) g_cb(DICTATE_EVENT_DOWN);
            } else if (g_right_down_at > 0) {
                g_right_down_at = 0;
                if (g_cb) g_cb(g_other ? DICTATE_EVENT_UP_DIRTY : DICTATE_EVENT_UP_CLEAN);
            }
        } else if (g_right_down_at > 0) {
            mark_other(); // left Option, ⌘, ⇧… pressed or released meanwhile
        }
    } else if (type == kCGEventKeyDown) {
        if (g_right_down_at > 0) mark_other(); // right ⌥ typing a character (⌥E, AltGr)
        if (code == kVK_Escape) {
            if (g_capture_escape) {
                // Listening: Esc cancels the dictation and goes no further, so it
                // doesn't also stop whatever the app in front is doing.
                g_escape_held_back = true;
                if (g_cb) g_cb(DICTATE_EVENT_ESCAPE);
                return NULL;
            }
            if (g_cb) g_cb(DICTATE_EVENT_ESCAPE);
        }
    } else if (type == kCGEventKeyUp) {
        if (code == kVK_Escape && g_escape_held_back) {
            g_escape_held_back = false;
            return NULL;
        }
    } else if (g_right_down_at > 0) {
        mark_other(); // a click while it's held
    }
    return event;
}

int dictate_tap_start(dictate_event_cb cb) {
    g_cb = cb;
    if (g_tap) return 0;
    CGEventMask mask = CGEventMaskBit(kCGEventFlagsChanged) | CGEventMaskBit(kCGEventKeyDown) |
                       CGEventMaskBit(kCGEventKeyUp) | CGEventMaskBit(kCGEventLeftMouseDown) |
                       CGEventMaskBit(kCGEventRightMouseDown);
    // An active tap, so Esc can be kept back while listening (dictate_set_capture_escape).
    // Every other event, and Esc at any other time, passes through untouched. Without
    // the permission for one, a listen-only tap: Esc then also reaches the app.
    g_tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, mask, on_event,
                             NULL);
    if (!g_tap) {
        g_tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, mask,
                                 on_event, NULL);
    }
    if (!g_tap) return -1;
    g_source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, g_tap, 0);
    CFRunLoopAddSource(CFRunLoopGetMain(), g_source, kCFRunLoopCommonModes);
    CGEventTapEnable(g_tap, true);
    return 0;
}

void dictate_tap_stop(void) {
    if (g_tap) {
        CGEventTapEnable(g_tap, false);
        if (g_source) {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), g_source, kCFRunLoopCommonModes);
            CFRelease(g_source);
            g_source = NULL;
        }
        CFMachPortInvalidate(g_tap);
        CFRelease(g_tap);
        g_tap = NULL;
    }
    g_right_down_at = 0;
    g_capture_escape = false;
    g_escape_held_back = false;
    g_cb = NULL;
}

void dictate_set_capture_escape(bool on) { g_capture_escape = on; }

int dictate_frontmost_pid(void) {
    @autoreleasepool {
        NSRunningApplication *app = [[NSWorkspace sharedWorkspace] frontmostApplication];
        return app ? (int)app.processIdentifier : 0;
    }
}

int dictate_char_before_caret(int pid) {
    if (pid <= 0) return -1;
    AXUIElementRef app = AXUIElementCreateApplication((pid_t)pid);
    if (!app) return -1;
    int result = -1;
    CFTypeRef focused = NULL;
    if (AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, &focused) == kAXErrorSuccess && focused) {
        CFTypeRef value = NULL;
        CFTypeRef range = NULL;
        if (AXUIElementCopyAttributeValue((AXUIElementRef)focused, kAXValueAttribute, &value) == kAXErrorSuccess &&
            value && CFGetTypeID(value) == CFStringGetTypeID() &&
            AXUIElementCopyAttributeValue((AXUIElementRef)focused, kAXSelectedTextRangeAttribute, &range) ==
                kAXErrorSuccess &&
            range) {
            CFRange r;
            if (AXValueGetValue((AXValueRef)range, kAXValueTypeCFRange, &r) && r.location > 0 &&
                r.location <= CFStringGetLength((CFStringRef)value)) {
                result = (int)CFStringGetCharacterAtIndex((CFStringRef)value, r.location - 1);
            }
        }
        if (value) CFRelease(value);
        if (range) CFRelease(range);
        CFRelease(focused);
    }
    CFRelease(app);
    return result;
}

// ── Learning from edits ──────────────────────────────────────────────────────

static pid_t g_watch_pid = 0;

void dictate_watch_end(void) { g_watch_pid = 0; }

/* The focused element of `pid`'s app, if it has text: its value and (if
 * `caret`) where the caret is. The caller releases the value. */
static CFStringRef focused_text(pid_t pid, int *caret) {
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    if (!app) return NULL;
    CFStringRef text = NULL;
    CFTypeRef focused = NULL;
    if (AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, &focused) == kAXErrorSuccess && focused) {
        CFTypeRef value = NULL;
        if (AXUIElementCopyAttributeValue((AXUIElementRef)focused, kAXValueAttribute, &value) == kAXErrorSuccess &&
            value && CFGetTypeID(value) == CFStringGetTypeID()) {
            text = (CFStringRef)CFRetain(value);
            if (caret) {
                CFTypeRef range = NULL;
                CFRange r;
                if (AXUIElementCopyAttributeValue((AXUIElementRef)focused, kAXSelectedTextRangeAttribute, &range) ==
                        kAXErrorSuccess &&
                    range && AXValueGetValue((AXValueRef)range, kAXValueTypeCFRange, &r) && r.location >= 0 &&
                    r.location <= CFStringGetLength(text)) {
                    *caret = (int)r.location;
                }
                if (range) CFRelease(range);
            }
        }
        if (value) CFRelease(value);
        CFRelease(focused);
    }
    CFRelease(app);
    return text;
}

int dictate_watch_begin(int pid) {
    dictate_watch_end();
    if (pid <= 0) return -1;
    AXUIElementRef app = AXUIElementCreateApplication((pid_t)pid);
    if (app) {
        // Chromium and Electron apps (Slack, Teams, Claude) build their
        // accessibility tree only for an assistive app that asks for it.
        AXUIElementSetAttributeValue(app, CFSTR("AXManualAccessibility"), kCFBooleanTrue);
        CFRelease(app);
    }
    g_watch_pid = (pid_t)pid;
    int caret = -1;
    CFStringRef text = focused_text((pid_t)pid, &caret);
    if (text) CFRelease(text);
    return caret;
}

/* The focused field of the pasted-into app, while it's in front. Not the very
 * element the paste went into: a web editor (Slack's) can swap its element
 * out; the text round the paste tells it's the same field (dictate.rs edits). */
char *dictate_watch_read(void) {
    if (!g_watch_pid || dictate_frontmost_pid() != g_watch_pid) return NULL;
    CFStringRef text = focused_text(g_watch_pid, NULL);
    if (!text) return NULL;
    CFIndex size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(text), kCFStringEncodingUTF8) + 1;
    char *out = malloc((size_t)size);
    if (out && !CFStringGetCString(text, out, size, kCFStringEncodingUTF8)) {
        free(out);
        out = NULL;
    }
    CFRelease(text);
    return out;
}

void dictate_copy(const char *text) {
    if (!text) return;
    @autoreleasepool {
        NSPasteboard *pb = [NSPasteboard generalPasteboard];
        [pb clearContents];
        [pb setString:[NSString stringWithUTF8String:text] forType:NSPasteboardTypeString];
    }
}

static NSArray<NSPasteboardItem *> *snapshot(NSPasteboard *pb) {
    NSMutableArray<NSPasteboardItem *> *items = [NSMutableArray array];
    for (NSPasteboardItem *item in pb.pasteboardItems) {
        NSPasteboardItem *copy = [[NSPasteboardItem alloc] init];
        for (NSPasteboardType type in item.types) {
            NSData *data = [item dataForType:type];
            if (data) [copy setData:data forType:type];
        }
        [items addObject:copy];
    }
    return items;
}

static void post_command_v(void) {
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
    CGEventRef down = CGEventCreateKeyboardEvent(source, (CGKeyCode)kVK_ANSI_V, true);
    CGEventRef up = CGEventCreateKeyboardEvent(source, (CGKeyCode)kVK_ANSI_V, false);
    CGEventSetFlags(down, kCGEventFlagMaskCommand);
    CGEventSetFlags(up, kCGEventFlagMaskCommand);
    CGEventPost(kCGHIDEventTap, down);
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(down);
    CFRelease(up);
    if (source) CFRelease(source);
}

int dictate_paste(int pid, const char *text) {
    if (!text) return DICTATE_PASTE_OK;
    @autoreleasepool {
        if (IsSecureEventInputEnabled()) {
            dictate_copy(text);
            return DICTATE_PASTE_SECURE_INPUT;
        }
        if (dictate_frontmost_pid() != pid) {
            dictate_copy(text);
            return DICTATE_PASTE_FOCUS_CHANGED;
        }
        if (!CGPreflightPostEventAccess()) {
            dictate_copy(text);
            return DICTATE_PASTE_NO_KEYS;
        }
        NSPasteboard *pb = [NSPasteboard generalPasteboard];
        NSArray<NSPasteboardItem *> *saved = snapshot(pb);
        NSString *ours = [NSString stringWithUTF8String:text];
        [pb clearContents];
        [pb setString:ours forType:NSPasteboardTypeString];
        post_command_v();
        // Put the person's clipboard back once the app has read ours, unless it
        // now holds something else (they copied meanwhile). Compared by
        // contents: an app or clipboard manager re-writing the same text bumps
        // the change count without anyone having copied anything.
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(RESTORE_AFTER_SECONDS * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
                         NSString *now = [pb stringForType:NSPasteboardTypeString];
                         if (now != nil && ![now isEqualToString:ours]) return;
                         [pb clearContents];
                         if (saved.count) [pb writeObjects:saved];
                       });
        return DICTATE_PASTE_OK;
    }
}

bool dictate_accessibility_trusted(void) { return AXIsProcessTrusted(); }

bool dictate_may_post_keys(void) { return CGPreflightPostEventAccess(); }

void dictate_beep(void) { NSBeep(); }

const char *dictate_window_class_chain(void *ns_window) {
    if (!ns_window) return strdup("(no window)");
    @autoreleasepool {
        NSMutableArray<NSString *> *names = [NSMutableArray array];
        for (Class c = object_getClass((__bridge id)ns_window); c != Nil && names.count < 6; c = class_getSuperclass(c)) {
            [names addObject:NSStringFromClass(c)];
        }
        return strdup([[names componentsJoinedByString:@" < "] UTF8String]);
    }
}

static void round_glass_in(NSView *view, CGFloat radius) {
    for (NSView *sub in view.subviews) {
        if ([sub isKindOfClass:[NSVisualEffectView class]]) {
            // The same (unlisted) setter Tauri's vibrancy uses when it builds the
            // glass; a layer's corners if this macOS hasn't it.
            if ([sub respondsToSelector:@selector(setCornerRadius:)]) {
                ((void (*)(id, SEL, CGFloat))objc_msgSend)(sub, @selector(setCornerRadius:), radius);
            } else {
                sub.wantsLayer = YES;
                sub.layer.cornerRadius = radius;
                sub.layer.masksToBounds = YES;
            }
        }
    }
}

// The glass's corners now, and the timer stepping the window (and them) to a
// new size (dictate_resize_window).
static CGFloat g_glass_radius = -1;
static NSTimer *g_frame_timer = nil;
static void stop_growing(void);

static void set_glass_now(NSWindow *window, CGFloat radius) {
    NSView *content = window.contentView;
    round_glass_in(content, radius);
    if (content.superview) round_glass_in(content.superview, radius);
    g_glass_radius = radius;
    [window invalidateShadow];
}

void dictate_set_glass_radius(void *ns_window, double radius) {
    if (!ns_window) return;
    @autoreleasepool {
        // Tauri's set_effects would add a second glass under the first (window-
        // vibrancy never removes the old one), leaving the card's corners
        // behind the circle: round the glass that is there instead.
        [g_frame_timer invalidate];
        g_frame_timer = nil;
        // A new card starts where it's put (show_panel), not where the last one was going.
        stop_growing();
        set_glass_now((__bridge NSWindow *)ns_window, radius);
    }
}

@interface DictateHoverWatcher : NSObject
@property(nonatomic) dictate_hover_cb callback;
@end

@implementation DictateHoverWatcher
- (void)mouseEntered:(NSEvent *)event {
    if (self.callback) self.callback(1);
}
- (void)mouseExited:(NSEvent *)event {
    if (self.callback) self.callback(0);
}
@end

static DictateHoverWatcher *g_hover = nil;

void dictate_watch_hover(void *ns_window, dictate_hover_cb cb) {
    if (!ns_window || g_hover) return;
    @autoreleasepool {
        NSWindow *window = (__bridge NSWindow *)ns_window;
        g_hover = [DictateHoverWatcher new];
        g_hover.callback = cb;
        // Active always: the panel is never the key window, nor Native Intelligence the
        // active app, while it's up.
        NSTrackingArea *area = [[NSTrackingArea alloc]
            initWithRect:NSZeroRect
                 options:NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways | NSTrackingInVisibleRect
                   owner:g_hover
                userInfo:nil];
        [window.contentView addTrackingArea:area];
    }
}

int dictate_hide_window(void *ns_window, int return_pid) {
    if (!ns_window) return 0;
    @autoreleasepool {
        NSWindow *window = (__bridge NSWindow *)ns_window;
        int seen = (NSApp.isActive ? 1 : 0) | (window.isKeyWindow ? 2 : 0);
        [window orderOut:nil];
        if (NSApp.isActive) seen |= 4;
        if ((seen & 4) && return_pid > 0 && return_pid != getpid()) {
            NSRunningApplication *back = [NSRunningApplication runningApplicationWithProcessIdentifier:return_pid];
            if (back && !back.terminated) {
                [back activateWithOptions:0];
                seen |= 8;
            }
        }
        return seen;
    }
}

// The words' growth curve, as CSS writes a cubic-bezier.
typedef struct {
    double x1, y1, x2, y2;
} DictateCurve;

/* The words growing the card: a quick ease-out. */
static const DictateCurve GROW = {0.33, 1.0, 0.68, 1.0};
static const NSTimeInterval GROW_SECONDS = 0.18;

/* Card → circle: one bounce, a little past the circle and back, on macOS's
 * own animator (a curve, not keyframes: the window's frame driven through 60
 * keyframes flickered up and down). Circle → card: a plain ease, no bounce (a
 * card that bounces looks broken). The page's glow takes the same time
 * (dictate-panel.tsx MORPH_MS). */
static const DictateCurve OPEN = {0.34, 1.45, 0.64, 1.0};
static const NSTimeInterval OPEN_SECONDS = 0.5;
static const DictateCurve CLOSE = {0.22, 1.0, 0.36, 1.0};
static const NSTimeInterval CLOSE_SECONDS = 0.32;

/* A CSS-style cubic-bezier at time `x` (0..1): its progress (may pass 1). */
static double bezier_at(double a, double b, double t) {
    double u = 1.0 - t;
    return 3.0 * u * u * t * a + 3.0 * u * t * t * b + t * t * t;
}

static double curve_progress(DictateCurve c, double x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    double lo = 0, hi = 1, t = x;
    for (int i = 0; i < 24; i++) {
        double at = bezier_at(c.x1, c.x2, t);
        if (fabs(at - x) < 1e-5) break;
        if (at < x) lo = t; else hi = t;
        t = (lo + hi) / 2.0;
    }
    return bezier_at(c.y1, c.y2, t);
}

static CAMediaTimingFunction *timing_of(DictateCurve c) {
    return [CAMediaTimingFunction functionWithControlPoints:(float)c.x1:(float)c.y1:(float)c.x2:(float)c.y2];
}

/* The card's corners, and the circle's (the panel page's CARD_RADIUS, CIRCLE,
 * CARD_TWO_LINES_H). Shared with the page as a rule of the size alone, so the
 * glass and the page round the same at every step of the wobble. */
static const double CARD_CORNER = 18, CARD_TALLEST = 66, CIRCLE_SIZE = 104;

static double corner_for(BOOL to_circle, double width, double height) {
    double most = fmin(width, height) / 2.0;
    if (to_circle) return most;
    double r = CARD_CORNER + fmax(0, height - CARD_TALLEST) * (CIRCLE_SIZE / 2.0 - CARD_CORNER) / (CIRCLE_SIZE - CARD_TALLEST);
    return fmax(0, fmin(most, r));
}

static double mix(double a, double b, double p) { return a + (b - a) * p; }

/* The web view keeps up with the window as it resizes: it redraws during the
 * resize rather than stretching its last frame, and its layer takes the new
 * size at once (window_helper.m, the main window's fix for the same lag). */
extern bool window_sync_webview_resize(void *ns_window);

/* The panel's web view (Wry's WKWebView, under the content view). */
static NSView *panel_webview(NSView *view) {
    if (!view) return nil;
    if ([view isKindOfClass:NSClassFromString(@"WKWebView")]) return view;
    for (NSView *sub in view.subviews) {
        NSView *found = panel_webview(sub);
        if (found) return found;
    }
    return nil;
}

/* The web view as it was before the change of shape's fix: the words growing
 * the card ease smoothly that way (Liam 10-25); the fix is for the shape. */
static BOOL g_webview_saved = NO;
static NSViewLayerContentsRedrawPolicy g_webview_policy;

static void clear_layer_actions(CALayer *layer) {
    if (!layer) return;
    layer.actions = nil;
    for (CALayer *sub in layer.sublayers) clear_layer_actions(sub);
}

static void webview_for_shape(NSWindow *window) {
    NSView *web = panel_webview(window.contentView);
    if (web && !g_webview_saved) {
        g_webview_policy = web.layerContentsRedrawPolicy;
        g_webview_saved = YES;
    }
    window_sync_webview_resize((__bridge void *)window);
}

static void webview_for_words(NSWindow *window) {
    NSView *web = panel_webview(window.contentView);
    if (!web || !g_webview_saved) return;
    web.layerContentsRedrawPolicy = g_webview_policy;
    clear_layer_actions(web.layer);
}

/* The words growing the card: the window's size follows them on a critically
 * damped spring (as fast as it can without going past), stepped each frame.
 * A new size while it moves turns it toward that size at the speed it already
 * has, so words coming in bursts make one flowing growth. (A fresh ease-out
 * per burst started fast and stopped dead each time: grow, stop, grow, stop.)
 * Sizes aren't rounded, so it moves in sub-pixel steps on a Retina screen. */
static const double GROW_OMEGA = 14.0; /* most of the way in about a quarter second */
static NSTimer *g_grow_timer = nil;
static double g_grow_w, g_grow_h, g_grow_vw, g_grow_vh, g_grow_tw, g_grow_th, g_grow_cx, g_grow_bottom;
static CFTimeInterval g_grow_last;

static void stop_growing(void) {
    [g_grow_timer invalidate];
    g_grow_timer = nil;
}

static void spring_step(double *x, double *v, double target, double dt) {
    *v += (GROW_OMEGA * GROW_OMEGA * (target - *x) - 2.0 * GROW_OMEGA * *v) * dt;
    *x += *v * dt;
}

static void grow_toward(NSWindow *window, double width, double height) {
    g_grow_tw = width;
    g_grow_th = height;
    if (g_grow_timer) return; // on its way already: it turns toward the new size
    NSRect f = window.frame;
    g_grow_w = f.size.width;
    g_grow_h = f.size.height;
    g_grow_vw = g_grow_vh = 0;
    // The bottom edge and the centre stay put: it grows up and out.
    g_grow_cx = NSMidX(f);
    g_grow_bottom = f.origin.y;
    g_grow_last = CACurrentMediaTime();
    __weak NSWindow *weak = window;
    g_grow_timer = [NSTimer
        timerWithTimeInterval:1.0 / 60.0
                      repeats:YES
                        block:^(NSTimer *timer) {
                          NSWindow *w = weak;
                          CFTimeInterval now = CACurrentMediaTime();
                          double dt = fmin(0.05, fmax(0, now - g_grow_last));
                          g_grow_last = now;
                          // Small steps, so it's steady whatever the frame time.
                          int steps = (int)ceil(dt / 0.004);
                          for (int i = 0; i < steps; i++) {
                              spring_step(&g_grow_w, &g_grow_vw, g_grow_tw, dt / steps);
                              spring_step(&g_grow_h, &g_grow_vh, g_grow_th, dt / steps);
                          }
                          BOOL settled = fabs(g_grow_tw - g_grow_w) < 0.25 && fabs(g_grow_th - g_grow_h) < 0.25 &&
                                         fabs(g_grow_vw) < 4 && fabs(g_grow_vh) < 4;
                          if (settled) {
                              g_grow_w = g_grow_tw;
                              g_grow_h = g_grow_th;
                          }
                          if (w) {
                              [w setFrame:NSMakeRect(g_grow_cx - g_grow_w / 2.0, g_grow_bottom, g_grow_w, g_grow_h)
                                  display:YES
                                  animate:NO];
                          }
                          if (!w || settled) {
                              [timer invalidate];
                              if (g_grow_timer == timer) g_grow_timer = nil;
                              [w invalidateShadow];
                          }
                        }];
    [[NSRunLoop mainRunLoop] addTimer:g_grow_timer forMode:NSRunLoopCommonModes];
}

void dictate_resize_window(void *ns_window, double width, double height, double radius) {
    if (!ns_window) return;
    @autoreleasepool {
        NSWindow *window = (__bridge NSWindow *)ns_window;
        // Mid-flight, from where it is now: a new size picks the motion up.
        [g_frame_timer invalidate];
        g_frame_timer = nil;
        window.animations = @{};
        NSRect from = window.frame;
        CGFloat r0 = g_glass_radius >= 0 ? g_glass_radius : (radius >= 0 ? radius : 0);
        CGFloat r1 = radius >= 0 ? radius : r0;
        BOOL reshape = fabs(r1 - r0) >= 0.5;
        if (!reshape) {
            // The words: the card follows them on a spring (grow_toward).
            webview_for_words(window);
            grow_toward(window, width, height);
            if (fabs(r1 - g_glass_radius) >= 0.5) set_glass_now(window, r1);
            return;
        }
        stop_growing();
        // Cocoa's origin is the bottom-left corner. The words keep the bottom
        // edge (and the centre) where they are, so the card grows up and out;
        // a change of shape keeps the middle, so it opens out evenly.
        CGFloat y = reshape ? round(NSMidY(from) - height / 2.0) : from.origin.y;
        NSRect to = NSMakeRect(round(NSMidX(from) - width / 2.0), y, width, height);
        if (NSEqualRects(from, to) && !reshape) return;

        if (reshape) webview_for_shape(window);
        else webview_for_words(window);
        BOOL to_circle = reshape && r1 > r0;
        DictateCurve curve = !reshape ? GROW : to_circle ? OPEN : CLOSE;
        NSTimeInterval duration = !reshape ? GROW_SECONDS : to_circle ? OPEN_SECONDS : CLOSE_SECONDS;
        [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
          context.duration = duration;
          context.timingFunction = timing_of(curve);
          [[window animator] setFrame:to display:YES];
        }
                            completionHandler:^{
                              [window invalidateShadow];
                            }];
        if (!reshape) {
            if (fabs(r1 - g_glass_radius) >= 0.5) set_glass_now(window, r1);
            return;
        }
        // The glass's corners alongside, on the same curve and clock, by the
        // page's rule (corner_for), at the size of the moment.
        CFTimeInterval start = CACurrentMediaTime();
        __weak NSWindow *weak = window;
        g_frame_timer = [NSTimer
            timerWithTimeInterval:1.0 / 60.0
                          repeats:YES
                            block:^(NSTimer *timer) {
                              NSWindow *w = weak;
                              double t = fmin(1.0, (CACurrentMediaTime() - start) / duration);
                              double p = curve_progress(curve, t);
                              if (w) {
                                  double fw = fmax(1, mix(from.size.width, to.size.width, p));
                                  double fh = fmax(1, mix(from.size.height, to.size.height, p));
                                  set_glass_now(w, corner_for(to_circle, fw, fh));
                              }
                              if (!w || t >= 1.0) {
                                  [timer invalidate];
                                  if (g_frame_timer == timer) g_frame_timer = nil;
                              }
                            }];
        [[NSRunLoop mainRunLoop] addTimer:g_frame_timer forMode:NSRunLoopCommonModes];
    }
}
