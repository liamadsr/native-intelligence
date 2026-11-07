#import "window_helper.h"
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <math.h>
#import <dlfcn.h>

// App background tokens, mirrored from the web app's tailwind.css:
//   --background dark : hsl(230 30% 6%)  -> rgb(11, 12, 20)
//   --background light: hsl(225 30% 98%) -> rgb(248, 249, 251)
// Keep these in sync with src/styles/tailwind.css so the live-resize gap is
// indistinguishable from the rendered page.
static NSColor *dial8_background_for_appearance(NSAppearance *appearance) {
    BOOL isDark = NO;
    if (appearance != nil) {
        NSAppearanceName best = [appearance bestMatchFromAppearancesWithNames:@[
            NSAppearanceNameAqua,
            NSAppearanceNameDarkAqua,
        ]];
        isDark = [best isEqualToString:NSAppearanceNameDarkAqua];
    }

    if (isDark) {
        return [NSColor colorWithSRGBRed:(11.0 / 255.0)
                                   green:(12.0 / 255.0)
                                    blue:(20.0 / 255.0)
                                   alpha:1.0];
    }
    return [NSColor colorWithSRGBRed:(248.0 / 255.0)
                               green:(249.0 / 255.0)
                                blue:(251.0 / 255.0)
                               alpha:1.0];
}

bool window_apply_background(void *ns_window) {
    if (ns_window == NULL) {
        return false;
    }

    @autoreleasepool {
        NSWindow *window = (__bridge NSWindow *)ns_window;
        NSColor *bg = dial8_background_for_appearance(window.effectiveAppearance);

        // Painting the window background opaque means the brief pre-repaint gap
        // during live resize shows this color instead of the default white.
        window.opaque = YES;
        window.backgroundColor = bg;

        // The WKWebView's host view sits on the window's contentView. Give that
        // view (and its backing layer) the same base color so any uncovered
        // region during reflow matches too, rather than flashing the layer's
        // default (transparent -> white) fill.
        NSView *content = window.contentView;
        if (content != nil) {
            content.wantsLayer = YES;
            if (content.layer != nil) {
                content.layer.backgroundColor = bg.CGColor;
            }
        }

        return true;
    }
}

// Forward declaration — defined below.
static WKWebView *dial8_find_webview(NSView *view);

bool window_clear_background(void *ns_window) {
    if (ns_window == NULL) {
        return false;
    }

    @autoreleasepool {
        NSWindow *window = (__bridge NSWindow *)ns_window;

        // The window itself: non-opaque + clear fill. `.transparent(true)` on the
        // Tauri side sets the WKWebView's drawsBackground to NO, but the NSWindow
        // keeps an opaque default (white) backing that a repaint re-exposes.
        window.opaque = NO;
        window.backgroundColor = [NSColor clearColor];

        // Clear the contentView's backing-layer fill (otherwise it's an opaque
        // white square behind the web content during/after a repaint).
        NSView *content = window.contentView;
        if (content != nil) {
            content.wantsLayer = YES;
            if (content.layer != nil) {
                content.layer.opaque = NO;
                content.layer.backgroundColor = [NSColor clearColor].CGColor;
            }
        }

        // The WKWebView's own host layer is the surface that actually flashes
        // white on a theme switch — clear it AND tell WebKit not to draw its
        // background so the page's transparent body shows the desktop through.
        WKWebView *webView = dial8_find_webview(content);
        if (webView != nil) {
            // Available on modern WebKit; guarded so older SDKs still compile.
            if ([webView respondsToSelector:@selector(setValue:forKey:)]) {
                @try { [webView setValue:@NO forKey:@"drawsBackground"]; }
                @catch (__unused NSException *e) {}
            }
            webView.layer.opaque = NO;
            webView.layer.backgroundColor = [NSColor clearColor].CGColor;
        }

        return true;
    }
}

