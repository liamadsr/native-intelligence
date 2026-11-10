import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { authCookieOptions } from '@/lib/supabase/project'

// createBrowserClient is a module-level singleton in the browser (@supabase/ssr
// caches it), so these realtime options are applied ONCE for the whole app on
// first construction — every createClient() caller shares the same socket.
//
// heartbeatCallback is Supabase's official mitigation for "silent disconnection
// in backgrounded/suspended apps" (the exact incident: the desktop WKWebView's
// websocket dies on overnight sleep and never notices). The SDK's OWN
// onclose→reconnectTimer is the primary recovery; this poke is an accelerant —
// it re-fires connect() as soon as a heartbeat misses instead of waiting out the
// backoff. It pairs with the out-of-band wake watchdog in realtime-recovery.ts.
//
// TIMING (load-bearing): on a 'timeout', the SDK fires this callback
// SYNCHRONOUSLY *before* it closes the socket (sendHeartbeat: callback →
// conn.close()), so isConnected() is still true and a synchronous connect()
// would early-return and do nothing. We defer the poke by a macrotask
// (setTimeout 0) so it runs AFTER the SDK's own close, when connect() can
// actually re-establish. 'disconnected' fires when the socket is already down,
// so its poke works immediately — deferring it too is harmless and keeps one
// path.
//
// We deliberately do NOT enable `worker: true` here: it spawns a Web Worker for
// the heartbeat, which a strict CSP (this app also ships inside Tauri) can block
// outright and silently break realtime. The main-thread heartbeat is sufficient
// once the watchdog forces the socket back to life on wake.
let cached: SupabaseClient | null = null

export function createClient() {
  const client = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // The session cookie keeps its name when the project's address moves.
      ...authCookieOptions(),
      realtime: {
        heartbeatCallback: (status) => {
          if (status === 'timeout' || status === 'disconnected') {
            // Defer to a macrotask so the poke runs AFTER the SDK's own
            // conn.close() (on 'timeout' the callback fires while the socket is
            // still open — a synchronous connect() would early-return). connect()
            // is idempotent — no-ops if already open/connecting.
            setTimeout(() => {
              try {
                cached?.realtime.connect()
              } catch {
                // best-effort; the wake watchdog + auto-reconnect remain fallbacks
              }
            }, 0)
          }
        },
      },
    },
  )
  // Capture the singleton so the heartbeatCallback closure (created above on the
  // FIRST construction) can reach the live client without re-entering createClient.
  cached = client
  return client
}
