/**
 * Phone numbers as Native Intelligence stores them: E.164 (`+15551234567`), the shape
 * Twilio's `From` carries. A US/Canada number typed without a country code
 * (10 digits, or 11 starting with 1) is read as +1; anything else needs its
 * `+` or `00` prefix.
 */

const E164 = /^\+[1-9]\d{6,14}$/

/** True for a well-formed E.164 number. */
export function isE164(value: unknown): value is string {
  return typeof value === 'string' && E164.test(value)
}

/**
 * True for a US/Canada (NANP) number: +1, then ten digits whose area code
 * doesn't start with 0 or 1. Native Intelligence texts only these (Phase 1, a +1 long
 * code under US 10DLC): an allow-list against SMS pumping, where someone
 * makes the app text premium international numbers.
 */
export function isNanpNumber(e164: unknown): boolean {
  return typeof e164 === 'string' && /^\+1[2-9]\d{9}$/.test(e164)
}

/** The number in E.164, or null when it can't be one. */
export function normalizeE164(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (!raw || raw.length > 32) return null
  // Allow the usual separators only; letters (vanity numbers) are refused.
  if (!/^[+\d\s().-]+$/.test(raw)) return null
  const digits = raw.replace(/\D/g, '')
  let e164: string
  if (raw.startsWith('+')) e164 = `+${digits}`
  else if (digits.startsWith('00')) e164 = `+${digits.slice(2)}`
  else if (digits.length === 10) e164 = `+1${digits}`
  else if (digits.length === 11 && digits.startsWith('1')) e164 = `+${digits}`
  else return null
  return isE164(e164) ? e164 : null
}

/** The number for display with all but its last four digits hidden: "+1 ••• ••• 4567". */
export function maskPhone(e164: string): string {
  const last = e164.slice(-4)
  const country = e164.startsWith('+1') ? '+1' : e164.slice(0, Math.min(3, e164.length - 4))
  return `${country} ••• ••• ${last}`
}