// Depth-first search for the (Wry-subclassed) WKWebView under a view — the
// APP's web view.
static WKWebView *dial8_find_webview(NSView *view) {
    if (view == nil) {
        return nil;
    }
    if ([view isKindOfClass:[WKWebView class]]) {
        return (WKWebView *)view;
    }
    for (NSView *sub in view.subviews) {
        WKWebView *found = dial8_find_webview(sub);
        if (found != nil) {
            return found;
        }
    }
    return nil;
}

// An actions dictionary that returns NSNull for the layer-geometry keys, which
// tells CoreAnimation to run NO implicit animation for those changes — the
// layer jumps straight to its new bounds/position/frame.
static NSDictionary *dial8_no_implicit_actions(void) {
    id null = [NSNull null];
    return @{
        @"bounds": null,
        @"position": null,
        @"frame": null,
        @"contents": null,
        @"sublayers": null,
        @"onLayout": null,
    };
}

// Recursively disable implicit animations on a layer and its sublayers so a
// geometry change snaps instead of easing over the default ~0.25s.
static void dial8_disable_layer_animations(CALayer *layer) {
    if (layer == nil) {
        return;
    }
    layer.actions = dial8_no_implicit_actions();
    for (CALayer *sub in layer.sublayers) {
        dial8_disable_layer_animations(sub);
    }
}

bool window_sync_webview_resize(void *ns_window) {
    if (ns_window == NULL) {
        return false;
    }

    @autoreleasepool {
        NSWindow *window = (__bridge NSWindow *)ns_window;
        WKWebView *webView = dial8_find_webview(window.contentView);
        if (webView == nil) {
            // The web view may not be attached yet on the first call; the caller
            // retries after the window is shown.
            return false;
        }

        // Redraw the layer contents during a live resize instead of stretching a
        // stale bitmap (which looks like the page "snapping" once it catches up).
        webView.layerContentsRedrawPolicy = NSViewLayerContentsRedrawDuringViewResize;

        // Kill the implicit CoreAnimation geometry animation so the web view's
        // backing layer tracks the window frame synchronously on maximize/zoom.
        if (webView.layer != nil) {
            dial8_disable_layer_animations(webView.layer);
        }

        return true;
    }
}

// A window subclass that performs zoom (green-button / double-click-title-bar
// maximize) as a single instant frame change instead of an animated grow.
//
// The animated maximize sends the WKWebView hundreds of intermediate sizes; on
// macOS the web content relayouts a beat behind each one, so the page visibly
// trails the window for the whole animation. Doing the zoom in one jump gives
// WebKit a single resize to lay out (~one frame of catch-up) — the content
// fills the window effectively immediately.
//
// We override setFrame:display:animate: to force animate:NO. This is the method
// AppKit routes zoom through, so it suppresses the grow animation without us
// having to reimplement zoom geometry.
static IMP gOriginalSetFrameDisplayAnimate = NULL;

static void dial8_setFrameDisplayAnimate(id self, SEL _cmd, NSRect frame, BOOL display, BOOL animate) {
    typedef void (*SetFrameFn)(id, SEL, NSRect, BOOL, BOOL);
    if (gOriginalSetFrameDisplayAnimate != NULL) {
        ((SetFrameFn)gOriginalSetFrameDisplayAnimate)(self, _cmd, frame, display, NO);
    }
}

