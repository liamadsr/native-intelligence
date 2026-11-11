/**
 * Rows of migration 581: booking_profile, booking_link, booking_link_host,
 * booking_link_attempt, and the reads of meeting_booking and
 * host_time_claim a link's page needs (its daily cap, who is least booked,
 * a guest's tries). Every write is the service role's; every read here is
 * fenced by id, handle or workspace. Throws on a failed read or write,
 * except where a function says what it answers.
 *
 * Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { readWeekly } from '@/lib/availability/schedule'
import { isConflict } from '@/lib/time-offers/store'
import {
  HOST_MODES,
  LINK_PURPOSES,
  PROFILE_HANDLE_RE,
  QUESTION_KINDS,
  type BookingLink,
  type BookingProfile,
  type HostMode,
  type LinkHost,
  type LinkPurpose,
  type LinkQuestion,
} from './types'

const LINK_COLUMNS =
  'id, workspace_id, owner_user_id, profile_id, slug, purpose, title, description, duration_minutes, buffer_before_minutes, buffer_after_minutes, notice_minutes, window_days, step_minutes, daily_cap, questions, video, location, ask_first, host_mode, weekly_hours, time_zone, job_kind, active, created_at, updated_at'
const PROFILE_COLUMNS = 'id, workspace_id, user_id, handle'
const HOST_COLUMNS = 'link_id, user_id, position'

export interface LinkRow {
  id: string
  workspace_id: string
  owner_user_id: string
  profile_id: string | null
  slug: string
  purpose: string
  title: string
  description: string | null
  duration_minutes: number
  buffer_before_minutes: number
  buffer_after_minutes: number
  notice_minutes: number
  window_days: number
  step_minutes: number | null
  daily_cap: number | null
  questions: unknown
  video: boolean
  location: string | null
  ask_first: boolean
  host_mode: string
  weekly_hours: unknown
  time_zone: string | null
  job_kind: string | null
  active: boolean
  created_at: string
  updated_at: string
}

interface ProfileRow {
  id: string
  workspace_id: string
  user_id: string | null
  handle: string
}

interface HostRow {
  link_id: string
  user_id: string
  position: number
}

/** Stored questions, the unreadable ones dropped. Pure. */
export function readQuestions(value: unknown): LinkQuestion[] {
  if (!Array.isArray(value)) return []
  const out: LinkQuestion[] = []
  for (const q of value as Array<Record<string, unknown>>) {
    if (!q || typeof q !== 'object' || typeof q.id !== 'string' || typeof q.label !== 'string' || !q.label.trim()) continue
    out.push({ id: q.id, label: q.label, required: q.required === true, kind: (QUESTION_KINDS as readonly unknown[]).includes(q.kind) ? (q.kind as LinkQuestion['kind']) : 'text' })
  }
  return out
}

