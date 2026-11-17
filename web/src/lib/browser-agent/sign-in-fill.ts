/**
 * A saved login's fill: what the relay asks the person's own computer for,
 * and which fields of a sign-in page its answer goes into.
 *
 * The password is kept in that computer's keystore and nowhere else (desktop
 * `saved_logins.rs`). When a browser task reaches a sign-in page and the
 * computer's tunnel to the browser is up, the relay asks it for that site's
 * login (cloud-browser/relay/exit.ts `ask`), types the answer into the form
 * with real input (cdp/page.ts `fillField`) and presses Enter. No model sees
 * the answer, picks the fields or is asked about the page; the answer is never
 * logged, queued or sent to the app's server, and is dropped when the task
 * ends. With no answer (the computer is off, nothing is saved for the site,
 * the person said no), or when the page still asks afterwards, the task stops
 * and the sign-in card asks the person (sign-in-page.ts).
 *
 * Pure and shared: nothing here touches a page or a socket.
 */

/** A login, and the one host it was given for: it is typed into a page on that host and no other. */
export interface SavedLoginAnswer { host: string; username: string; password: string }

const MAX_FIELD = 512

/** The question for the person's computer: this page's host, nothing else. */
export function savedLoginQuestion(host: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: 1, op: 'saved_login', host }))
}

/** The computer's answer as a login, or null for a refusal or anything else. */
export function parseSavedLoginAnswer(answer: Uint8Array | null, askedHost: string): SavedLoginAnswer | null {
  if (!answer || answer.length === 0) return null
  let value: unknown
  try { value = JSON.parse(new TextDecoder().decode(answer)) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { ok, host, username, password } = value as Record<string, unknown>
  if (ok !== true || typeof host !== 'string' || typeof username !== 'string' || typeof password !== 'string') return null
  if (!host || !username || !password || host.length > 253 || username.length > MAX_FIELD || password.length > MAX_FIELD) return null
  // The answer must be for the host that was asked about: anything else is no answer.
  return host.toLowerCase() === askedHost.toLowerCase() ? { host: host.toLowerCase(), username, password } : null
}

interface ObservedField {
  ref: string
  name: string
  canType: boolean
  disabled: boolean
  forbidden: boolean
  input?: { type: string; autocomplete: string }
  secretKind?: 'password' | 'new-password'
  /** An embedded frame's control: never filled (the fill is the top document's alone). */
  frame?: string
}

const ACCOUNT_NAME = /\b(?:e-?mail|user ?name|user ?id|phone|mobile|account|login)\b/i
const ACCOUNT_AUTOCOMPLETE = /\b(?:username|email|tel)\b/i
const TEXT_INPUTS = new Set(['email', 'text', 'tel'])

/**
 * The fields of a sign-in page a saved login goes into: the one field for a
 * password the person knows, and the account field (the last one before the
 * password, or the page's only one on the first step of a two-step sign-in).
 * Either may be missing. Only the top document's own fields count.
 */
export function signInFields(observation: { elements?: readonly ObservedField[] }): { account?: string; password?: string } {
  const elements = (Array.isArray(observation.elements) ? observation.elements : []).filter((element) => !element.frame && !element.disabled)
  const passwords = elements.filter((element) => element.secretKind === 'password')
  const password = passwords.length === 1 ? passwords[0] : undefined
  const before = password ? elements.slice(0, elements.indexOf(password)) : elements
  const accounts = before.filter((element) => element.canType && !element.forbidden && !element.secretKind && !!element.input &&
    TEXT_INPUTS.has(element.input.type) && (ACCOUNT_AUTOCOMPLETE.test(element.input.autocomplete) || ACCOUNT_NAME.test(element.name)))
  // Beside a password, the nearest account field above it; alone, the page's only one (two would be a guess).
  const account = password ? accounts.at(-1) : accounts.length === 1 ? accounts[0] : undefined
  return { ...(account ? { account: account.ref } : {}), ...(password ? { password: password.ref } : {}) }
}
