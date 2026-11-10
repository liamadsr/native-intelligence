/**
 * The Supabase project's own name, for when the address no longer carries it.
 *
 * supabase-js names the session cookie after the first label of the address
 * it is given: `sb-<label>-auth-token`. On Supabase's own address
 * (`<ref>.supabase.co`) that label is the project ref. Reach the same project
 * through an address of ours (a proxy host in front of it, or a self-hosted
 * stack) and the label changes, and with it the cookie's name. The session a
 * signed-in person holds is under the old name, so the app stops finding it:
 * everybody is signed out at once. Other code reads the ref out of the address
 * the same way and would quietly start calling production "local".
 *
 * NEXT_PUBLIC_SUPABASE_PROJECT_REF pins the name. Set it to the ref the
 * project had when the sessions that are out there were made, and the address
 * can move without anyone being signed out. Unset, everything is derived from
 * the address exactly as before.
 *
 * It is NEXT_PUBLIC_ because the browser client names the cookie too; a ref is
 * not a secret (it is in the address every browser already calls).
 *
 * The agents that read the session cookie cannot import this file; each has a
 * copy of the rule in its `lib/session-cookie-name.ts`. The test beside this
 * file holds the copies to it.
 */
import { isProductionEnvironment } from '@/lib/app-env'

// What the first label of an address can be. A hosted project's ref is twenty
// lower-case letters; a project that began life on an address of its own has
// whatever that address began with.
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export type PinProblem = 'invalid' | 'contradicts-address' | 'local-address'
export type PinReading = { ref: string | null; problem: PinProblem | null }

/** The host of an address, lower-cased, without the dot a fully qualified name may end in. Null when there is none. */
function hostOf(supabaseUrl: string | undefined): string | null {
  try {
    return new URL((supabaseUrl ?? '').trim()).hostname.toLowerCase().replace(/\.$/, '') || null
  } catch {
    return null
  }
}

/**
 * The ref an address of Supabase's own names (`<ref>.supabase.co`, and the two
 * other domains the client library also treats as Supabase's), or null for any
 * other address.
 */
function refInOwnAddress(host: string | null): string | null {
  const labels = (host ?? '').split('.')
  return labels.length === 3 && labels[1] === 'supabase' && /^(co|in|red)$/.test(labels[2]) ? labels[0] : null
}

/**
 * An address only this machine or this network answers on (loopback, a private
 * range, a name with no dot or under a private suffix): a development or
 * restore stack. Never what real people's browsers call.
 */
function isLocalAddress(host: string | null): boolean {
  if (!host) return false
  if (host === '[::1]') return true
  // One name with no dot: `localhost`, or another container's name.
  if (!host.includes('.') && !host.startsWith('[')) return true
  // Loopback, "any address", link-local and the private IPv4 ranges.
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (ip) {
    const a = Number(ip[1])
    const b = Number(ip[2])
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  return /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)
}

/**
 * What a pin and an address give. Pure, so the agents' copies can be held to it.
 *
 * - No pin: nothing is pinned.
 * - A pin that could not be the first label of an address is not used.
 * - A pin on a local address is not used. A development or restore stack that
 *   has picked up production's pin would otherwise answer to production's name:
 *   its cloud browsers would land in production's namespace.
 * - A pin that names ANOTHER project than an address of Supabase's own does is
 *   not used either. That is the pin having leaked into an environment it was
 *   not meant for (production's ref in a preview build pointed at the dev
 *   project), or the pin being wrong.
 *
 * An address of ours that is not local says nothing about which project is
 * behind it, so there a well-formed pin is always used. That is why a wrong
 * pin has to be caught while the address is still Supabase's (see below).
 */
export function readProjectRefPin(pin: string | undefined, supabaseUrl: string | undefined): PinReading {
  const raw = pin?.trim().toLowerCase()
  if (!raw) return { ref: null, problem: null }
  if (!LABEL.test(raw)) return { ref: null, problem: 'invalid' }
  const host = hostOf(supabaseUrl)
  if (isLocalAddress(host)) return { ref: null, problem: 'local-address' }
  const own = refInOwnAddress(host)
  if (own && own !== raw) return { ref: null, problem: 'contradicts-address' }
  return { ref: raw, problem: null }
}