bool window_disable_zoom_animation(void *ns_window) {
    if (ns_window == NULL) {
        return false;
    }

    @autoreleasepool {
        NSWindow *window = (__bridge NSWindow *)ns_window;

        // Swizzle setFrame:display:animate: on this window's actual class so the
        // override applies to the Tauri/Wry window instance. Idempotent: once the
        // original IMP is captured we don't re-swizzle.
        if (gOriginalSetFrameDisplayAnimate == NULL) {
            Class cls = object_getClass(window);
            SEL sel = @selector(setFrame:display:animate:);
            Method m = class_getInstanceMethod(cls, sel);
            if (m == NULL) {
                return false;
            }
            // `m` is NSWindow's own method when the class doesn't override
            // it, and setting its IMP would change every window in the
            // process (panels, alerts). Add the override to this class
            // instead; replace in place only when the class defines it.
            IMP original = method_getImplementation(m);
            if (class_addMethod(cls, sel, (IMP)dial8_setFrameDisplayAnimate, method_getTypeEncoding(m))) {
                gOriginalSetFrameDisplayAnimate = original;
            } else {
                gOriginalSetFrameDisplayAnimate = method_setImplementation(m, (IMP)dial8_setFrameDisplayAnimate);
            }
        }

        return true;
    }
}

// Shrink + vertically center the three standard window buttons (traffic lights).
//
// macOS draws each light to fill its NSButton's bounds, so resizing the button
// resizes the light. The buttons live in a shared, NON-flipped superview (y
// grows upward), so to put a button's vertical center at `center_y` points
// *below the window top* we place its origin at:
//     origin.y = superviewHeight - center_y - diameter/2
// We re-pack the row horizontally from a fixed left inset with a gap scaled to
// the (smaller) diameter, otherwise the native spacing looks too wide once the
// buttons shrink. Frames are only touched when they actually differ, and all
// changes run inside a CATransaction with implicit actions disabled, so calling
// this on every resize event neither thrashes layout nor flickers.
bool window_style_traffic_lights(void *ns_window, double diameter, double center_y) {
    if (ns_window == NULL || diameter <= 0.0) {
        return false;
    }

    @autoreleasepool {
        NSWindow *window = (__bridge NSWindow *)ns_window;

        NSButton *close = [window standardWindowButton:NSWindowCloseButton];
        NSButton *miniaturize = [window standardWindowButton:NSWindowMiniaturizeButton];
        NSButton *zoom = [window standardWindowButton:NSWindowZoomButton];
        if (close == nil || miniaturize == nil || zoom == nil) {
            return false;
        }

        NSView *container = close.superview;
        if (container == nil) {
            return false;
        }

        // Left inset of the first light from the window edge, and the gap
        // between lights. Scaled off the diameter so the cluster keeps the
        // familiar macOS proportions at the smaller size.
        const CGFloat leftInset = 13.0;
        const CGFloat gap = diameter * 0.5 + 2.0;
        const CGFloat containerH = container.bounds.size.height;
        const CGFloat originY = containerH - center_y - diameter / 2.0;

        NSButton *order[3] = { close, miniaturize, zoom };

        BOOL changed = NO;
        for (int i = 0; i < 3; i++) {
            CGFloat x = leftInset + (CGFloat)i * (diameter + gap);
            NSRect target = NSMakeRect(x, originY, diameter, diameter);
            if (!NSEqualRects(order[i].frame, target)) {
                changed = YES;
                break;
            }
        }
        if (!changed) {
            // Already styled — avoid redundant layout work on every resize tick.
            return true;
        }

        [CATransaction begin];
        [CATransaction setDisableActions:YES];
        for (int i = 0; i < 3; i++) {
            CGFloat x = leftInset + (CGFloat)i * (diameter + gap);
            // Set size first, then origin, both explicitly — using setFrame:
            // alone lets AppKit's title-bar layout rescale the button back to
            // the system size on the next pass.
            [order[i] setFrameSize:NSMakeSize(diameter, diameter)];
            [order[i] setFrameOrigin:NSMakePoint(x, originY)];
        }
        [CATransaction commit];

        return true;
    }
}

