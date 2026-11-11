/**
 * Making and changing booking links (availability phase 4a): what the
 * account API (Settings) and the agent's tools both call.
 *
 *   createLink   a new link under the person's own handle (made from their
 *                name the first time), or the workspace's (`team`: owners
 *                and admins). Its hosts default to the person.
 *   changeLink   any of its fields, its hosts, on or off.
 *   turnOffLink  delete is a turn-off: the page stops taking bookings, the
 *                bookings it made stay.
 *   setHandle    the person's handle, or the workspace's (owners and admins).
 *
 * Who may edit a link: its owner, or an owner or admin of the workspace; a
 * workspace guest never makes, edits or hosts one. A host is someone whose
 * calendar the public page reads and books into (the invitations go out
 * from their own account), so each host consents in a concrete way: the
 * editor themself, or a member who shares their availability AND whom an
 * owner or admin adds (a plain member adds only themself). A host already
 * on the link stays on through other changes. A business's job link keeps
 * its shape (its owner the one host, every request on their yes, the address
 * question): only its times, length, notice, window, description and on/off
 * change here.
 *
 * Server only; service role, every read fenced to the workspace. Never
 * throws: every outcome is a result.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { readSharing } from '@/lib/availability/sharing'
import { readWeekly } from '@/lib/availability/schedule'
import { isStorableTimeZone } from '@/lib/agent-events/member-time-zone'
import { hostDisplayName } from '@/lib/time-offers/offers'
import { questionId, slugFromTitle, type CreateLinkInput, type LinkFieldsInput } from './input'
import { countLinks, deleteLinkRow, getLink, getProfile, insertLink, listLinks, setProfileHandle, updateLink, type LinkColumns, type LinkWrite } from './store'
import { LINK_DEFAULTS, LINKS_PER_WORKSPACE_MAX, PROFILE_HANDLE_RE, type BookingLink, type BookingProfile, type LinkHost, type LinkQuestion } from './types'

export type LinkFailure = { ok: false; code: 'BAD_INPUT' | 'NOT_FOUND' | 'NOT_ALLOWED' | 'SLUG_TAKEN' | 'HANDLE_TAKEN' | 'LIMIT' | 'FAILED'; message: string }
export type LinkResult = { ok: true; link: BookingLink } | LinkFailure

const fail = (code: LinkFailure['code'], message: string): LinkFailure => ({ ok: false, code, message })

export interface Editor {
  workspaceId: string
  userId: string
}

/** The editor's role in the workspace, or null when they aren't a member. Throws on a failed read. */
async function roleOf(supabase: SupabaseClient, editor: Pick<Editor, 'workspaceId' | 'userId'>): Promise<string | null> {
  const { data, error } = await supabase.from('member').select('role').eq('workspace_id', editor.workspaceId).eq('user_id', editor.userId).maybeSingle<{ role: string | null }>()
  if (error) throw new Error(`member read failed: ${error.message}`)
  return data ? (data.role ?? 'member') : null
}

const isManager = (role: string | null) => role === 'owner' || role === 'admin'
/** A workspace guest (512) is a member row too, and never makes, edits or hosts a link. */
const isGuest = (role: string | null) => role === 'guest'

/** Whether the editor may change this link: its owner, or a workspace owner or admin; never a workspace guest. Pure. */
export function mayEdit(link: Pick<BookingLink, 'ownerUserId' | 'purpose'>, editor: Pick<Editor, 'userId'>, role: string | null): boolean {
  if (!role || isGuest(role)) return false
  if (link.purpose === 'job') return isManager(role)
  return link.ownerUserId === editor.userId || isManager(role)
}

/** The questions as stored: ids made from labels, each id once. Pure. */
export function questionsOf(input: NonNullable<LinkFieldsInput['questions']>): LinkQuestion[] {
  const seen = new Set<string>()
  return input.map((q) => {
    let id = q.id ?? questionId(q.label)
    for (let n = 2; seen.has(id); n++) id = `${(q.id ?? questionId(q.label)).slice(0, 36)}-${n}`
    seen.add(id)
    return { id, label: q.label.trim(), required: q.required === true, kind: q.kind ?? 'text' }
  })
}

