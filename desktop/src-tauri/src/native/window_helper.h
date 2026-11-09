/// C-callable helpers to smooth out live-resize on the macOS WKWebView.
///
/// Native Intelligence is a Tauri shell hosting a web app inside a WKWebView. During a live
/// window resize, AppKit resizes the NSWindow frame synchronously with the
/// drag, but the WKWebView re-lays-out and repaints a frame (or more) behind.
/// In that gap the window's *backgroundColor* shows through — which by default
/// is opaque white — producing a visible empty-space flash before the content
/// "snaps" to fill the new size.
///
/// We can't make the web layout keep up frame-for-frame, but we can make the
/// gap invisible: paint the NSWindow background (and the web content view's
/// backing layer) with the app's own background color, picked to match the
/// current system appearance (light vs dark). The flash then blends into the
/// app instead of contrasting with it.

#ifndef WINDOW_HELPER_H
#define WINDOW_HELPER_H

#include <stdbool.h>
#include <stdint.h>

/// Paint the given NSWindow's background (and its contentView layer) to match
/// the current system appearance: a near-black for dark mode, a near-white for
/// light mode — chosen to match the web app's --background token.
///
/// `ns_window` is the raw NSWindow pointer from Tauri's `window.ns_window()`.
/// Safe to call repeatedly (e.g. on every appearance change). Returns true if
/// the color was applied.
bool window_apply_background(void *ns_window);

/// Make the given NSWindow genuinely TRANSPARENT: clear its backgroundColor,
/// mark it non-opaque, and clear the contentView's backing-layer fill. This is
/// the macOS-correct counterpart to a Tauri `.transparent(true)` window — that
/// flag alone leaves the NSWindow with an opaque (default white) backing that
/// re-appears on a repaint (e.g. a light/dark theme switch), showing as a white
/// square behind a rounded floating panel like the agent HUD. Apply once after
/// the window is created (and re-apply on appearance change to be safe).
///
/// `ns_window` is the raw NSWindow pointer. Idempotent. Returns true on success.
bool window_clear_background(void *ns_window);

/// Make the WKWebView's backing layer resize *synchronously* with the window
/// instead of animating into place a beat behind.
///
/// Wry already gives the web view an autoresizing mask, so it tracks the window
/// size — but the view is layer-backed, and CoreAnimation applies a default
/// implicit animation (~0.25s ease) to any layer geometry change. On a maximize
/// or zoom that reads as the content "catching up" to the window. We:
///   - force the view layer-backed with a redraw-during-resize policy, and
///   - install an actions dictionary that maps the geometry keys to NSNull,
///     disabling the implicit animation so the layer snaps to new bounds.
///
/// `ns_window` is the raw NSWindow pointer. Safe to call repeatedly. Returns
/// true if a WKWebView was found and configured.
bool window_sync_webview_resize(void *ns_window);

/// Make zoom (green-button / double-click-title-bar maximize) an instant frame
/// change instead of an animated grow, by forcing animate:NO in the window's
/// setFrame:display:animate:.
///
/// The animated maximize sends the WKWebView hundreds of intermediate sizes that
/// it relayouts a beat behind, so the page trails the window for the whole
/// animation. A single jump gives WebKit one resize to lay out, so the content
/// fills the window effectively immediately.
///
/// `ns_window` is the raw NSWindow pointer. Idempotent. Returns true if the
/// override was installed.
bool window_disable_zoom_animation(void *ns_window);

/// Resize and vertically center the three standard macOS window buttons (the
/// "traffic lights": close / minimize / zoom).
///
/// With an Overlay title bar the lights sit in the window's standard title bar
/// at AppKit's default size — on macOS 26 (Tahoe) that default is noticeably
/// larger than older systems. This shrinks each button to `diameter` points and
/// re-positions the row so each button's vertical center lands at `center_y`
/// points below the top of the window's content (matching the web tab bar's
/// h-7 buttons, whose centers sit at 22pt in the 44pt bar).
///
/// AppKit re-runs title-bar layout on many window-state changes and resets the
/// button frames, so this must be re-applied (cheaply, from the resize/show
/// handlers). It is idempotent and no-ops when the frames already match, and it
/// disables implicit Core Animation so re-application never flickers.
///
/// `ns_window` is the raw NSWindow pointer. `diameter` is the desired button
/// width/height in points (e.g. 12). `center_y` is the distance in points from
/// the top of the window's content view to the button centers (e.g. 22).
/// Returns true if the buttons were found and styled.
bool window_style_traffic_lights(void *ns_window, double diameter, double center_y);