const MESSAGES: Record<PinProblem, string> = {
  invalid:
    'NEXT_PUBLIC_SUPABASE_PROJECT_REF is set but could not be the first part of an address (lower-case letters, digits and hyphens, as in <ref>.supabase.co). It is NOT being used: the session cookie is named from the address, which signs everyone out if the address has moved.',
  'contradicts-address':
    'NEXT_PUBLIC_SUPABASE_PROJECT_REF names a different project than NEXT_PUBLIC_SUPABASE_URL does. It is NOT being used here. Scope it to the one environment whose address has moved.',
  'local-address':
    'NEXT_PUBLIC_SUPABASE_PROJECT_REF is set, but NEXT_PUBLIC_SUPABASE_URL is a local address (a development or restore stack). It is NOT being used here: this stack keeps its own cookie name and its own cloud browsers. Remove it from this environment.',
}

const WRONG_IN_PRODUCTION =
  'NEXT_PUBLIC_SUPABASE_PROJECT_REF names a different project than NEXT_PUBLIC_SUPABASE_URL does, in a production build. One of the two is wrong. A wrong pin changes nothing today and signs every person out on the day the address moves, so this build stops here.'

function current(): PinReading {
  // Both written out in full: Next only puts a NEXT_PUBLIC_ value into the
  // browser bundle where it sees these exact expressions.
  return readProjectRefPin(process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF, process.env.NEXT_PUBLIC_SUPABASE_URL)
}

// A pin that is set and unusable must not pass quietly: the quiet outcome is
// every person signed out. On the server this module is loaded while the app
// is built, so a bad value stops the build and the deployment that would have
// carried it never goes live. (A browser cannot fail a build; there it logs.)
//
// Two things stop a build. A value that could not be a first label, anywhere.
// And, in a production build, a well-formed pin that names another project
// than Supabase's own address does. "Production" is app-env's answer: a
// production deployment on Vercel, and off Vercel any `next build` (the
// container image, a build on a developer's machine). The pin goes in while production is still
// on that address, and that is the only time a wrong one can be told from a
// right one: once the address is ours nothing contradicts it, it is used, and
// everyone is signed out. In a Vercel preview or development build, and under
// `next dev`, the same contradiction is the pin having leaked (a preview on
// the dev project), so it is ignored and logged.
if (typeof window === 'undefined') {
  const { problem } = current()
  if (problem === 'invalid') throw new Error(`[supabase] ${MESSAGES.invalid}`)
  if (problem === 'contradicts-address' && isProductionEnvironment()) {
    throw new Error(`[supabase] ${WRONG_IN_PRODUCTION}`)
  }
}

const complained = new Set<PinProblem>()

/** The pinned project ref, or null when nothing is pinned (or the pin cannot be used here). */
export function supabaseProjectRef(): string | null {
  const { ref, problem } = current()
  if (problem && !complained.has(problem)) {
    complained.add(problem)
    console.error(`[supabase] ${MESSAGES[problem]}`)
  }
  return ref
}

/**
 * The session cookie's name when the ref is pinned. Null means "not pinned":
 * supabase-js then derives the name from the address, and so must anything
 * that reads the cookie itself (see authTokenStorageKey in server.ts).
 */
export function pinnedAuthCookieName(): string | null {
  const ref = supabaseProjectRef()
  return ref ? `sb-${ref}-auth-token` : null
}

/**
 * Spread into the options of every cookie-backed client (createBrowserClient,
 * createServerClient). All of them must agree on the cookie's name, or one
 * writes a session the others cannot see; that is why this lives in one place.
 * `cookieOptions.name` is the library's own switch for the storage key. Never
 * pass `auth.storageKey` or another `cookieOptions.name` beside it: either
 * would override the pin for that one client.
 */
export function authCookieOptions(): { cookieOptions?: { name: string } } {
  const name = pinnedAuthCookieName()
  return name ? { cookieOptions: { name } } : {}
}
