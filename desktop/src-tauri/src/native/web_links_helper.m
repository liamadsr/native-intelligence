#import "web_links_helper.h"
#import <AuthenticationServices/AuthenticationServices.h>
#import <Cocoa/Cocoa.h>

// ─── sign-in: ASWebAuthenticationSession ─────────────────────────────────────
// The session loads its URL in the system's web-authentication sheet (it
// shares Safari's cookies: non-ephemeral, so a signed-in Google account and
// passkeys work) and catches the dial8desktop:// callback itself
// (callbackURLScheme), so the result never travels as an OS deep link.

@interface Dial8AuthPresenter : NSObject <ASWebAuthenticationPresentationContextProviding>
@property(nonatomic, weak) NSWindow *window;
@end

@implementation Dial8AuthPresenter
- (ASPresentationAnchor)presentationAnchorForWebAuthenticationSession:(ASWebAuthenticationSession *)session {
    NSWindow *w = self.window;
    if (w != nil) return w;
    if (NSApp.keyWindow != nil) return NSApp.keyWindow;
    if (NSApp.mainWindow != nil) return NSApp.mainWindow;
    return NSApp.windows.firstObject ?: [[NSWindow alloc] init];
}
@end

// The running session and its presenter (the session holds its provider
// weakly). Main thread only.
static ASWebAuthenticationSession *g_auth_session = nil;
static Dial8AuthPresenter *g_auth_presenter = nil;

void web_links_auth_session_start(const char *url, const char *callback_scheme, void *ns_window,
                                  void *ctx, WebLinksAuthDone done) {
    if (done == NULL) return;
    NSString *urlString = url ? [NSString stringWithUTF8String:url] : nil;
    NSString *scheme = callback_scheme ? [NSString stringWithUTF8String:callback_scheme] : nil;
    NSWindow *window = (__bridge NSWindow *)ns_window;
    dispatch_async(dispatch_get_main_queue(), ^{
        // `done` exactly once, whatever path finishes first.
        __block BOOL finished = NO;
        void (^finish)(NSString *, NSString *) = ^(NSString *callback, NSString *error) {
            if (finished) return;
            finished = YES;
            done(ctx, callback.UTF8String, callback ? NULL : (error ?: @"sign-in failed").UTF8String);
        };

        NSURL *target = urlString ? [NSURL URLWithString:urlString] : nil;
        if (target == nil || scheme.length == 0) {
            finish(nil, @"invalid sign-in URL");
            return;
        }
        // One sign-in at a time: a second click replaces the first.
        if (g_auth_session != nil) [g_auth_session cancel];

        Dial8AuthPresenter *presenter = [[Dial8AuthPresenter alloc] init];
        presenter.window = window;
        __block ASWebAuthenticationSession *session = nil;
        session = [[ASWebAuthenticationSession alloc]
                    initWithURL:target
              callbackURLScheme:scheme
              completionHandler:^(NSURL *callbackURL, NSError *error) {
                  dispatch_async(dispatch_get_main_queue(), ^{
                      if (g_auth_session == session) {
                          g_auth_session = nil;
                          g_auth_presenter = nil;
                      }
                      session = nil;
                      if (callbackURL != nil) {
                          finish(callbackURL.absoluteString, nil);
                      } else if ([error.domain isEqualToString:ASWebAuthenticationSessionErrorDomain] &&
                                 error.code == ASWebAuthenticationSessionErrorCodeCanceledLogin) {
                          finish(nil, @"cancelled");
                      } else {
                          finish(nil, error.localizedDescription);
                      }
                  });
              }];
        session.presentationContextProvider = presenter;
        session.prefersEphemeralWebBrowserSession = NO;
        if (![session canStart] || ![session start]) {
            finish(nil, @"could not start the sign-in window");
            return;
        }
        g_auth_session = session;
        g_auth_presenter = presenter;
    });
}