// The agent HUD as a non-activating panel (window_helper.h,
// window_make_overlay_panel). The panel class is made at runtime, once per
// window class, as an NSPanel subclass that carries over everything the
// window's own class (tao's TaoWindow) adds to NSWindow: its methods
// (canBecomeKeyWindow, which reads tao's `focusable`, and sendEvent:, which
// drags a movable-by-background window) and its ivars, by name, as tao reads
// them. So tao's set_focusable and dragging still work on the swapped window.
// It never becomes main: a panel shouldn't take Dial8's menu bar. Main thread
// only (objc_getClass then objc_allocateClassPair isn't atomic).
static BOOL dial8_overlay_panel_no(id self, SEL _cmd) { return NO; }

static Class dial8_overlay_panel_class(Class source) {
    char name[256];
    snprintf(name, sizeof name, "Dial8OverlayPanel_%s", class_getName(source));
    Class existing = objc_getClass(name);
    if (existing != Nil) {
        return existing;
    }
    Class made = objc_allocateClassPair([NSPanel class], name, 0);
    if (made == Nil) {
        return Nil;
    }

    unsigned int count = 0;
    Ivar *ivars = class_copyIvarList(source, &count);
    for (unsigned int i = 0; i < count; i++) {
        const char *type = ivar_getTypeEncoding(ivars[i]);
        NSUInteger size = 0, align = 0;
        NSGetSizeAndAlignment(type, &size, &align);
        if (!class_addIvar(made, ivar_getName(ivars[i]), size, (uint8_t)log2(align), type)) {
            free(ivars);
            objc_disposeClassPair(made);
            return Nil;
        }
    }
    free(ivars);

    Method *methods = class_copyMethodList(source, &count);
    for (unsigned int i = 0; i < count; i++) {
        class_addMethod(made, method_getName(methods[i]), method_getImplementation(methods[i]),
                        method_getTypeEncoding(methods[i]));
    }
    free(methods);

    // BOOL is `signed char` on x86_64 and `bool` on arm64: encode it.
    char types[8];
    snprintf(types, sizeof types, "%s@:", @encode(BOOL));
    class_replaceMethod(made, @selector(canBecomeMainWindow), (IMP)dial8_overlay_panel_no, types);
    objc_registerClassPair(made);
    return made;
}

// Whether `cls` itself defines `sel` (not just inherits it).
static bool dial8_class_defines(Class cls, SEL sel) {
    unsigned int count = 0;
    Method *methods = class_copyMethodList(cls, &count);
    bool found = false;
    for (unsigned int i = 0; i < count && !found; i++) {
        found = method_getName(methods[i]) == sel;
    }
    free(methods);
    return found;
}

// Whether each of `from`'s own ivars sits at the same offset in `to`, so a
// window re-classed from one to the other keeps its values where its methods
// look for them.
static bool dial8_ivars_line_up(Class from, Class to) {
    unsigned int count = 0;
    Ivar *ivars = class_copyIvarList(from, &count);
    bool same = true;
    for (unsigned int i = 0; i < count && same; i++) {
        Ivar there = class_getInstanceVariable(to, ivar_getName(ivars[i]));
        same = there != NULL && ivar_getOffset(there) == ivar_getOffset(ivars[i]);
    }
    free(ivars);
    return same;
}

