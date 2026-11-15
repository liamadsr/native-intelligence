/**
 * Contacts a public intake made (contact.source 'web_form' or 'sms': a
 * website form, a quote, a customer's first text; src/lib/customers/contacts.ts
 * upsertCustomerContact). Their name and email are what a stranger typed.
 * Wherever such a contact's words reach a model they go inside the untrusted
 * fence (src/lib/email/untrusted.ts); where only a name is needed outside one
 * (a tool's plain message, a graph label), the contact goes by
 * STRANGER_CONTACT_NAME instead. A contact a person made is shown as it is.
 * People see the contact's own words: this is for what a model reads.
 *
 * The contact tools apply it through src/lib/ai/tools/web-derived.ts
 * (fenceStrangerContact); a form's table rows have the same rule in
 * ./form-rows.ts.
 *
 * Client-safe and pure: the entity registry imports it.
 */
import { wrapUntrusted } from '@/lib/email/untrusted'

/** The contact sources a stranger writes: a website form or a quote ('web_form'), a customer's first text ('sms'). */
export const STRANGER_CONTACT_SOURCES = ['web_form', 'sms'] as const

/** Was this contact made by a public intake, so a stranger named it? By its `source` column. */
export function isStrangerContactSource(source: unknown): boolean {
  return (STRANGER_CONTACT_SOURCES as readonly unknown[]).includes(source)
}

/** Such a contact's name outside any fence: never what they typed. */
export const STRANGER_CONTACT_NAME = 'a contact from a form'

/**
 * An address strict enough that it cannot carry prose: one `@`, a local part
 * of letters, digits and `. _ % + -` only (so no whitespace, angle brackets,
 * quotes, parentheses, commas, colons or semicolons), a dotted domain of
 * letters, digits and inner hyphens, at most 254 characters. Such an address
 * is returned plain even for a stranger's contact, so an agent can copy it
 * into a send or a draft; anything else stays fenced.
 */
const PLAIN_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/

export function isPlainEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && PLAIN_EMAIL_RE.test(value)
}

/** A stranger's email as a model reads it: plain when it is a plain address, otherwise in the WEB fence. Non-strings and '' as they are. */
export function strangerEmail<T>(value: T): T | string {
  if (typeof value !== 'string' || !value.trim() || isPlainEmail(value)) return value
  return wrapUntrusted(value, 'WEB') ?? value
}

/** A stranger's name (or any of their words) inside the WEB fence; non-strings and '' as they are. */
export function fenceStrangerText<T>(value: T): T | string {
  return typeof value === 'string' && value.trim() ? (wrapUntrusted(value, 'WEB') ?? value) : value
}

/**
 * A contact's name as a model reads it outside a fence (a label, a message):
 * the neutral name when a stranger made it, otherwise its own name. Reads
 * `source` and `full_name` from any row shape.
 */
export function contactModelName(row: { full_name?: unknown; source?: unknown } | null | undefined, fallback = ''): string {
  if (isStrangerContactSource(row?.source)) return STRANGER_CONTACT_NAME
  return typeof row?.full_name === 'string' && row.full_name ? row.full_name : fallback
}
