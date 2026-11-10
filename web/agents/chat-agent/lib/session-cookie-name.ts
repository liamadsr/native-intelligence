/**
 * The session cookie's name when the app pins it.
 *
 * supabase-js names the session cookie after the first label of the Supabase
 * address. When production reaches its project through an address of our own,
 * the app pins the old name with NEXT_PUBLIC_SUPABASE_PROJECT_REF so nobody is
 * signed out (web/src/lib/supabase/project.ts has the whole story). An agent
 * that reads the browser's session cookie has to look under the same name, or
 * it finds no session at all.
 *
 * This is a copy of `readProjectRefPin` from that file: an agent is built on
 * its own and cannot import the app's modules. The file is identical in every
 * agent that reads the session cookie, and
 * web/src/lib/supabase/__tests__/project.test.ts holds each copy to the
 * original, input by input.
 */

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

function refInOwnAddress(supabaseUrl: string | undefined): string | null {
  try {
    const labels = new URL((supabaseUrl ?? '').trim()).hostname.toLowerCase().split('.')
    return labels.length === 3 && labels[1] === 'supabase' && labels[2] === 'co' ? labels[0] : null
  } catch {
    return null
  }
}

/** The pinned cookie name for this pin and address, or null when nothing is pinned or the pin cannot be used. */
export function pinnedSessionCookieName(pin: string | undefined, supabaseUrl: string | undefined): string | null {
  const raw = pin?.trim().toLowerCase()
  if (!raw || !LABEL.test(raw)) return null
  const own = refInOwnAddress(supabaseUrl)
  if (own && own !== raw) return null
  return `sb-${raw}-auth-token`
}

/** Spread into createServerClient's options, beside `cookies`. */
export function pinnedCookieOptions(): { cookieOptions?: { name: string } } {
  const name = pinnedSessionCookieName(process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF, process.env.NEXT_PUBLIC_SUPABASE_URL)
  return name ? { cookieOptions: { name } } : {}
}