export function toLink(row: LinkRow, hosts: readonly HostRow[] = [], handle: string | null = null): BookingLink {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    profileId: row.profile_id,
    profileHandle: handle,
    slug: row.slug,
    purpose: (LINK_PURPOSES as readonly string[]).includes(row.purpose) ? (row.purpose as LinkPurpose) : 'meeting',
    title: row.title,
    description: row.description,
    durationMinutes: row.duration_minutes,
    bufferBeforeMinutes: row.buffer_before_minutes ?? 0,
    bufferAfterMinutes: row.buffer_after_minutes ?? 0,
    noticeMinutes: row.notice_minutes ?? 0,
    windowDays: row.window_days,
    stepMinutes: row.step_minutes ?? null,
    dailyCap: row.daily_cap ?? null,
    questions: readQuestions(row.questions),
    video: row.video,
    location: row.location,
    askFirst: row.ask_first === true,
    hostMode: (HOST_MODES as readonly string[]).includes(row.host_mode) ? (row.host_mode as HostMode) : 'one',
    weeklyHours: row.weekly_hours == null ? null : readWeekly(row.weekly_hours),
    timeZone: row.time_zone,
    jobKind: row.job_kind,
    active: row.active !== false,
    hosts: hosts
      .filter((h) => h.link_id === row.id)
      .map((h) => ({ userId: h.user_id, position: h.position ?? 0 }))
      .sort((a, b) => a.position - b.position || a.userId.localeCompare(b.userId)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toProfile(row: ProfileRow): BookingProfile {
  return { id: row.id, workspaceId: row.workspace_id, userId: row.user_id, handle: row.handle }
}

async function withHosts(supabase: SupabaseClient, rows: readonly LinkRow[]): Promise<BookingLink[]> {
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const profileIds = [...new Set(rows.map((r) => r.profile_id).filter((id): id is string => !!id))]
  const [hosts, profiles] = await Promise.all([
    supabase.from('booking_link_host').select(HOST_COLUMNS).in('link_id', ids),
    profileIds.length ? supabase.from('booking_profile').select(PROFILE_COLUMNS).in('id', profileIds) : Promise.resolve({ data: [] as ProfileRow[], error: null }),
  ])
  if (hosts.error) throw new Error(`booking_link_host read failed: ${hosts.error.message}`)
  if (profiles.error) throw new Error(`booking_profile read failed: ${profiles.error.message}`)
  const handles = new Map(((profiles.data as ProfileRow[] | null) ?? []).map((p) => [p.id, p.handle]))
  return rows.map((row) => toLink(row, (hosts.data as HostRow[] | null) ?? [], row.profile_id ? (handles.get(row.profile_id) ?? null) : null))
}

// ── Profiles ────────────────────────────────────────────────────────────────

/** A profile by its handle. Null for a handle of the wrong shape. */
export async function getProfileByHandle(supabase: SupabaseClient, handle: string): Promise<BookingProfile | null> {
  const h = handle.trim().toLowerCase()
  if (!PROFILE_HANDLE_RE.test(h)) return null
  const { data, error } = await supabase.from('booking_profile').select(PROFILE_COLUMNS).eq('handle', h).maybeSingle<ProfileRow>()
  if (error) throw new Error(`booking_profile read failed: ${error.message}`)
  return data ? toProfile(data) : null
}

/** The workspace's own profile (`userId` null) or one person's in it. */
export async function getProfile(supabase: SupabaseClient, owner: { workspaceId: string; userId: string | null }): Promise<BookingProfile | null> {
  let query = supabase.from('booking_profile').select(PROFILE_COLUMNS).eq('workspace_id', owner.workspaceId)
  query = owner.userId ? query.eq('user_id', owner.userId) : query.is('user_id', null)
  const { data, error } = await query.maybeSingle<ProfileRow>()
  if (error) throw new Error(`booking_profile read failed: ${error.message}`)
  return data ? toProfile(data) : null
}

export type HandleWrite = { ok: true; profile: BookingProfile } | { ok: false; reason: 'taken' | 'invalid' | 'failed'; error?: string }

/** Set the workspace's or a person's handle: the profile made, or its handle changed. A handle someone has is `taken`. Never throws. */
export async function setProfileHandle(supabase: SupabaseClient, owner: { workspaceId: string; userId: string | null }, handle: string): Promise<HandleWrite> {
  const h = handle.trim().toLowerCase()
  if (!PROFILE_HANDLE_RE.test(h)) return { ok: false, reason: 'invalid', error: 'A handle is 3 to 48 lower-case letters, digits or dashes, like "dana-wu".' }
  try {
    const existing = await getProfile(supabase, owner)
    if (existing?.handle === h) return { ok: true, profile: existing }
    const write = existing
      ? supabase.from('booking_profile').update({ handle: h, updated_at: new Date().toISOString() }).eq('id', existing.id)
      : supabase.from('booking_profile').insert({ workspace_id: owner.workspaceId, user_id: owner.userId, handle: h })
    const { data, error } = await write.select(PROFILE_COLUMNS).single<ProfileRow>()
    if (error) return isConflict(error) ? { ok: false, reason: 'taken' } : { ok: false, reason: 'failed', error: error.message }
    return { ok: true, profile: toProfile(data) }
  } catch (err) {
    return { ok: false, reason: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Links ───────────────────────────────────────────────────────────────────

/** One link by id, with its hosts; fenced to a workspace when one is named. */
export async function getLink(supabase: SupabaseClient, linkId: string, workspaceId?: string): Promise<BookingLink | null> {
  if (!/^[0-9a-f-]{36}$/i.test(linkId)) return null
  let query = supabase.from('booking_link').select(LINK_COLUMNS).eq('id', linkId)
  if (workspaceId) query = query.eq('workspace_id', workspaceId)
  const { data, error } = await query.maybeSingle<LinkRow>()
  if (error) throw new Error(`booking_link read failed: ${error.message}`)
  return data ? (await withHosts(supabase, [data]))[0] : null
}

/** The link at /book/<handle>/<slug>, active or not (the caller decides), with its hosts. */
export async function getLinkByAddress(supabase: SupabaseClient, handle: string, slug: string): Promise<BookingLink | null> {
  const s = slug.trim().toLowerCase()
  if (!/^[a-z0-9-]{1,48}$/.test(s)) return null
  const profile = await getProfileByHandle(supabase, handle)
  if (!profile) return null
  const { data, error } = await supabase.from('booking_link').select(LINK_COLUMNS).eq('profile_id', profile.id).eq('slug', s).maybeSingle<LinkRow>()
  if (error) throw new Error(`booking_link read failed: ${error.message}`)
  return data ? (await withHosts(supabase, [data]))[0] : null
}

/** The workspace's job link (a business's booking page), or null. */
export async function getJobLink(supabase: SupabaseClient, workspaceId: string): Promise<BookingLink | null> {
  const { data, error } = await supabase.from('booking_link').select(LINK_COLUMNS).eq('workspace_id', workspaceId).eq('purpose', 'job').maybeSingle<LinkRow>()
  if (error) throw new Error(`booking_link read failed: ${error.message}`)
  return data ? (await withHosts(supabase, [data]))[0] : null
}

/** The workspace's links, oldest first, with their hosts; the turned-off ones too unless `activeOnly`. */
export async function listLinks(supabase: SupabaseClient, args: { workspaceId: string; activeOnly?: boolean; limit?: number }): Promise<BookingLink[]> {
  let query = supabase.from('booking_link').select(LINK_COLUMNS).eq('workspace_id', args.workspaceId)
  if (args.activeOnly) query = query.eq('active', true)
  const { data, error } = await query.order('created_at', { ascending: true }).limit(args.limit ?? 100)
  if (error) throw new Error(`booking_link read failed: ${error.message}`)
  return withHosts(supabase, (data as LinkRow[] | null) ?? [])
}

/** How many links the workspace keeps. */
export async function countLinks(supabase: SupabaseClient, workspaceId: string): Promise<number> {
  const { count, error } = await supabase.from('booking_link').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId)
  if (error) throw new Error(`booking_link count failed: ${error.message}`)
  return count ?? 0
}

/** A link's columns as written. */
export type LinkColumns = Partial<Omit<LinkRow, 'id' | 'created_at' | 'updated_at'>>

export type LinkWrite = { ok: true; link: BookingLink } | { ok: false; reason: 'slug_taken' | 'invalid' | 'failed'; error?: string }

function writeFailure(error: { code?: string; message: string }): LinkWrite {
  if (isConflict(error)) return { ok: false, reason: 'slug_taken' }
  if (error.code === '23514') return { ok: false, reason: 'invalid', error: error.message }
  return { ok: false, reason: 'failed', error: error.message }
}

/** Write a new link and its hosts (all or none). Never throws. */
export async function insertLink(supabase: SupabaseClient, columns: LinkColumns & Pick<LinkRow, 'workspace_id' | 'owner_user_id' | 'slug' | 'title'>, hosts: readonly LinkHost[]): Promise<LinkWrite> {
  try {
    const { data, error } = await supabase.from('booking_link').insert(columns).select(LINK_COLUMNS).single<LinkRow>()
    if (error || !data) return writeFailure(error ?? { message: 'no row' })
    const placed = await replaceHosts(supabase, data, hosts)
    if (!placed.ok) {
      await supabase.from('booking_link').delete().eq('id', data.id)
      return placed
    }
    const link = await getLink(supabase, data.id)
    return link ? { ok: true, link } : { ok: false, reason: 'failed', error: 'the link could not be read back' }
  } catch (err) {
    return { ok: false, reason: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}

/** Change a link (and, given `hosts`, set its hosts). Never throws. */
export async function updateLink(supabase: SupabaseClient, link: Pick<BookingLink, 'id' | 'workspaceId'>, columns: LinkColumns, hosts?: readonly LinkHost[]): Promise<LinkWrite> {
  try {
    const { data, error } = await supabase
      .from('booking_link')
      .update({ ...columns, updated_at: new Date().toISOString() })
      .eq('id', link.id)
      .eq('workspace_id', link.workspaceId)
      .select(LINK_COLUMNS)
      .maybeSingle<LinkRow>()
    if (error) return writeFailure(error)
    if (!data) return { ok: false, reason: 'failed', error: 'That link is gone.' }
    if (hosts) {
      const placed = await replaceHosts(supabase, data, hosts)
      if (!placed.ok) return placed
    }
    const fresh = await getLink(supabase, data.id)
    return fresh ? { ok: true, link: fresh } : { ok: false, reason: 'failed', error: 'the link could not be read back' }
  } catch (err) {
    return { ok: false, reason: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}

async function replaceHosts(supabase: SupabaseClient, row: Pick<LinkRow, 'id' | 'workspace_id'>, hosts: readonly LinkHost[]): Promise<{ ok: true } | { ok: false; reason: 'failed'; error: string }> {
  const gone = await supabase.from('booking_link_host').delete().eq('link_id', row.id)
  if (gone.error) return { ok: false, reason: 'failed', error: gone.error.message }
  if (!hosts.length) return { ok: true }
  const { error } = await supabase.from('booking_link_host').insert(hosts.map((h) => ({ link_id: row.id, user_id: h.userId, workspace_id: row.workspace_id, position: h.position })))
  return error ? { ok: false, reason: 'failed', error: error.message } : { ok: true }
}

// ── What a link's page counts ───────────────────────────────────────────────

/** Tries on a link's page since `sinceIso`. */
export async function countLinkAttempts(supabase: SupabaseClient, linkId: string, sinceIso: string): Promise<number> {
  const { count, error } = await supabase.from('booking_link_attempt').select('id', { count: 'exact', head: true }).eq('link_id', linkId).gte('created_at', sinceIso)
  if (error) throw new Error(`booking_link_attempt count failed: ${error.message}`)
  return count ?? 0
}

/** Record a try. Best effort. */
export async function recordLinkAttempt(supabase: SupabaseClient, linkId: string): Promise<void> {
  try {
    await supabase.from('booking_link_attempt').insert({ link_id: linkId })
  } catch {
    // The count is a cap, not a record.
  }
}

/** Bookings one guest (their email or number) made on a link since `sinceIso`. */
export async function countGuestBookings(supabase: SupabaseClient, linkId: string, sinceIso: string, who: { email: string | null; phone: string | null }): Promise<number> {
  const ors: string[] = []
  if (who.email && /^[^\s,()]+@[^\s,()]+$/.test(who.email)) ors.push(`guest_email.eq.${who.email}`)
  if (who.phone && /^\+[1-9]\d{7,14}$/.test(who.phone)) ors.push(`guest_phone.eq.${who.phone}`)
  if (!ors.length) return 0
  const { count, error } = await supabase
    .from('meeting_booking')
    .select('id', { count: 'exact', head: true })
    .eq('link_id', linkId)
    .gte('created_at', sinceIso)
    .or(ors.join(','))
  if (error) throw new Error(`meeting_booking count failed: ${error.message}`)
  return count ?? 0
}

const LIVE_STATES = ['requested', 'booking', 'confirmed'] as const

/** The starts of a link's live bookings in [fromIso, toIso): what its daily cap counts. */
export async function linkBookingStarts(supabase: SupabaseClient, linkId: string, fromIso: string, toIso: string): Promise<number[]> {
  const { data, error } = await supabase
    .from('meeting_booking')
    .select('starts_at')
    .eq('link_id', linkId)
    .in('state', [...LIVE_STATES])
    .gte('starts_at', fromIso)
    .lt('starts_at', toIso)
    .limit(1000)
  if (error) throw new Error(`meeting_booking read failed: ${error.message}`)
  return ((data as Array<{ starts_at: string }> | null) ?? []).map((r) => Date.parse(r.starts_at)).filter(Number.isFinite)
}

/**
 * How booked each host is in [fromIso, toIso): their booking claims there
 * (every booking that takes their time: offers, links, customers' jobs), one
 * read for all of them. A host with none is 0.
 */
export async function hostLoad(supabase: SupabaseClient, userIds: readonly string[], fromIso: string, toIso: string): Promise<Map<string, number>> {
  const out = new Map(userIds.map((id) => [id, 0]))
  if (!userIds.length) return out
  const { data, error } = await supabase
    .from('host_time_claim')
    .select('host_user_id, booking_id')
    .eq('kind', 'booking')
    .in('host_user_id', [...userIds])
    .gte('starts_at', fromIso)
    .lt('starts_at', toIso)
    .limit(2000)
  if (error) throw new Error(`host_time_claim read failed: ${error.message}`)
  const seen = new Set<string>()
  for (const row of (data as Array<{ host_user_id: string; booking_id: string | null }> | null) ?? []) {
    // A booking moving holds two claims for a moment: it is one booking.
    const key = `${row.host_user_id}:${row.booking_id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.set(row.host_user_id, (out.get(row.host_user_id) ?? 0) + 1)
  }
  return out
}
