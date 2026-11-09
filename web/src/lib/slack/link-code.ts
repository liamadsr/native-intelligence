/**
 * Slack link codes (docs/plans/slack-connect.md §4 piece 2). Pure.
 *
 * A person makes a code in Native Intelligence (Settings > Connectors > Slack) and sends
 * it to the Native Intelligence bot in a Slack DM. Slack verified who sent the DM, and only
 * that person's Native Intelligence session could have seen the code, so the DM proves one
 * person holds both accounts. That links their Slack user to their Native Intelligence user,
 * and, the first time a Slack team is used, binds the team to their Native Intelligence
 * workspace (an admin's code only). An email match is never enough on its
 * own: a link grants the person's full agent from Slack.
 *
 * A code is 8 characters from an unambiguous alphabet, shown as `K7Q4-M3PX`,
 * single use, alive for {@link LINK_CODE_TTL_MS}. Only its sha256 is stored.
 */
import { createHash, randomInt } from 'node:crypto'

/** Unambiguous letters and digits (no 0/O, 1/I/L, 5/S, 2/Z, 8/B). */
const ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679'
const LENGTH = 8

export const LINK_CODE_TTL_MS = 15 * 60_000

/** A fresh code, formatted for display (`K7Q4-M3PX`). */
export function newLinkCode(): string {
  let raw = ''
  for (let i = 0; i < LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)]
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

/** A code as typed (any case, with or without the dash, spaces around) → its canonical form, or null. */
export function normalizeLinkCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[\s-]+/g, '')
  if (raw.length !== LENGTH) return null
  for (const ch of raw) if (!ALPHABET.includes(ch)) return null
  return raw
}

/** The stored hash of a canonical code. */
export function linkCodeHash(canonical: string): string {
  return createHash('sha256').update(`slack-link:${canonical}`).digest('hex')
}

/**
 * The code in a DM, when the DM is a link attempt: the whole message is a
 * code, or "link" followed by one (Slack may wrap it in formatting). Null for
 * anything else, so an ordinary message is never read as a code.
 */
export function linkCodeInMessage(text: string): string | null {
  const plain = text
    .replace(/[`*_~]/g, ' ')
    .trim()
    .replace(/^link\s+/i, '')
    .trim()
  if (plain.length > 12) return null
  return normalizeLinkCode(plain)
}
