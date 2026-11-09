/// C-callable helper for the desktop Google sign-in: an
/// ASWebAuthenticationSession (`web_links_auth_session_start`). It runs the
/// sign-in page in the system's web-authentication sheet over the Native Intelligence window
/// and catches the `dial8desktop://` callback itself, so the code comes back as
/// the session's result (see commands/auth_session.rs).

#ifndef WEB_LINKS_HELPER_H
#define WEB_LINKS_HELPER_H

/// Called exactly once per `web_links_auth_session_start`, on the main thread:
/// `callback_url` on success (NULL otherwise), else `error` ("cancelled" when
/// the user closed the sheet or a newer session replaced this one).
typedef void (*WebLinksAuthDone)(void *ctx, const char *callback_url, const char *error);

/// Start an ASWebAuthenticationSession for `url`, completing on a navigation
/// to `callback_scheme`://…, presented from `ns_window` (the caller's NSWindow;
/// NULL = the key window). Non-ephemeral: it shares Safari's cookies, so a
/// signed-in Google account and passkeys work. Returns immediately; the result
/// arrives through `done` (with `ctx`). A session already running is cancelled
/// first (its `done` gets "cancelled"). Any thread; the session runs on main.
void web_links_auth_session_start(const char *url, const char *callback_scheme, void *ns_window,
                                  void *ctx, WebLinksAuthDone done);

#endif
