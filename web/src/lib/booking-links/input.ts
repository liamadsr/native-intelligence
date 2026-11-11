/**
 * What a booking link is made from (availability phase 4a): one schema for
 * the account API (src/app/api/account/booking-links/) and the agent's tools
 * (src/lib/ai/tools/booking-links.ts), so both refuse the same things. The
 * table's own checks (migration 581) hold the same ranges.
 *
 * Pure.
 */
import { z } from 'zod'
import { HOST_MODES, LINK_DESCRIPTION_MAX, LINK_HOSTS_MAX, LINK_LIMITS, LINK_LOCATION_MAX, LINK_QUESTIONS_MAX, LINK_SLUG_RE, LINK_TITLE_MAX, QUESTION_KINDS, QUESTION_LABEL_MAX } from './types'

const CLOCK = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/
const range = z.object({ start: z.string().regex(CLOCK), end: z.string().regex(CLOCK) })
const int = (min: number, max: number) => z.number().int().min(min).max(max)

export const linkQuestionInput = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional().describe('Stable id (made from the label when left out)'),
  label: z.string().trim().min(1).max(QUESTION_LABEL_MAX),
  required: z.boolean().optional(),
  kind: z.enum(QUESTION_KINDS).optional().describe("'text' (one line, the default) or 'long'"),
})

/** A link's fields as a change gives them (every one optional). */
export const linkFieldsInput = z.object({
  title: z.string().trim().min(1).max(LINK_TITLE_MAX).optional(),
  slug: z.string().trim().toLowerCase().regex(LINK_SLUG_RE, 'A slug is 1 to 48 lower-case letters, digits or dashes').optional().describe('The last part of its address: /book/<handle>/<slug>'),
  description: z.string().max(LINK_DESCRIPTION_MAX).nullable().optional(),
  duration_minutes: int(...LINK_LIMITS.durationMinutes).optional(),
  buffer_before_minutes: int(...LINK_LIMITS.bufferMinutes).optional().describe('Kept clear before each booking'),
  buffer_after_minutes: int(...LINK_LIMITS.bufferMinutes).optional().describe('Kept clear after each booking'),
  notice_minutes: int(...LINK_LIMITS.noticeMinutes).optional().describe('Nothing bookable sooner than this from now'),
  window_days: int(...LINK_LIMITS.windowDays).optional().describe('How many days ahead it opens'),
  step_minutes: int(...LINK_LIMITS.stepMinutes).nullable().optional().describe('The grid its times start on (null: the length)'),
  daily_cap: int(...LINK_LIMITS.dailyCap).nullable().optional().describe('At most this many of its bookings a day (null: no cap)'),
  questions: z.array(linkQuestionInput).max(LINK_QUESTIONS_MAX).optional(),
  video: z.boolean().optional().describe('A video link on each booking (default true)'),
  call_here: z.boolean().optional().describe("Meet on a call here: each booking gets one of our meeting links instead of the calendar's video link (only where calls are set up; default false)"),
  location: z.string().trim().max(LINK_LOCATION_MAX).nullable().optional().describe('Where, when not on video'),
  ask_first: z.boolean().optional().describe('Each request waits for the host to say yes'),
  host_mode: z.enum(HOST_MODES).optional().describe("'one' host, 'all' (everyone free, everyone attends) or 'any' (any one, the least booked)"),
  hosts: z.array(z.string().uuid()).min(1).max(LINK_HOSTS_MAX).optional().describe('Members who host it (user ids), in order; default the person'),
  weekly_hours: z.array(z.array(range).max(6)).length(7).nullable().optional().describe("The link's own hours, seven days Sunday first; null: each host's working hours"),
  time_zone: z.string().max(64).nullable().optional().describe("The zone of weekly_hours (default the person's)"),
  active: z.boolean().optional().describe('False turns it off: its page stops taking bookings'),
})

export type LinkFieldsInput = z.infer<typeof linkFieldsInput>

/** A new link: a title at least; `team` puts it under the workspace's handle instead of the person's. */
export const createLinkInput = linkFieldsInput.extend({
  title: z.string().trim().min(1).max(LINK_TITLE_MAX),
  team: z.boolean().optional().describe("Under the workspace's handle (owners and admins), not the person's"),
})

export type CreateLinkInput = z.infer<typeof createLinkInput>

/** The handle a person (or, `workspace`, the workspace) is booked at. */
export const handleInput = z.object({
  handle: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/, 'A handle is 3 to 48 lower-case letters, digits or dashes'),
  scope: z.enum(['me', 'workspace']).optional(),
})

/** A label as a question id: "Company name" → "company-name". Pure. */
export function questionId(label: string): string {
  return (
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'question'
  )
}

/** A title as a slug: "Intro call" → "intro-call". Pure. */
export function slugFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return LINK_SLUG_RE.test(slug) ? slug : 'meet'
}
