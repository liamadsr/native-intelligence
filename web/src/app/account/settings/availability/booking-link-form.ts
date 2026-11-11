/**
 * Settings → Availability → Booking links: what the link dialog edits
 * (./booking-link-dialog.tsx), the account API's link as Settings reads it
 * (GET /api/account/booking-links, src/lib/booking-links/links.ts linkView),
 * and the body a save sends: a new link's fields, or only what changed.
 *
 * Pure.
 */
import { slugFromTitle } from '@/lib/booking-links/input'
import { LINK_DEFAULTS, LINK_SLUG_RE, type HostMode, type LinkQuestion } from '@/lib/booking-links/types'
import { lengthLabel } from '@/lib/time-offers/display'

/** One link as GET /api/account/booking-links lists it. */
export interface SettingsLink {
  id: string
  url: string | null
  profile: string | null
  slug: string
  purpose: 'meeting' | 'job'
  title: string
  description: string | null
  duration_minutes: number
  buffer_before_minutes: number
  buffer_after_minutes: number
  notice_minutes: number
  window_days: number
  questions: LinkQuestion[]
  video: boolean
  /** Meet on a call here (migration 576); absent from a server without it. */
  call_here?: boolean
  location: string | null
  ask_first: boolean
  host_mode: HostMode
  hosts: string[]
  owner_user_id: string
  active: boolean
  can_edit: boolean
}

export interface DraftQuestion {
  /** The saved question's id; none for one added in the dialog (the server makes it from the label). */
  id?: string
  label: string
  required: boolean
  kind: LinkQuestion['kind']
}

export interface LinkDraft {
  title: string
  slug: string
  /** The slug was typed: the title no longer writes it. */
  slugTyped: boolean
  description: string
  durationMinutes: number
  bufferBeforeMinutes: number
  bufferAfterMinutes: number
  noticeMinutes: number
  windowDays: number
  questions: DraftQuestion[]
  video: boolean
  /** The video call is one of our meeting links, not the calendar's (offered only where calling is set up). */
  callHere: boolean
  location: string
  askFirst: boolean
  hosts: string[]
  /** With more than one host: everyone attends (all), or any one of them (any). */
  shared: Exclude<HostMode, 'one'>
  /** Under the workspace's address, not the person's (a new link, by an owner or admin). */
  team: boolean
}

export const LENGTH_OPTIONS = [15, 20, 30, 45, 60, 90, 120]
export const BUFFER_OPTIONS = [0, 5, 10, 15, 30, 60]
export const NOTICE_OPTIONS = [0, 60, 120, 240, 720, 1440, 2880, 10080]
export const WINDOW_OPTIONS = [7, 14, 30, 60, 90]

/** The options, with `value` among them when it is one the person set some other way (the agent). */
export function withValue(options: readonly number[], value: number): number[] {
  return options.includes(value) ? [...options] : [...options, value].sort((a, b) => a - b)
}

