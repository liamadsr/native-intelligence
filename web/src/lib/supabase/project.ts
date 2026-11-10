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
 */

// A project ref is twenty lower-case letters. A little wider than that, but
// nothing that could not be part of a cookie name.
const REF = /^[a-z0-9]{1,63}$/

let complained = false

/** The pinned project ref, or null when the setting is absent (or unusable). */
export function supabaseProjectRef(): string | null {
  // Written out in full: Next only puts a NEXT_PUBLIC_ value into the browser
  // bundle where it sees this exact expression.
  const raw = process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF?.trim().toLowerCase()
  if (!raw) return null
  if (REF.test(raw)) return raw
  if (!complained) {
    complained = true
    console.error(
      '[supabase] NEXT_PUBLIC_SUPABASE_PROJECT_REF is set but is not a project ref (lower-case letters and digits); ignoring it. The session cookie is named from the address instead.',
    )
  }
  return null
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
 * `cookieOptions.name` is the library's own switch for the storage key.
 */
export function authCookieOptions(): { cookieOptions?: { name: string } } {
  const name = pinnedAuthCookieName()
  return name ? { cookieOptions: { name } } : {}
}