int window_make_overlay_panel(void *ns_window) {
    if (ns_window == NULL) {
        return DIAL8_OVERLAY_NOT_A_PLAIN_WINDOW;
    }

    @autoreleasepool {
        NSWindow *window = (__bridge NSWindow *)ns_window;
        // Stay up when the user hides Dial8 (Cmd+H): the HUD is for the call,
        // not the app. Applies to a plain window too, so it's set either way.
        window.canHide = NO;

        Class current = object_getClass(window);
        if (![current isSubclassOfClass:[NSPanel class]]) {
            // Only tao's own window class, straight off NSWindow: anything
            // else (a KVO subclass, say) would be copied wrong.
            if (class_getSuperclass(current) != [NSWindow class]) {
                return DIAL8_OVERLAY_NOT_A_PLAIN_WINDOW;
            }
            // Its methods are copied as they are: one that tears the object
            // down would run against the panel's layout. tao defines none.
            if (dial8_class_defines(current, NSSelectorFromString(@"dealloc"))
                || dial8_class_defines(current, NSSelectorFromString(@".cxx_destruct"))
                || dial8_class_defines(current, NSSelectorFromString(@".cxx_construct"))) {
                return DIAL8_OVERLAY_CLASS_NOT_COPYABLE;
            }
            Class panelClass = dial8_overlay_panel_class(current);
            // object_setClass reinterprets the existing allocation: the new
            // class must fit in it, and keep tao's ivars where they were.
            if (panelClass == Nil
                || class_getInstanceSize(panelClass) > class_getInstanceSize(current)
                || !dial8_ivars_line_up(current, panelClass)) {
                return DIAL8_OVERLAY_DID_NOT_FIT;
            }
            object_setClass(window, panelClass);
        }

        NSPanel *panel = (NSPanel *)window;
        panel.styleMask |= NSWindowStyleMaskNonactivatingPanel;
        // Setting the non-activating style after the window exists doesn't
        // reach the window server on its own: a click would still activate
        // Dial8 (and pull the user out of their full-screen call). This private
        // setter is what the style sets at creation; skipped where it's gone.
        SEL preventsActivation = NSSelectorFromString(@"_setPreventsActivation:");
        if ([panel respondsToSelector:preventsActivation]) {
            ((void (*)(id, SEL, BOOL))objc_msgSend)(panel, preventsActivation, YES);
        }
        panel.hidesOnDeactivate = NO;
        panel.floatingPanel = YES;
        panel.level = NSFloatingWindowLevel;
        panel.collectionBehavior = (panel.collectionBehavior
                                    & ~(NSWindowCollectionBehaviorMoveToActiveSpace
                                        | NSWindowCollectionBehaviorFullScreenPrimary))
                                   | NSWindowCollectionBehaviorCanJoinAllSpaces
                                   | NSWindowCollectionBehaviorFullScreenAuxiliary;
        return DIAL8_OVERLAY_OK;
    }
}

void window_order_front_without_focus(void *ns_window) {
    if (ns_window == NULL) {
        return;
    }

    @autoreleasepool {
        NSWindow *window = (__bridge NSWindow *)ns_window;
        [window orderFrontRegardless];
    }
}

// The window server's per-window background blur (window_helper.h,
// window_set_backdrop). Private SkyLight API, exported by CoreGraphics; looked
// up at run time so a macOS without it loses only the blur, never the launch.
typedef int32_t (*Dial8CGSMainConnectionID)(void);
typedef int32_t (*Dial8CGSSetWindowBackgroundBlurRadius)(int32_t connection, NSInteger window_number, int radius);

static bool dial8_set_window_blur(NSWindow *window, int radius) {
    static Dial8CGSMainConnectionID mainConnection = NULL;
    static Dial8CGSSetWindowBackgroundBlurRadius setBlur = NULL;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        mainConnection = (Dial8CGSMainConnectionID)dlsym(RTLD_DEFAULT, "CGSMainConnectionID");
        setBlur = (Dial8CGSSetWindowBackgroundBlurRadius)dlsym(RTLD_DEFAULT, "CGSSetWindowBackgroundBlurRadius");
    });
    if (mainConnection == NULL || setBlur == NULL || window.windowNumber <= 0) {
        return false;
    }
    return setBlur(mainConnection(), window.windowNumber, radius < 0 ? 0 : radius) == 0;
}