/** "None", "1 hour", "4 hours", "1 day", "1 week". */
export function noticeLabel(minutes: number): string {
  if (minutes === 0) return 'None'
  if (minutes % 10080 === 0) return minutes === 10080 ? '1 week' : `${minutes / 10080} weeks`
  if (minutes % 1440 === 0) return minutes === 1440 ? '1 day' : `${minutes / 1440} days`
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`
  return `${minutes} min`
}

/** A new link: one click and a title. The person its one host. */
export function newDraft(me: string): LinkDraft {
  return {
    title: '',
    slug: '',
    slugTyped: false,
    description: '',
    durationMinutes: LINK_DEFAULTS.durationMinutes,
    bufferBeforeMinutes: LINK_DEFAULTS.bufferBeforeMinutes,
    bufferAfterMinutes: LINK_DEFAULTS.bufferAfterMinutes,
    noticeMinutes: LINK_DEFAULTS.noticeMinutes,
    windowDays: LINK_DEFAULTS.windowDays,
    questions: [],
    video: LINK_DEFAULTS.video,
    callHere: false,
    location: '',
    askFirst: LINK_DEFAULTS.askFirst,
    hosts: me ? [me] : [],
    shared: 'all',
    team: false,
  }
}

/** A saved link as the dialog edits it. */
export function draftOf(link: SettingsLink): LinkDraft {
  return {
    title: link.title,
    slug: link.slug,
    slugTyped: true,
    description: link.description ?? '',
    durationMinutes: link.duration_minutes,
    bufferBeforeMinutes: link.buffer_before_minutes,
    bufferAfterMinutes: link.buffer_after_minutes,
    noticeMinutes: link.notice_minutes,
    windowDays: link.window_days,
    questions: link.questions.map((q) => ({ id: q.id, label: q.label, required: q.required, kind: q.kind })),
    video: link.video,
    callHere: link.call_here === true,
    location: link.location ?? '',
    askFirst: link.ask_first,
    hosts: [...link.hosts],
    shared: link.host_mode === 'any' ? 'any' : 'all',
    team: false,
  }
}

/** The title typed: the slug follows it until the slug is typed itself. */
export function withTitle(draft: LinkDraft, title: string): LinkDraft {
  return { ...draft, title, slug: draft.slugTyped ? draft.slug : title.trim() ? slugFromTitle(title) : '' }
}

/** A slug as it's typed: lower case, spaces as dashes, nothing else. */
export function typedSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 48)
}

/** The first thing to fix before saving, or null. */
export function draftProblem(draft: LinkDraft): string | null {
  if (!draft.title.trim()) return 'Give it a title.'
  if (draft.slug && !LINK_SLUG_RE.test(draft.slug)) return 'The address is lower-case letters, digits and dashes, not starting or ending with a dash.'
  if (!draft.video && !draft.location.trim()) return 'Say where, or turn the video call on.'
  if (!draft.hosts.length) return 'Pick at least one host.'
  if (draft.questions.some((q) => !q.label.trim())) return 'Each question needs its wording, or remove it.'
  return null
}

const hostModeOf = (draft: LinkDraft): HostMode => (draft.hosts.length > 1 ? draft.shared : 'one')

/** Every field of the draft, as the account API names them. */
function fieldsOf(draft: LinkDraft): Record<string, unknown> {
  return {
    title: draft.title.trim(),
    ...(draft.slug ? { slug: draft.slug } : {}),
    description: draft.description.trim() || null,
    duration_minutes: draft.durationMinutes,
    buffer_before_minutes: draft.bufferBeforeMinutes,
    buffer_after_minutes: draft.bufferAfterMinutes,
    notice_minutes: draft.noticeMinutes,
    window_days: draft.windowDays,
    questions: draft.questions.map((q) => ({ ...(q.id ? { id: q.id } : {}), label: q.label.trim(), required: q.required, kind: q.kind })),
    video: draft.video,
    call_here: draft.video && draft.callHere,
    location: draft.video ? null : draft.location.trim() || null,
    ask_first: draft.askFirst,
    hosts: draft.hosts,
    host_mode: hostModeOf(draft),
  }
}

/** POST /api/account/booking-links's body. */
export function createBody(draft: LinkDraft): Record<string, unknown> {
  return { ...fieldsOf(draft), ...(draft.team ? { team: true } : {}) }
}

/** PATCH /api/account/booking-links/<id>'s body: only what changed (empty: nothing to save). */
export function patchBody(link: SettingsLink, draft: LinkDraft): Record<string, unknown> {
  const before = fieldsOf(draftOf(link))
  const after = fieldsOf(draft)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(value) !== JSON.stringify(before[key])) out[key] = value
  }
  // Hosts and how they share go together: the server checks the pair.
  if ('hosts' in out || 'host_mode' in out) {
    out.hosts = after.hosts
    out.host_mode = after.host_mode
  }
  return out
}

/** "30 min · Ada Finch", "1 hr · Ada Finch and Ben Ruiz", "45 min · any of 3". */
export function linkSummary(link: Pick<SettingsLink, 'duration_minutes' | 'host_mode' | 'hosts'>, nameOf: (userId: string) => string): string {
  const length = lengthLabel(link.duration_minutes)
  const names = link.hosts.map(nameOf)
  const hosts =
    names.length <= 1
      ? (names[0] ?? '')
      : link.host_mode === 'any'
        ? names.length > 2
          ? `any of ${names.length}`
          : `${names[0]} or ${names[1]}`
        : names.length > 2
          ? `${names[0]} and ${names.length - 1} others`
          : `${names[0]} and ${names[1]}`
  return hosts ? `${length} · ${hosts}` : length
}
