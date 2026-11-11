/**
 * Booking links (availability phase 4a, migration 581): standing public
 * pages (/book/<profile handle>/<slug>) anyone can book a time from. The
 * shapes and limits every part shares: the store, the times, the booking,
 * the public API, the account API and the agent's tools.
 *
 * Pure and client-safe.
 */
import type { DayRange } from '@/lib/availability/engine'

/** one: a single host. all: every host must be free, and all attend. any: any one host (the least booked, ties by order). */
export const HOST_MODES = ['one', 'all', 'any'] as const
export type HostMode = (typeof HOST_MODES)[number]

/** meeting: a booking link. job: a business's customer booking page (its rules once business_profile's). */
export const LINK_PURPOSES = ['meeting', 'job'] as const
export type LinkPurpose = (typeof LINK_PURPOSES)[number]

export const QUESTION_KINDS = ['text', 'long'] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]

export interface LinkQuestion {
  /** Stable within the link: what an answer names. */
  id: string
  label: string
  required: boolean
  kind: QuestionKind
}

export interface LinkHost {
  userId: string
  /** The stable order: the organizer of an `all` booking, the tie-break of `any`. */
  position: number
}

export interface BookingProfile {
  id: string
  workspaceId: string
  /** Null: the workspace's own handle (its team links and job link). */
  userId: string | null
  handle: string
}

export interface BookingLink {
  id: string
  workspaceId: string
  ownerUserId: string
  profileId: string | null
  /** The profile's handle, when it was read with the link. */
  profileHandle: string | null
  slug: string
  purpose: LinkPurpose
  title: string
  description: string | null
  durationMinutes: number
  bufferBeforeMinutes: number
  bufferAfterMinutes: number
  noticeMinutes: number
  windowDays: number
  /** The grid its times start on; null: the length. */
  stepMinutes: number | null
  dailyCap: number | null
  questions: LinkQuestion[]
  video: boolean
  location: string | null
  askFirst: boolean
  hostMode: HostMode
  /** The link's own hours (seven days, Sunday first) in timeZone; null: each host's working hours. */
  weeklyHours: DayRange[][] | null
  timeZone: string | null
  /** A job link's word for the job ("pickup"). */
  jobKind: string | null
  active: boolean
  /** In their stable order. */
  hosts: LinkHost[]
  createdAt: string
  updatedAt: string
}

/** The most links one workspace keeps. */
export const LINKS_PER_WORKSPACE_MAX = 50
/** The most hosts one link has. */
export const LINK_HOSTS_MAX = 10
export const LINK_QUESTIONS_MAX = 10
export const LINK_TITLE_MAX = 120
export const LINK_DESCRIPTION_MAX = 1000
export const LINK_LOCATION_MAX = 200
export const QUESTION_LABEL_MAX = 120
export const ANSWER_MAX = 500
export const LINK_NOTE_MAX = 500

/** 1 to 48 lower-case letters, digits or dashes, not starting or ending with a dash. */
export const LINK_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/
/** 3 to 48 of the same: a profile handle (a business's booking slug before 581). */
export const PROFILE_HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/

/** The defaults a new link takes. */
export const LINK_DEFAULTS = {
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  noticeMinutes: 240,
  windowDays: 30,
  video: true,
  askFirst: false,
  hostMode: 'one' as HostMode,
}

/** The ranges the table holds (migration 581 booking_link_ranges). */
export const LINK_LIMITS = {
  durationMinutes: [5, 480],
  bufferMinutes: [0, 240],
  noticeMinutes: [0, 20160],
  windowDays: [1, 180],
  stepMinutes: [5, 480],
  dailyCap: [1, 100],
} as const

/**
 * Bookings one link's public page tries per hour before it answers 429 (every
 * try reads the hosts' calendars). Only a try with a guest's name and a way to
 * reach them counts, and one client's tries count against that client first
 * (LINK_CLIENT_HOURLY_CAP): one stranger can't close the page for everyone.
 */
export const LINK_ATTEMPTS_HOURLY_CAP = 30
/**
 * Bookings one client (its address, hashed) tries per hour across every
 * booking page: each may have a host's calendar email the address typed, so
 * the pages are no mail cannon.
 */
export const LINK_CLIENT_HOURLY_CAP = 5
/** Reads of booking pages' times one client makes per minute on one instance. */
export const LINK_TIMES_CLIENT_PER_MINUTE = 60
/** Bookings one guest (by email or number) makes on one link per day. */
export const LINK_GUEST_DAILY_CAP = 2
/** The most days one public read of a link's times covers. */
export const LINK_TIMES_DAYS_MAX = 31
/** The most times one read returns. */
export const LINK_TIMES_MAX = 300
/** How long a request waiting on the host's yes holds its time: its approval's day, and a little over, so the approval settles it first. */
export const LINK_REQUEST_HOLD_MS = 24 * 60 * 60_000 + 15 * 60_000

// ── What the public API answers ─────────────────────────────────────────────

/** How the page reaches the guest: an email (the calendar's invitation), a US or Canadian mobile (a text), or either. */
export type GuestContact = 'email' | 'phone' | 'email_or_phone'

/** GET /api/public/booking-links/<profile>/<slug>'s `link`. */
export interface PublicLinkData {
  profile: string
  slug: string
  purpose: LinkPurpose
  title: string
  description: string | null
  duration_minutes: number
  /** How many days ahead it opens (from today): the page's date picker goes no further. */
  window_days: number
  host_mode: HostMode
  /** Display names, in the hosts' order (an `any` link's: who might take it). */
  host_names: string[]
  questions: Array<{ id: string; label: string; required: boolean; kind: QuestionKind }>
  /** The zone the hosts' times are worked in (the organizer's): the page's default before it knows the guest's. */
  time_zone: string
  video: boolean
  location: string | null
  /** Each booking waits for the host's yes. A mobile-only guest always does (they are texted only after it). */
  ask_first: boolean
  contact: GuestContact
}

/** GET …/times. */
export interface PublicLinkTimes {
  time_zone: string
  from: string
  to: string
  slots: Array<{ start: string; end: string }>
}

/** POST …/book's 201. */
export interface PublicLinkBooked {
  ok: true
  /** confirmed, booking (the calendar event is being written), or requested (waiting on the host's yes). */
  status: 'confirmed' | 'booking' | 'requested'
  booking: { start: string; end: string; title: string; host_name: string; video: boolean; conference_url: string | null; location: string | null }
  /** The guest's manage page (/b/<token>); null for a business's job request (they are texted). */
  manage_url: string | null
}
