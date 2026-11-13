import { createClient, type SupabaseClient, type SupabaseClientOptions } from '@supabase/supabase-js'

/**
 * The auth settings every server-side supabase-js client needs.
 *
 * In Node, supabase-js starts a token auto-refresh ticker (a `setInterval` every
 * 30 s) for each client created with the defaults, and never stops it. The timer
 * holds the auth client, whose auth-state listener holds the whole client, so a
 * client created per request or per job is never collected: about 7 KB each, for
 * the life of the process. `persistSession: false` alone does not stop the ticker;
 * `autoRefreshToken: false` does. The web server created clients like this on
 * every authenticated API request and ran out of heap about every six hours.
 *
 * Server clients hold no session of their own (a service key, or a caller's
 * access token passed in a header), so there is nothing to persist or refresh.
 */
export const STATELESS_AUTH = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
} as const

// The 'public' schema, as a bare createClient(url, key) infers it: a looser type here
// would make the client a SupabaseClient<any, 'public', string>, which callers typed
// with the plain SupabaseClient do not accept.
type ClientOptions = SupabaseClientOptions<'public'>

/**
 * `createClient` from supabase-js for server code: the same arguments, with
 * {@link STATELESS_AUTH} always applied (an option passed here cannot turn the
 * refresh ticker back on). Server code never imports supabase-js's `createClient`
 * directly: `__tests__/stateless.test.ts` fails if it does.
 */
export function createStatelessClient(url: string, key: string, options?: ClientOptions): SupabaseClient {
  return createClient(url, key, {
    ...options,
    auth: { ...options?.auth, ...STATELESS_AUTH },
  })
}