/// Turn a floating HUD window into a NON-ACTIVATING PANEL that shows on every
/// Space, full-screen ones included: the agent HUD has to stay up while the
/// user is in a full-screen call (Meet, Zoom, Teams), and since macOS 10.14 an
/// ordinary NSWindow of a regular app can't float over another app's
/// full-screen Space whatever its level or collection behavior. An NSPanel with
/// the non-activating style can (what Spotlight-like overlays use).
///
/// Swaps the window's class to a runtime NSPanel subclass that keeps what tao's
/// window class adds (its methods and ivars: focusability, background drag)
/// and never becomes main, then sets the non-activating style, keeps it showing
/// when Native Intelligence isn't the active app (an NSPanel hides on deactivate by default),
/// floats it, and lets it join every Space including full-screen ones. It also
/// stays up when the user hides Native Intelligence (Cmd+H). Run on the main thread, before
/// the window is first shown. Idempotent: on a window that is already a panel
/// it only re-asserts the Space behavior and level.
///
/// Returns DIAL8_OVERLAY_OK, or why it left the window a plain window (every
/// normal Space, not full-screen ones, but still up on Cmd+H): its class isn't
/// a direct NSWindow subclass (a KVO subclass, say), tao's class has a
/// destructor the copy can't carry, or the panel class would need more memory
/// than the window was allocated with or move tao's ivars.
#define DIAL8_OVERLAY_OK 0
#define DIAL8_OVERLAY_NOT_A_PLAIN_WINDOW 1
#define DIAL8_OVERLAY_CLASS_NOT_COPYABLE 2
#define DIAL8_OVERLAY_DID_NOT_FIT 3
int window_make_overlay_panel(void *ns_window);

/// Bring a window to the front WITHOUT making it key: `orderFrontRegardless`,
/// where tao's show is `makeKeyAndOrderFront:`. For the agent HUD, a
/// non-activating panel that can become key, a plain show would take the
/// keyboard from whatever the user is typing in (their call app, Native Intelligence's main
/// window). Main thread.
void window_order_front_without_focus(void *ns_window);

/// The MAIN/workspace window's backdrop, chosen in the web app's Preferences →
/// Background: the usual opaque surface, or Glass (the window turns
/// transparent and the window server blurs what's behind it by `blur_radius`
/// points, so the desktop shows through frosted). The page makes its own
/// surfaces transparent and lays its tint on top; this only changes what is
/// behind them.
///
/// The blur is the window server's per-window background blur
/// (CGSSetWindowBackgroundBlurRadius, private SkyLight API, what iTerm2's
/// transparency uses), looked up at run time so a macOS without it only loses
/// the blur. Not an NSVisualEffectView: its behind-window blur switches off
/// entirely as soon as the view is faded at all, so it can't be dialled down.
///
/// `mode` is a DIAL8_BACKDROP_MODE_*; `blur_radius` 0 is unblurred. Off
/// re-applies window_apply_background (and turns the web view's own
/// background back on), so it returns the window to exactly how setup left
/// it. Idempotent; main thread.
///
/// Returns DIAL8_BACKDROP_OK, or why nothing changed.
#define DIAL8_BACKDROP_MODE_OFF 0
#define DIAL8_BACKDROP_MODE_GLASS 1
#define DIAL8_BACKDROP_OK 0
#define DIAL8_BACKDROP_NO_WINDOW 1
#define DIAL8_BACKDROP_NO_WEBVIEW 2
int window_set_backdrop(void *ns_window, int mode, int blur_radius);

/// Glass for a floating panel that is already transparent (the live agent's
/// HUD): a macOS vibrancy layer (NSVisualEffectView) behind its web view,
/// masked to the panel's rounded corners. Not the window server blur that
/// window_set_backdrop uses: that one blurs the whole window rectangle, which
/// would show in the corners past the panel's curve. The vibrancy is never
/// faded (a faded NSVisualEffectView drops its blur); the page tints on top.
///
/// `on` adds or updates the layer, 0 removes it (the panel stays
/// transparent). `appearance` is a DIAL8_BACKDROP_APPEARANCE_*: the panel's
/// theme can differ from the Mac's. `corner_radius` matches the page's sheet.
/// Idempotent; main thread. Returns DIAL8_BACKDROP_OK or why nothing changed.
#define DIAL8_BACKDROP_APPEARANCE_SYSTEM 0
#define DIAL8_BACKDROP_APPEARANCE_LIGHT 1
#define DIAL8_BACKDROP_APPEARANCE_DARK 2
int window_set_glass_panel(void *ns_window, int on, int appearance, double corner_radius);

#endif