int window_set_backdrop(void *ns_window, int mode, int blur_radius) {
    if (ns_window == NULL) {
        return DIAL8_BACKDROP_NO_WINDOW;
    }

    @autoreleasepool {
        NSWindow *window = (__bridge NSWindow *)ns_window;
        WKWebView *webView = dial8_find_webview(window.contentView);
        if (webView == nil) {
            return DIAL8_BACKDROP_NO_WEBVIEW;
        }

        if (mode == DIAL8_BACKDROP_MODE_OFF) {
            dial8_set_window_blur(window, 0);
            @try { [webView setValue:@YES forKey:@"drawsBackground"]; }
            @catch (__unused NSException *e) {}
            window_apply_background(ns_window);
            [window invalidateShadow];
            return DIAL8_BACKDROP_OK;
        }

        // Transparent window, content layer and web view (as the HUDs), then
        // the blur behind it.
        window_clear_background(ns_window);
        dial8_set_window_blur(window, blur_radius);

        // A non-opaque window's shadow follows its content's alpha: recompute it.
        [window invalidateShadow];
        return DIAL8_BACKDROP_OK;
    }
}

// The panel Glass layer (window_helper.h, window_set_glass_panel), found again
// by this identifier so repeated calls reuse one view.
static NSString *const kDial8GlassPanelIdentifier = @"dial8-glass-panel";

static NSVisualEffectView *dial8_find_glass_panel(NSView *host) {
    for (NSView *sub in host.subviews) {
        if ([sub isKindOfClass:[NSVisualEffectView class]]
            && [sub.identifier isEqualToString:kDial8GlassPanelIdentifier]) {
            return (NSVisualEffectView *)sub;
        }
    }
    return nil;
}

// A stretchable rounded-rect mask: corners of `radius`, the middle stretched.
static NSImage *dial8_rounded_mask(CGFloat radius) {
    CGFloat side = radius * 2.0 + 1.0;
    NSImage *mask = [NSImage imageWithSize:NSMakeSize(side, side)
                                   flipped:NO
                            drawingHandler:^BOOL(NSRect rect) {
        [[NSColor blackColor] setFill];
        [[NSBezierPath bezierPathWithRoundedRect:rect xRadius:radius yRadius:radius] fill];
        return YES;
    }];
    mask.capInsets = NSEdgeInsetsMake(radius, radius, radius, radius);
    mask.resizingMode = NSImageResizingModeStretch;
    return mask;
}

int window_set_glass_panel(void *ns_window, int on, int appearance, double corner_radius) {
    if (ns_window == NULL) {
        return DIAL8_BACKDROP_NO_WINDOW;
    }

    @autoreleasepool {
        NSWindow *window = (__bridge NSWindow *)ns_window;
        WKWebView *webView = dial8_find_webview(window.contentView);
        NSView *host = webView.superview;
        if (webView == nil || host == nil) {
            return DIAL8_BACKDROP_NO_WEBVIEW;
        }
        NSVisualEffectView *fx = dial8_find_glass_panel(host);

        if (!on) {
            [fx removeFromSuperview];
            [window invalidateShadow];
            return DIAL8_BACKDROP_OK;
        }

        if (fx == nil) {
            fx = [[NSVisualEffectView alloc] initWithFrame:host.bounds];
            fx.identifier = kDial8GlassPanelIdentifier;
            fx.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
            [host addSubview:fx positioned:NSWindowBelow relativeTo:webView];
        }
        fx.frame = host.bounds;
        // Blur what's behind the panel (the call, the desktop).
        fx.blendingMode = NSVisualEffectBlendingModeBehindWindow;
        fx.material = NSVisualEffectMaterialUnderWindowBackground;
        // Stay glass while Dial8 isn't the active app: the panel's whole job is
        // to float over the user's call window.
        fx.state = NSVisualEffectStateActive;
        if (appearance == DIAL8_BACKDROP_APPEARANCE_DARK) {
            fx.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
        } else if (appearance == DIAL8_BACKDROP_APPEARANCE_LIGHT) {
            fx.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
        } else {
            fx.appearance = nil;
        }
        fx.maskImage = dial8_rounded_mask((CGFloat)fmax(0.0, corner_radius));
        [window invalidateShadow];
        return DIAL8_BACKDROP_OK;
    }
}