/** The fields as the table's columns, or why they don't make a link. Pure. */
export function columnsOf(input: LinkFieldsInput): { columns: LinkColumns } | LinkFailure {
  const columns: LinkColumns = {}
  if (input.title !== undefined) columns.title = input.title
  if (input.slug !== undefined) columns.slug = input.slug
  if (input.description !== undefined) columns.description = input.description?.trim() || null
  if (input.duration_minutes !== undefined) columns.duration_minutes = input.duration_minutes
  if (input.buffer_before_minutes !== undefined) columns.buffer_before_minutes = input.buffer_before_minutes
  if (input.buffer_after_minutes !== undefined) columns.buffer_after_minutes = input.buffer_after_minutes
  if (input.notice_minutes !== undefined) columns.notice_minutes = input.notice_minutes
  if (input.window_days !== undefined) columns.window_days = input.window_days
  if (input.step_minutes !== undefined) columns.step_minutes = input.step_minutes
  if (input.daily_cap !== undefined) columns.daily_cap = input.daily_cap
  if (input.questions !== undefined) columns.questions = questionsOf(input.questions)
  if (input.video !== undefined) columns.video = input.video
  if (input.location !== undefined) columns.location = input.location?.trim() || null
  if (input.ask_first !== undefined) columns.ask_first = input.ask_first
  if (input.host_mode !== undefined) columns.host_mode = input.host_mode
  if (input.active !== undefined) columns.active = input.active
  if (input.weekly_hours !== undefined) {
    if (input.weekly_hours === null) columns.weekly_hours = null
    else {
      const weekly = readWeekly(input.weekly_hours)
      if (!weekly) return fail('BAD_INPUT', 'weekly_hours needs seven days (Sunday first), each a list of HH:MM ranges that end after they start and do not overlap.')
      columns.weekly_hours = weekly
    }
  }
  if (input.time_zone !== undefined) {
    if (input.time_zone !== null && !isStorableTimeZone(input.time_zone)) return fail('BAD_INPUT', `"${input.time_zone}" is not a time zone. Use an IANA name like America/New_York.`)
    columns.time_zone = input.time_zone
  }
  return { columns }
}

/** Hosts as stored, in the order given. Pure. */
const hostsOf = (ids: readonly string[]): LinkHost[] => [...new Set(ids)].map((userId, position) => ({ userId, position }))

/**
 * Whether these may host a link the editor (of `editorRole`) sets up (see the
 * header): the editor themself, or, added by an owner or admin, a member who
 * isn't a workspace guest and shares their availability. `kept` are already
 * on the link: they stay. The refusal, or null. Throws on a failed read.
 */
async function hostRefusal(
  supabase: SupabaseClient,
  editor: Editor,
  editorRole: string | null,
  hosts: readonly LinkHost[],
  mode: string,
  kept: ReadonlySet<string> = new Set(),
): Promise<LinkFailure | null> {
  if (mode === 'one' && hosts.length !== 1) return fail('BAD_INPUT', "host_mode 'one' takes exactly one host.")
  for (const host of hosts) {
    if (host.userId === editor.userId || kept.has(host.userId)) continue
    if (!isManager(editorRole)) return fail('NOT_ALLOWED', "Only the workspace's owner or an admin adds someone else as a host: their calendar would take the bookings. Add yourself, or ask them to make their own link.")
    const hostRole = await roleOf(supabase, { workspaceId: editor.workspaceId, userId: host.userId })
    if (!hostRole) return fail('BAD_INPUT', 'Every host must be a member of this workspace.')
    if (isGuest(hostRole)) return fail('NOT_ALLOWED', "A guest of the workspace can't host a booking link.")
    let sharing
    try {
      sharing = await readSharing(supabase, { userId: host.userId, workspaceId: editor.workspaceId })
    } catch (err) {
      if (err instanceof Error && /not a member/i.test(err.message)) return fail('BAD_INPUT', 'Every host must be a member of this workspace.')
      throw err
    }
    if (sharing === 'none') {
      const name = (await hostDisplayName(supabase, editor.workspaceId, host.userId).catch(() => null)) ?? 'One of them'
      return fail('NOT_ALLOWED', `${name} doesn't share their availability in this workspace, so they can't be made a host of a booking link. They can add themselves.`)
    }
  }
  return null
}

function fromWrite(written: LinkWrite): LinkResult {
  if (written.ok) return written
  if (written.reason === 'slug_taken') return fail('SLUG_TAKEN', 'Another link already has that address: pick another slug.')
  if (written.reason === 'invalid') return fail('BAD_INPUT', written.error ?? 'That link is not valid.')
  return fail('FAILED', written.error ?? 'The link could not be saved.')
}

/** A handle made from a person's name: "Dana Wu" → "dana-wu". Pure. */
export function handleFromName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return PROFILE_HANDLE_RE.test(base) ? base : `${base || 'book'}-me`.slice(0, 40)
}

/** The person's (or workspace's) profile, made the first time from their name with the first free suffix. Throws when none can be made. */
export async function ensureProfile(supabase: SupabaseClient, owner: { workspaceId: string; userId: string | null }, nameHint: string): Promise<BookingProfile> {
  const existing = await getProfile(supabase, owner)
  if (existing) return existing
  const base = handleFromName(nameHint)
  for (let n = 1; n <= 9; n++) {
    const made = await setProfileHandle(supabase, owner, n === 1 ? base : `${base.slice(0, 44)}-${n}`)
    if (made.ok) return made.profile
    if (made.reason !== 'taken') throw new Error(made.error ?? 'The booking handle could not be made.')
  }
  const made = await setProfileHandle(supabase, owner, `${base.slice(0, 38)}-${Math.random().toString(36).slice(2, 8)}`)
  if (!made.ok) throw new Error(made.error ?? 'The booking handle could not be made.')
  return made.profile
}

