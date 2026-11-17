import { siteForUrl } from './blocked-sites'

/**
 * A page that asks the person to sign in, read from what the agent observes.
 * The agent never types a password or a code (resolve-field-text.ts, the
 * page runtime's forbidden fields), so a task that reaches one cannot go on:
 * the relay stops it, a card asks the person to sign in themselves in the
 * agent's browser, and their answer runs the task again (sign-in-card.ts).
 * A page watch's read uses the address rule alone (page-watch/url.ts).
 *
 * No model is asked and nothing of the page is kept: the answer is the site's
 * name, or null. Pure and shared by the relay and the server.
 *
 * What counts:
 *  - one field for a password the person knows, on a page whose address looks like a sign-in page or
 *    that says little else (a sign-in wall is short);
 *  - or, on an address that looks like a sign-in page that says little else,
 *    an account field and a button to go on (the first step of a two-step
 *    sign-in: the password is asked on the next page), or a button to sign in
 *    with another account ("Log in with GitHub").
 * Checked against real sign-in pages through the real page runtime: a
 * "Forgot password?" link is `forbidden` too, a sign-in form can sit above a
 * sign-up form, and the way on is often disabled until the account is typed.
 * What never counts:
 *  - a form with two password fields, one that asks for a NEW password, or an
 *    address for signing up or resetting a password;
 *  - a long page that merely carries a sign-in box beside its content;
 *  - a task that was sent to a sign-in page on purpose (its start address is
 *    one): the person asked to look at that page.
 */

/** Path words that mean "this is the page where you sign in". Matched on whole path segments, so /signals or /authors are not sign-in pages. */
const SIGN_IN_SEGMENT = /^(log[-_]?in|sign[-_]?in|sso|oauth2?|authorize|authenticate|auth|sessions?)$/i

/** Whether an address looks like a sign-in page: a sign-in host (login., accounts., ...) or a sign-in path segment. Pure. */
export function looksLikeSignInUrl(url: URL): boolean {
  if (/^(login|signin|sso|auth|accounts|id|identity)\./i.test(url.hostname)) return true
  return url.pathname.split('/').some((segment) => SIGN_IN_SEGMENT.test(segment))
}

/** A sign-in wall says its piece and little else. */
const SHORT_PAGE = 1500
/** A password the person is choosing, not one they know: a sign-up or a change. */
const NEW_PASSWORD = /\b(?:new|confirm|confirmation|repeat|retype|re-?enter|create|choose)\b/i
const ACCOUNT_NAME = /\b(?:e-?mail|user ?name|user ?id|phone|mobile|account|login)\b/i
const ACCOUNT_AUTOCOMPLETE = /\b(?:username|email|tel)\b/i
const GO_ON = /\b(?:sign in|log ?in|next|continue)\b/i
const WITH_PROVIDER = /\b(?:sign in|log ?in|continue) (?:with|using)\b/i
const TEXT_INPUTS = new Set(['email', 'text', 'tel'])

interface ObservedElement {
  role: string
  name: string
  context: string
  canType: boolean
  disabled: boolean
  forbidden: boolean
  input?: { type: string; autocomplete: string }
  /** The page runtime's word for a password field: one the person knows, or one they are choosing. */
  secretKind?: 'password' | 'new-password'
}

/** Path words for a page where a password is chosen or reset, never one where the person signs in. */
const NOT_SIGN_IN_SEGMENT = /^(sign[-_]?up|register|registration|join|create[-_]?account|reset[-_]?password|forgot[-_]?password|password[-_]?reset|recover|recovery)$/i

function parse(url: string | undefined): URL | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed : null
  } catch {
    return null
  }
}

/**
 * The site whose sign-in page this observation shows, or null. `startUrl` is
 * the page the task was sent to, when it named one.
 */
export function signInPage(
  observation: { url?: string; text?: string; elements?: readonly ObservedElement[] },
  startUrl?: string,
): string | null {
  const url = parse(observation.url)
  if (!url) return null
  const site = siteForUrl(url.href)
  if (!site) return null
  const asked = parse(startUrl)
  if (asked && looksLikeSignInUrl(asked)) return null

  if (url.pathname.split('/').some((segment) => NOT_SIGN_IN_SEGMENT.test(segment))) return null
  const signInAddress = looksLikeSignInUrl(url)
  const short = (observation.text ?? '').trim().length <= SHORT_PAGE
  // The page runtime says which fields are password fields and of which kind (`secretKind`). Its `forbidden` flag is
  // no guide: a "Forgot password?" link carries it too. A field's name is not either: it is in the site's language.
  const elements = Array.isArray(observation.elements) ? observation.elements : []
  const secrets = elements.filter((element) => !!element.secretKind && !element.disabled)
  const known = secrets.filter((element) => element.secretKind === 'password' && !NEW_PASSWORD.test(element.name))
  const chosen = secrets.length - known.length
  if (known.length > 1) return null
  if (known.length === 1) {
    // Beside a password being chosen (a sign-in form above a sign-up form, or a password change), only the address tells them apart.
    if (chosen > 0) return signInAddress && chosen === 1 ? site : null
    return signInAddress || short ? site : null
  }
  if (chosen > 0) return null
  if (!signInAddress || !short) return null
  const account = elements.some((element) =>
    element.canType && !element.forbidden && !element.disabled && !!element.input && TEXT_INPUTS.has(element.input.type) &&
    (ACCOUNT_AUTOCOMPLETE.test(element.input.autocomplete) || ACCOUNT_NAME.test(element.name)))
  // The way on is often disabled until the account is typed: it counts all the same.
  const goOn = elements.some((element) => !element.canType && GO_ON.test(element.name))
  if (account && goOn) return site
  // A sign-in page that only offers other accounts ("Log in with GitHub").
  return elements.some((element) => !element.canType && WITH_PROVIDER.test(element.name)) ? site : null
}
