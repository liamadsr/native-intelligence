/** Shared, deterministic reply-address policy. No model or provider calls. */
export interface ReplyAddressEvidence { from: string; replyTo?: string }

// Parse ordinary mailbox lists without mistaking a display name for an address.
// Unsupported/malformed headers yield no recipients rather than a guessed one.
export function mailboxAddresses(header: string): string[] {
  if (!header || /[\r\n]/.test(header)) return []
  const parts: string[] = []
  let start = 0, quoted = false, escaped = false, angle = false
  for (let i = 0; i < header.length; i++) {
    const char = header[i]
    if (escaped) { escaped = false; continue }
    if (quoted && char === '\\') { escaped = true; continue }
    if (char === '"') { quoted = !quoted; continue }
    if (quoted) continue
    if (char === '<') { if (angle) return []; angle = true }
    if (char === '>') { if (!angle) return []; angle = false }
    if (char === ',' && !angle) { parts.push(header.slice(start, i)); start = i + 1 }
  }
  if (quoted || angle) return []
  parts.push(header.slice(start))
  const addresses: string[] = []
  for (const part of parts) {
    const token = part.trim()
    // Display names may contain quoted angle brackets, escaped quotes and
    // backslashes. Only the unquoted outer pair encloses the actual mailbox.
    const bracketed = token.match(/^(?:"(?:[^"\\]|\\.)*"|[^"<>])*<([^<>]+)>$/)
    const address = (bracketed?.[1] ?? token).trim().toLowerCase()
    if (!/^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-z0-9!#$%&'*+\-/=?^_`{|}~]+)*@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(address)) return []
    if (address.length > 320 || address.split('@')[1].split('.').some(label =>
      label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return []
    addresses.push(address)
  }
  return [...new Set(addresses)]
}

/**
 * No-reply markers matched ANYWHERE in the local part, with any `.`, `_` or
 * `-` between the words: `gustonoreply`, `alerts-noreply`, `no.reply+x`,
 * `do_not_reply`, `bounces+abc`. A local part that merely contains "reply"
 * (`replyhq-founder`, `reply`) is not one (src/lib/email/automated-sender.ts).
 */
const NO_REPLY_LOCAL = /no[._-]?reply|do[._-]?not[._-]?reply|not[._-]?reply|mailer[._-]?daemon|postmaster|bounce/i

export function isNoReplyAddress(header: string): boolean {
  const addresses = mailboxAddresses(header)
  if (addresses.length !== 1) return false
  const [local, domain] = addresses[0].split('@')
  return NO_REPLY_LOCAL.test(local) ||
    domain.split('.').some(label => /^(?:no-?reply|do-?not-?reply)$/i.test(label))
}

/** A real Reply-To takes precedence; a no-reply destination is never drafted to. */
export function replyRecipients(message: ReplyAddressEvidence): string[] {
  const header = message.replyTo?.trim() || message.from
  return mailboxAddresses(header).filter(address => !isNoReplyAddress(address))
}

/** Only address evidence establishes this hard skip; names/body text do not. */
export function hasOnlyNoReplyDestination(message: ReplyAddressEvidence): boolean {
  const destinations = mailboxAddresses(message.replyTo?.trim() || message.from)
  return destinations.length > 0 && destinations.every(isNoReplyAddress)
}