/** The first slug under a profile that no link of its has, from `wanted`. Pure. */
export function freeSlug(wanted: string, taken: ReadonlySet<string>): string {
  if (!taken.has(wanted)) return wanted
  for (let n = 2; n < 100; n++) {
    const candidate = `${wanted.slice(0, 44)}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${wanted.slice(0, 40)}-${Date.now().toString(36).slice(-6)}`
}

/** Make a link (see the header). */
export async function createLink(supabase: SupabaseClient, editor: Editor, input: CreateLinkInput): Promise<LinkResult> {
  try {
    const role = await roleOf(supabase, editor)
    if (!role) return fail('NOT_ALLOWED', 'Not a member of this workspace.')
    if (isGuest(role)) return fail('NOT_ALLOWED', "A guest of the workspace can't make booking links.")
    if (input.team && !isManager(role)) return fail('NOT_ALLOWED', "Only the workspace's owner or an admin makes a team link.")
    if ((await countLinks(supabase, editor.workspaceId)) >= LINKS_PER_WORKSPACE_MAX) return fail('LIMIT', `A workspace keeps at most ${LINKS_PER_WORKSPACE_MAX} booking links: turn one off and delete it first.`)
    const made = columnsOf(input)
    if ('code' in made) return made
    const { columns } = made
    const hosts = hostsOf(input.hosts ?? [editor.userId])
    const mode = columns.host_mode ?? LINK_DEFAULTS.hostMode
    const refused = await hostRefusal(supabase, editor, role, hosts, mode)
    if (refused) return refused

    const name = input.team
      ? ((await supabase.from('workspace').select('name').eq('id', editor.workspaceId).maybeSingle<{ name: string | null }>()).data?.name ?? 'team')
      : ((await hostDisplayName(supabase, editor.workspaceId, editor.userId)) ?? 'me')
    const profile = await ensureProfile(supabase, { workspaceId: editor.workspaceId, userId: input.team ? null : editor.userId }, name)
    const siblings = await listLinks(supabase, { workspaceId: editor.workspaceId })
    const slug = input.slug ?? freeSlug(slugFromTitle(input.title), new Set(siblings.filter((l) => l.profileId === profile.id).map((l) => l.slug)))
    return fromWrite(
      await insertLink(
        supabase,
        {
          duration_minutes: LINK_DEFAULTS.durationMinutes,
          buffer_before_minutes: LINK_DEFAULTS.bufferBeforeMinutes,
          buffer_after_minutes: LINK_DEFAULTS.bufferAfterMinutes,
          notice_minutes: LINK_DEFAULTS.noticeMinutes,
          window_days: LINK_DEFAULTS.windowDays,
          step_minutes: null,
          daily_cap: null,
          questions: [],
          video: LINK_DEFAULTS.video,
          location: null,
          ask_first: LINK_DEFAULTS.askFirst,
          weekly_hours: null,
          time_zone: null,
          description: null,
          active: true,
          ...columns,
          workspace_id: editor.workspaceId,
          owner_user_id: editor.userId,
          profile_id: profile.id,
          purpose: 'meeting',
          slug,
          title: input.title,
          host_mode: mode,
        },
        hosts,
      ),
    )
  } catch (err) {
    return fail('FAILED', err instanceof Error ? err.message : String(err))
  }
}

/** What a job link lets change (see the header). */
const JOB_FIELDS = new Set<keyof LinkFieldsInput>(['duration_minutes', 'notice_minutes', 'window_days', 'weekly_hours', 'time_zone', 'description', 'active'])

/** Change a link (see the header). */
export async function changeLink(supabase: SupabaseClient, editor: Editor, linkId: string, input: LinkFieldsInput): Promise<LinkResult> {
  try {
    const link = await getLink(supabase, linkId, editor.workspaceId)
    if (!link) return fail('NOT_FOUND', 'No booking link with that id in this workspace.')
    const role = await roleOf(supabase, editor)
    if (!mayEdit(link, editor, role)) return fail('NOT_ALLOWED', link.purpose === 'job' ? "Only the workspace's owner or an admin changes the business's booking page." : "Only the link's owner, or the workspace's owner or an admin, changes it.")
    if (link.purpose === 'job') {
      const other = (Object.keys(input) as Array<keyof LinkFieldsInput>).filter((k) => input[k] !== undefined && !JOB_FIELDS.has(k))
      if (other.length) return fail('BAD_INPUT', `The business's booking page keeps its own ${other.join(', ')}: change its hours, length, notice, window, description or turn it on or off.`)
    }
    const made = columnsOf(input)
    if ('code' in made) return made
    const { columns } = made
    if (link.purpose === 'job' && columns.duration_minutes !== undefined) columns.step_minutes = columns.duration_minutes
    const hosts = input.hosts ? hostsOf(input.hosts) : undefined
    if (hosts || columns.host_mode) {
      const refused = await hostRefusal(supabase, editor, role, hosts ?? link.hosts, columns.host_mode ?? link.hostMode, new Set(link.hosts.map((h) => h.userId)))
      if (refused) return refused
    }
    return fromWrite(await updateLink(supabase, link, columns, hosts))
  } catch (err) {
    return fail('FAILED', err instanceof Error ? err.message : String(err))
  }
}

/** Turn a link off (delete is a turn-off: see the header). */
export async function turnOffLink(supabase: SupabaseClient, editor: Editor, linkId: string): Promise<LinkResult> {
  return changeLink(supabase, editor, linkId, { active: false })
}

/**
 * Delete a link for good (Settings' Delete; the agent only turns one off):
 * its page goes, the meetings it booked stay. A business's job link is never
 * deleted, only turned off.
 */
export async function deleteLink(supabase: SupabaseClient, editor: Editor, linkId: string): Promise<{ ok: true; link: BookingLink } | LinkFailure> {
  try {
    const link = await getLink(supabase, linkId, editor.workspaceId)
    if (!link) return fail('NOT_FOUND', 'No booking link with that id in this workspace.')
    if (!mayEdit(link, editor, await roleOf(supabase, editor))) return fail('NOT_ALLOWED', "Only the link's owner, or the workspace's owner or an admin, deletes it.")
    if (link.purpose === 'job') return fail('BAD_INPUT', "The business's booking page can be turned off, not deleted.")
    const gone = await deleteLinkRow(supabase, link)
    return gone.ok ? { ok: true, link } : fail('FAILED', gone.error)
  } catch (err) {
    return fail('FAILED', err instanceof Error ? err.message : String(err))
  }
}

export type HandleResult = { ok: true; profile: BookingProfile } | LinkFailure

/** Set the person's handle, or (scope workspace: owners and admins) the workspace's. */
export async function setHandle(supabase: SupabaseClient, editor: Editor, input: { handle: string; scope?: 'me' | 'workspace' }): Promise<HandleResult> {
  try {
    const role = await roleOf(supabase, editor)
    if (!role) return fail('NOT_ALLOWED', 'Not a member of this workspace.')
    if (isGuest(role)) return fail('NOT_ALLOWED', "A guest of the workspace can't have a booking handle.")
    if (input.scope === 'workspace' && !isManager(role)) return fail('NOT_ALLOWED', "Only the workspace's owner or an admin changes its handle.")
    const made = await setProfileHandle(supabase, { workspaceId: editor.workspaceId, userId: input.scope === 'workspace' ? null : editor.userId }, input.handle)
    if (made.ok) return made
    if (made.reason === 'taken') return fail('HANDLE_TAKEN', 'That handle is taken: pick another.')
    if (made.reason === 'invalid') return fail('BAD_INPUT', made.error ?? 'That handle is not valid.')
    return fail('FAILED', made.error ?? 'The handle could not be saved.')
  } catch (err) {
    return fail('FAILED', err instanceof Error ? err.message : String(err))
  }
}

/** The link's public address. */
export function linkUrl(origin: string, link: Pick<BookingLink, 'profileHandle' | 'slug'>): string | null {
  return link.profileHandle ? `${origin.replace(/\/$/, '')}/book/${link.profileHandle}/${link.slug}` : null
}

/** A link as the account API and the tools show it. Pure. */
export function linkView(link: BookingLink, origin: string) {
  return {
    id: link.id,
    url: linkUrl(origin, link),
    profile: link.profileHandle,
    slug: link.slug,
    purpose: link.purpose,
    title: link.title,
    description: link.description,
    duration_minutes: link.durationMinutes,
    buffer_before_minutes: link.bufferBeforeMinutes,
    buffer_after_minutes: link.bufferAfterMinutes,
    notice_minutes: link.noticeMinutes,
    window_days: link.windowDays,
    step_minutes: link.stepMinutes,
    daily_cap: link.dailyCap,
    questions: link.questions,
    video: link.video,
    location: link.location,
    ask_first: link.askFirst,
    host_mode: link.hostMode,
    hosts: link.hosts.map((h) => h.userId),
    owner_user_id: link.ownerUserId,
    weekly_hours: link.weeklyHours,
    time_zone: link.timeZone,
    active: link.active,
    created_at: link.createdAt,
    updated_at: link.updatedAt,
  }
}

export type LinkView = ReturnType<typeof linkView>
