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

function hostOf(supabaseUrl: string | undefined): string | null {
  try {
    return new URL((supabaseUrl ?? '').trim()).hostname.toLowerCase().replace(/\.$/, '') || null
  } catch {
    return null
  }
}

// The ref an address of Supabase's own names, or null for any other address.
function refInOwnAddress(host: string | null): string | null {
  const labels = (host ?? '').split('.')
  return labels.length === 3 && labels[1] === 'supabase' && /^(co|in|red)$/.test(labels[2]) ? labels[0] : null
}

// A development or restore stack: the pin is production's and is not used there.
function isLocalAddress(host: string | null): boolean {
  if (!host) return false
  return (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(host) ||
    /\.(localhost|local|internal)$/.test(host)
  )
}

/** The pinned cookie name for this pin and address, or null when nothing is pinned or the pin cannot be used. */
export function pinnedSessionCookieName(pin: string | undefined, supabaseUrl: string | undefined): string | null {
  const raw = pin?.trim().toLowerCase()
  if (!raw || !LABEL.test(raw)) return null
  const host = hostOf(supabaseUrl)
  if (isLocalAddress(host)) return null
  const own = refInOwnAddress(host)
  if (own && own !== raw) return null
  return `sb-${raw}-auth-token`
}

/** Spread into createServerClient's options, beside `cookies`. */
export function pinnedCookieOptions(): { cookieOptions?: { name: string } } {
  const name = pinnedSessionCookieName(process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF, process.env.NEXT_PUBLIC_SUPABASE_URL)
  return name ? { cookieOptions: { name } } : {}
}
