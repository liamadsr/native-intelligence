/**
 * A snippet's fill-ins (docs/plans/snippets.md §2, decision 3): a fixed few
 * words in double braces, replaced as the snippet goes in. Pure.
 *
 *   {{date}}            today, written out in the person's locale
 *   {{time}}            the time now
 *   {{my_name}}         the person inserting it
 *   {{my_first_name}}
 *   {{name}}            the first recipient (the mail composer only)
 *   {{first_name}}
 *
 * A fill-in with no value where it is used stays as typed, so the writer sees
 * it and fills it by hand. Nothing else in braces is touched, and nothing is
 * evaluated.
 */

export const SNIPPET_FILL_INS = ['date', 'time', 'my_name', 'my_first_name', 'name', 'first_name'] as const
export type SnippetFillIn = (typeof SNIPPET_FILL_INS)[number]

export const FILL_IN_LABELS: Record<SnippetFillIn, string> = {
  date: "Today's date",
  time: 'The time now',
  my_name: 'Your name',
  my_first_name: 'Your first name',
  name: "The recipient's name (mail)",
  first_name: "The recipient's first name (mail)",
}

/** What the place a snippet goes into knows. */
export interface FillInContext {
  now?: Date
  locale?: string
  /** The person inserting it. */
  me?: { name?: string | null } | null
  /** The first recipient (mail): a name, or an address when no name is known. */
  recipient?: { name?: string | null; email?: string | null } | null
}

const FILL_IN_RE = /\{\{\s*([a-z_]+)\s*\}\}/g

/** The first word of a name ("Maya Chen" → "Maya"); an address's local part, capitalised, when no name. */
export function firstNameOf(person: { name?: string | null; email?: string | null } | null | undefined): string | null {
  const name = person?.name?.trim()
  if (name) {
    // "Chen, Maya" is written last-name first.
    const comma = name.indexOf(',')
    const first = comma > 0 ? name.slice(comma + 1).trim().split(/\s+/)[0] : name.split(/\s+/)[0]
    return first || null
  }
  const local = person?.email?.split('@')[0]?.split(/[._+-]/)[0]
  if (!local || /\d/.test(local)) return null
  return local.charAt(0).toUpperCase() + local.slice(1).toLowerCase()
}

function fullNameOf(person: { name?: string | null; email?: string | null } | null | undefined): string | null {
  return person?.name?.trim() || firstNameOf(person)
}

function valueOf(key: SnippetFillIn, ctx: FillInContext): string | null {
  const now = ctx.now ?? new Date()
  switch (key) {
    case 'date':
      return now.toLocaleDateString(ctx.locale, { year: 'numeric', month: 'long', day: 'numeric' })
    case 'time':
      return now.toLocaleTimeString(ctx.locale, { hour: 'numeric', minute: '2-digit' })
    case 'my_name':
      return ctx.me?.name?.trim() || null
    case 'my_first_name':
      return firstNameOf(ctx.me ?? null)
    case 'name':
      return fullNameOf(ctx.recipient)
    case 'first_name':
      return firstNameOf(ctx.recipient)
  }
}

/** The fill-ins a body holds, once each, in the order they appear. */
export function fillInsOf(body: string): SnippetFillIn[] {
  const seen = new Set<SnippetFillIn>()
  for (const m of body.matchAll(FILL_IN_RE)) {
    const key = m[1] as SnippetFillIn
    if ((SNIPPET_FILL_INS as readonly string[]).includes(key)) seen.add(key)
  }
  return [...seen]
}

/** The body with every fill-in that has a value here replaced (the value as it is: names and dates hold no markdown). */
export function applyFillIns(body: string, ctx: FillInContext): string {
  return body.replace(FILL_IN_RE, (whole, raw: string) => {
    if (!(SNIPPET_FILL_INS as readonly string[]).includes(raw)) return whole
    const value = valueOf(raw as SnippetFillIn, ctx)
    return value ?? whole
  })
}

/**
 * The first recipient as the fill-ins read them, from a To field's entry (an
 * address, or `Name <address>`) and the people the message already names
 * (the thread's sender and recipients, whose names the mailbox knows).
 */
export function recipientOf(
  to: readonly string[],
  known: ReadonlyArray<{ name: string | null; email: string }> = [],
): { name: string | null; email: string } | null {
  const raw = to.find((t) => t.trim())?.trim()
  if (!raw) return null
  const angle = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  const email = (angle ? angle[2] : raw).trim().toLowerCase()
  const named = angle?.[1]?.trim() || null
  const match = known.find((k) => k.email.trim().toLowerCase() === email)
  return { name: named ?? match?.name?.trim() ?? null, email }
}
