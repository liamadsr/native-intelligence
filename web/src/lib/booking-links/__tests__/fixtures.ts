/**
 * Booking links' test fixtures: a made-up studio (Fernhill), its two hosts,
 * a link of theirs, and the seams every booking passes (the calendar
 * account, the provider write, the host's line). Over the one booking model
 * in memory (src/test/booking-db.ts).
 */
import { vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { bookingDb } from '@/test/booking-db'
import type { LinkBookingDeps } from '../book'
import type { LinkSlot } from '../times'
import type { BookingLink } from '../types'

type Row = Record<string, unknown>

export const WS = 'ws-fernhill'
export const AVA = 'user-ava'
export const BEN = 'user-ben'
export const NY = 'America/New_York'

/** On the hour, `hours` from now: a time a link offers. */
export function hoursAhead(hours: number, now: number = Date.now()): string {
  return new Date(Math.ceil(now / 3_600_000) * 3_600_000 + hours * 3_600_000).toISOString()
}

export function linkOf(over: Partial<BookingLink> = {}): BookingLink {
  return {
    id: '0f1e2d3c-4b5a-4968-8776-655443322110',
    workspaceId: WS,
    ownerUserId: AVA,
    profileId: 'prof-ava',
    profileHandle: 'ava-lin',
    slug: 'intro',
    purpose: 'meeting',
    title: 'Intro call',
    description: 'A first chat.',
    durationMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    noticeMinutes: 0,
    windowDays: 30,
    stepMinutes: null,
    dailyCap: null,
    questions: [{ id: 'company', label: 'Company', required: true, kind: 'text' }],
    video: true,
    callHere: false,
    location: null,
    askFirst: false,
    hostMode: 'one',
    weeklyHours: null,
    timeZone: null,
    jobKind: null,
    active: true,
    hosts: [{ userId: AVA, position: 0 }],
    createdAt: '2030-12-01T00:00:00Z',
    updatedAt: '2030-12-01T00:00:00Z',
    ...over,
  }
}

export function studioDb(seed: Record<string, Row[]> = {}): { db: SupabaseClient; tables: Record<string, Row[]> } {
  const tables: Record<string, Row[]> = {
    workspace: [{ id: WS, name: 'Fernhill Studio' }],
    member: [
      { id: 'm-ava', workspace_id: WS, user_id: AVA, display_name: 'Ava Lin', role: 'owner', availability_sharing: 'busy_only' },
      { id: 'm-ben', workspace_id: WS, user_id: BEN, display_name: 'Ben Ruiz', role: 'member', availability_sharing: 'busy_only' },
    ],
    meeting_booking: [],
    host_time_claim: [],
    business_phone_number: [],
    ...seed,
  }
  return { db: bookingDb(tables), tables }
}

/** Times the link's read finds open: these starts, half an hour each, who can take them. */
export function openAt(starts: readonly string[], hostIds: readonly string[] = [AVA]) {
  const slots: LinkSlot[] = starts.map((s) => ({ start: Date.parse(s), end: Date.parse(s) + 30 * 60_000, hostIds: [...hostIds] }))
  return vi.fn(async () => ({ known: true as const, timeZone: NY, slots }))
}

/** Every seam a booking passes, the provider writing the event. */
export function seams(over: Partial<LinkBookingDeps> = {}) {
  const createEvent = vi.fn(async (_userId: string, event: { title: string; start: string; end: string; attendees?: string[] }, accountId?: string) => ({
    id: 'evt-1',
    title: event.title,
    start: event.start,
    end: event.end,
    conferenceUrl: 'https://meet.example/abc-defg-hij',
    calendarId: 'primary',
    accountId,
  }))
  const tellHost = vi.fn(async () => true)
  const textGuest = vi.fn(async () => true)
  const hostEmails = vi.fn(async (_ws: string, ids: readonly string[]) => ids.map((id) => `${id.replace('user-', '')}@fernhill.example`))
  const createApproval = vi.fn(async () => ({ ok: true as const, approvalId: 'appr-1', cardId: 'card-1' }))
  const deps: LinkBookingDeps = {
    secret: 'test-secret',
    origin: 'https://app.example',
    calendarAccount: vi.fn(async () => ({ id: 'acct-google', provider: 'google' as const })),
    findContact: vi.fn(async () => null),
    canText: vi.fn(async () => true),
    createApproval,
    accept: { secret: 'test-secret', origin: 'https://app.example', createEvent, tellHost, textGuest, hostEmails, deleteEvent: vi.fn(async () => {}) },
    ...over,
  }
  return { deps, createEvent, tellHost, textGuest, hostEmails, createApproval }
}
