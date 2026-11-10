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

// What the first label of an address can be. A hosted project's ref is twenty
// lower-case letters; a project that began life on an address of its own has
// whatever that address began with.
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export type PinProblem = 'invalid' | 'contradicts-address'
export type PinReading = { ref: string | null; problem: PinProblem | null }

/** The ref a `<ref>.supabase.co` address names, or null for any other address. */
function refInOwnAddress(supabaseUrl: string | undefined): string | null {
  try {
    const labels = new URL((supabaseUrl ?? '').trim()).hostname.toLowerCase().split('.')
    return labels.length === 3 && labels[1] === 'supabase' && labels[2] === 'co' ? labels[0] : null
  } catch {
    return null
  }
}

/**
 * What a pin and an address give. Pure, so the agents' copies can be held to it.
 *
 * - No pin: nothing is pinned.
 * - A pin that could not be the first label of an address is not used.
 * - A pin that names ANOTHER project than a `<ref>.supabase.co` address does
 *   is not used either. That is the pin having leaked into an environment it
 *   was not meant for (production's ref in a preview build pointed at the dev
 *   project): honouring it would make dev sessions and dev cloud browsers
 *   answer to production's name.
 */
export function readProjectRefPin(pin: string | undefined, supabaseUrl: string | undefined): PinReading {
  const raw = pin?.trim().toLowerCase()
  if (!raw) return { ref: null, problem: null }
  if (!LABEL.test(raw)) return { ref: null, problem: 'invalid' }
  const own = refInOwnAddress(supabaseUrl)
  if (own && own !== raw) return { ref: null, problem: 'contradicts-address' }
  return { ref: raw, problem: null }
}

const MESSAGES: Record<PinProblem, string> = {
  invalid:
    'NEXT_PUBLIC_SUPABASE_PROJECT_REF is set but is not a project ref (lower-case letters and digits, as in <ref>.supabase.co). It is NOT being used: the session cookie is named from the address, which signs everyone out if the address has moved.',
  'contradicts-address':
    'NEXT_PUBLIC_SUPABASE_PROJECT_REF names a different project than NEXT_PUBLIC_SUPABASE_URL does. It is NOT being used here. Scope it to the one environment whose address has moved.',
}

function current(): PinReading {
  // Both written out in full: Next only puts a NEXT_PUBLIC_ value into the
  // browser bundle where it sees these exact expressions.
  return readProjectRefPin(process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF, process.env.NEXT_PUBLIC_SUPABASE_URL)
}

// A pin that is set and unusable must not pass quietly: the quiet outcome is
// every person signed out. On the server this module is loaded while the app
// is built, so a bad value stops the build and the deployment that would have
// carried it never goes live. (A browser cannot fail a build; there it logs.)
if (typeof window === 'undefined' && current().problem === 'invalid') {
  throw new Error(`[supabase] ${MESSAGES.invalid}`)
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
