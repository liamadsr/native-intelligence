/**
 * The customer front door's vocabulary (roadmap track B, migration 458;
 * docs/plans/customer-front-door.md): a service business's profile, its
 * customers' quotes and bookings, as the app reads them. Client-safe (no
 * server imports): the public booking page reads these shapes too.
 */

export const QUOTE_SOURCES = ['web_form', 'sms', 'phone', 'owner'] as const
export type QuoteSource = (typeof QUOTE_SOURCES)[number]

export const QUOTE_STATUSES = ['new', 'sent', 'accepted', 'declined', 'booked', 'done', 'cancelled'] as const
export type QuoteStatus = (typeof QUOTE_STATUSES)[number]

export const BOOKING_SOURCES = ['sms', 'link', 'phone', 'owner'] as const
export type BookingSource = (typeof BOOKING_SOURCES)[number]

export const BOOKING_STATES = ['requested', 'confirmed', 'declined', 'expired', 'cancelled'] as const
export type BookingState = (typeof BOOKING_STATES)[number]

/** The table's caps (migration 458). */
export const QUOTE_MAX_ITEMS = 50
export const QUOTE_NAME_MAX = 120
export const QUOTE_EMAIL_MAX = 254
export const QUOTE_ADDRESS_MAX = 300
export const QUOTE_SERVICE_MAX = 120
export const QUOTE_NOTES_MAX = 2000
export const QUOTE_EXTERNAL_ID_MAX = 120
export const QUOTE_REQUESTED_DATES_MAX = 10
export const QUOTE_TOTAL_MAX_CENTS = 100_000_000
export const BUSINESS_FACTS_MAX = 8000
export const BOOKING_NOTE_MAX = 1000
/**
 * How long a requested booking holds its slot: as long as the owner's
 * approval waits (src/lib/safety/approvals.ts APPROVAL_TTL_MS, a test keeps
 * them equal). Past it, the slot is open again.
 */
export const BOOKING_REQUEST_TTL_MS = 24 * 60 * 60 * 1000

/** One thing to quote: a rug, a room, a dog walk. Every field optional but the description. */
export interface QuoteItem {
  description: string
  service?: string
  /** Sizes as the form gave them: numbers in `unit` (ft, in, m, cm). */
  width?: number
  length?: number
  unit?: string
  /** A size the form sent as words ("8x10"), when it wasn't two numbers. */
  size?: string
  quantity?: number
  price_cents?: number
}

export interface CustomerQuote {
  id: string
  workspaceId: string
  contactId: string | null
  source: QuoteSource
  externalId: string | null
  status: QuoteStatus
  customerName: string | null
  customerEmail: string | null
  customerPhone: string | null
  address: string | null
  service: string | null
  items: QuoteItem[]
  totalCents: number | null
  currency: string
  requestedDates: string[]
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface BusinessProfile {
  workspaceId: string
  ownerUserId: string
  businessName: string
  /** What customers may be told: services, prices, area, FAQ. Their agent's only knowledge of the business. */
  customerFacts: string | null
  /** IANA zone; null reads the owner's own. */
  timeZone: string | null
  /** 0 Sunday .. 6 Saturday. */
  bookingDays: number[]
  /** 'HH:MM', 24 h, in the business's zone. */
  bookingStart: string
  bookingEnd: string
  slotMinutes: number
  leadHours: number
  horizonDays: number
  /** The job word customers see: "pickup", "visit", "walk". */
  bookingKind: string
  bookingSlug: string | null
  /** Text customers a reminder the day before a booked job or meeting (migration 471). On unless the owner turns it off. */
  reminders: boolean
}

export interface CustomerBooking {
  id: string
  workspaceId: string
  ownerUserId: string
  quoteId: string | null
  contactId: string | null
  guestId: string | null
  source: BookingSource
  kind: string
  startsAt: string
  endsAt: string
  customerName: string
  customerPhone: string | null
  address: string | null
  note: string | null
  state: BookingState
  approvalId: string | null
  calendarEventId: string | null
  /** The customer said yes to its reminder, or picked the time it moved to (migration 471). */
  customerConfirmedAt: string | null
  createdAt: string
}

/** A bookable slot, as the slot finder offers it. */
export interface OpenSlot {
  start: string
  end: string
}

/** Money as a customer reads it: "$600" or "$612.50". Pure. */
export function formatCents(cents: number | null | undefined, currency = 'usd'): string | null {
  if (typeof cents !== 'number' || !Number.isFinite(cents) || cents < 0) return null
  const whole = cents % 100 === 0
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(whole ? 0 : 2)} ${currency.toUpperCase()}`
  }
}

/** One item's size, as words: "8x10 ft", or the form's own words. Pure. */
export function itemSize(item: Pick<QuoteItem, 'width' | 'length' | 'unit' | 'size'>): string | null {
  if (typeof item.width === 'number' && typeof item.length === 'number') return `${trimNumber(item.width)}x${trimNumber(item.length)}${item.unit ? ` ${item.unit}` : ''}`
  return item.size?.trim() || null
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

/** A quote in one line, for a text or an event title: "2 rugs (8x10 ft, 5x7 ft), cleaning, $600". Pure. */
export function quoteSummary(quote: Pick<CustomerQuote, 'items' | 'service' | 'totalCents' | 'currency'>): string {
  const sizes = quote.items.map(itemSize).filter((s): s is string => !!s)
  const count = quote.items.reduce((n, item) => n + (typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1), 0)
  const what = count > 0 ? `${count} ${count === 1 ? 'item' : 'items'}${sizes.length ? ` (${sizes.slice(0, 4).join(', ')}${sizes.length > 4 ? ', …' : ''})` : ''}` : null
  const services = [...new Set([quote.service, ...quote.items.map((i) => i.service)].filter((s): s is string => !!s && !!s.trim()).map((s) => s.trim().toLowerCase()))]
  const price = formatCents(quote.totalCents, quote.currency)
  return [what, services.join(' and ') || null, price].filter(Boolean).join(', ') || 'a quote request'
}
