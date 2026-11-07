/**
 * A business profile change as the owner's route and the agent's
 * update_business_profile tool take it (snake_case, like the table), checked
 * before it is written: the table's checks hold the same shapes, so a bad
 * value is refused here with a sentence the agent can act on. Pure.
 */
import { BUSINESS_FACTS_MAX } from './types'
import type { BusinessProfilePatch } from './store'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/** True for an IANA zone this runtime knows. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() })
    return true
  } catch {
    return false
  }
}

/** A weekday as a number (0 Sunday .. 6 Saturday), from a number or its name ("mon", "Tuesday"). */
function dayNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6) return value
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  if (/^[0-6]$/.test(v)) return Number(v)
  const i = DAY_NAMES.findIndex((d) => v.length >= 3 && d.startsWith(v))
  return i >= 0 ? i : null
}

/** "9", "9am", "9:30", "17:00", "5pm" as 'HH:MM', or null. */
export function readClock(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase().replace(/\s+/g, '')
  if (HHMM.test(v)) return v
  const m = /^(\d{1,2})(?::([0-5]\d))?(am|pm)?$/.exec(v)
  if (!m) return null
  let h = Number(m[1])
  const min = m[2] ?? '00'
  if (m[3]) {
    if (h < 1 || h > 12) return null
    if (m[3] === 'pm' && h !== 12) h += 12
    if (m[3] === 'am' && h === 12) h = 0
  } else if (h > 23) return null
  return `${String(h).padStart(2, '0')}:${min}`
}

function intIn(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}

/** The patch a body asks for, or the first thing wrong with it. Unknown keys are ignored. */
export function parseProfilePatch(body: unknown): { patch: BusinessProfilePatch } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send the changes as an object.' }
  const b = body as Record<string, unknown>
  const patch: BusinessProfilePatch = {}
  if (b.business_name !== undefined) {
    if (typeof b.business_name !== 'string' || !b.business_name.trim() || b.business_name.trim().length > 120) return { error: 'business_name must be 1 to 120 characters.' }
    patch.businessName = b.business_name.trim()
  }
  if (b.customer_facts !== undefined) {
    if (b.customer_facts !== null && typeof b.customer_facts !== 'string') return { error: 'customer_facts must be text.' }
    if (typeof b.customer_facts === 'string' && b.customer_facts.length > BUSINESS_FACTS_MAX) return { error: `customer_facts is too long (at most ${BUSINESS_FACTS_MAX} characters).` }
    patch.customerFacts = b.customer_facts as string | null
  }
  if (b.time_zone !== undefined) {
    if (b.time_zone !== null && !isTimeZone(b.time_zone)) return { error: 'time_zone must be an IANA zone like "America/New_York".' }
    patch.timeZone = b.time_zone === null ? null : (b.time_zone as string).trim()
  }
  if (b.booking_days !== undefined) {
    if (!Array.isArray(b.booking_days) || b.booking_days.length > 7) return { error: 'booking_days must be a list of weekdays (0 Sunday .. 6 Saturday, or their names).' }
    const days = b.booking_days.map(dayNumber)
    if (days.some((d) => d === null)) return { error: 'booking_days must be weekdays (0 Sunday .. 6 Saturday, or their names).' }
    patch.bookingDays = days as number[]
  }
  for (const [field, key] of [['booking_start', 'bookingStart'], ['booking_end', 'bookingEnd']] as const) {
    if (b[field] === undefined) continue
    const clock = readClock(b[field])
    if (!clock) return { error: `${field} must be a time like "09:00" or "5pm".` }
    patch[key] = clock
  }
  if (patch.bookingStart && patch.bookingEnd && patch.bookingStart >= patch.bookingEnd) return { error: 'booking_start must be before booking_end.' }
  if (b.slot_minutes !== undefined) {
    const n = intIn(b.slot_minutes, 15, 480)
    if (n === null) return { error: 'slot_minutes must be a whole number from 15 to 480.' }
    patch.slotMinutes = n
  }
  if (b.lead_hours !== undefined) {
    const n = intIn(b.lead_hours, 0, 336)
    if (n === null) return { error: 'lead_hours must be a whole number from 0 to 336.' }
    patch.leadHours = n
  }
  if (b.horizon_days !== undefined) {
    const n = intIn(b.horizon_days, 1, 60)
    if (n === null) return { error: 'horizon_days must be a whole number from 1 to 60.' }
    patch.horizonDays = n
  }
  if (b.booking_kind !== undefined) {
    if (typeof b.booking_kind !== 'string' || !b.booking_kind.trim() || b.booking_kind.trim().length > 40) return { error: 'booking_kind must be a short word like "pickup".' }
    patch.bookingKind = b.booking_kind.trim().toLowerCase()
  }
  if (b.booking_slug !== undefined) {
    if (b.booking_slug !== null && (typeof b.booking_slug !== 'string' || !SLUG.test(b.booking_slug.trim().toLowerCase()))) {
      return { error: 'booking_slug must be 3 to 48 lower-case letters, digits or dashes, like "bright-loom".' }
    }
    patch.bookingSlug = b.booking_slug === null ? null : (b.booking_slug as string).trim().toLowerCase()
  }
  return { patch }
}

/** A booking link's slug made from a business name: "Bright Loom" → "bright-loom". Pure. */
export function slugFromName(name: string): string | null {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return SLUG.test(slug) ? slug : null
}

/** The quote form's URL for a key. */
export function intakeUrl(origin: string, key: string): string {
  return `${origin.replace(/\/$/, '')}/api/intake/quotes/${key}`
}

/** The public booking page's URL for a slug. */
export function bookingUrl(origin: string, slug: string): string {
  return `${origin.replace(/\/$/, '')}/book/${slug}`
}
