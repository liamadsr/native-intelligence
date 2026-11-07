/**
 * Agents talking to agents (migration 435; plan and Liam's decisions:
 * /mnt/project-files/agent-links/contracts.md), read and written with the
 * service role. The routes call these after their own auth; every function
 * takes the signed-in user's id and touches only links they are on.
 *
 * A link is two Dial8 users whose agents may talk. Each person's half is
 * their agent_guest row for the other, with 'dial8' (their agent) in its
 * channels: what the OTHER person's agent may ask theirs, set and changed
 * only by its owner (decision 1: one set of tools per person, whichever way
 * they reach the agent).
 *
 *   requestLink   ask a teammate (by user id) or anyone (by email) to link.
 *                 Writes the requester's half (invited, with dial8) and the
 *                 request. An email that is no Dial8 user answers the same
 *                 as one that is (decision 3). At most AGENT_LINK_PENDING_MAX
 *                 waiting at once.
 *   acceptLink    the person asked says yes from one of their workspaces
 *                 (decision 4), with their half's tools: both halves are
 *                 bound (peer_bound_at) and the link is active.
 *   ignoreLink    the person asked says no.
 *   endLink       either person ends it (or the requester withdraws it): both
 *                 halves lose dial8 (a half with no channel left is removed,
 *                 and what its agent learned is deleted), open exchanges close.
 *   listLinks /
 *   listLinkCandidates  what the People tab reads.
 *   getLinkForParty     one link, only for someone on it.
 *
 * Nothing here talks to any agent or sends anything.
 *
 * Server only.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isGuestPresetId,
  normalizeAskBefore,
  askToolsWithDefaults,
  normalizeAskTools,
  normalizeGuestTools,
  presetOf,
  presetSettings,
  guestToolLabel,
  type GuestPresetId,
} from '@/lib/guests/presets'
import { GUEST_ALWAYS_TOOLS } from '@/lib/guests/tools'
import { AGENT_GUEST_SELECT, GUEST_NAME_MAX, GUESTS_PER_OWNER, removeGuest, toGuest, type AgentGuest } from '@/lib/guests/store'
import {
  AGENT_LINK_PENDING_MAX,
  AGENT_LINK_REQUEST_TTL_MS,
  AGENT_LINK_STATES,
  type AgentLinkState,
  type AgentLinkCardContext,
  type LinkCandidate,
  type LinkView,
} from './views'

// ── Rows ────────────────────────────────────────────────────────────────────

export interface AgentLink {
  id: string
  requesterUserId: string
  requesterWorkspaceId: string
  requesterGuestId: string
  targetUserId: string | null
  targetEmail: string | null
  targetWorkspaceId: string | null
  targetGuestId: string | null
  outside: boolean
  state: AgentLinkState
  requestedAt: string
  expiresAt: string | null
  acceptedAt: string | null
  endedAt: string | null
}

interface AgentLinkRow {
  id: string
  requester_user_id: string
  requester_workspace_id: string
  requester_guest_id: string
  target_user_id: string | null
  target_email: string | null
  target_workspace_id: string | null
  target_guest_id: string | null
  outside: boolean
  state: string
  requested_at: string
  expires_at: string | null
  accepted_at: string | null
  ended_at: string | null
}

export const AGENT_LINK_SELECT =
  'id, requester_user_id, requester_workspace_id, requester_guest_id, target_user_id, target_email, target_workspace_id, target_guest_id, outside, state, requested_at, expires_at, accepted_at, ended_at'

/** A row as the app reads it. An unknown state reads as ended (fail closed). */
export function toLink(row: AgentLinkRow): AgentLink {
  return {
    id: row.id,
    requesterUserId: row.requester_user_id,
    requesterWorkspaceId: row.requester_workspace_id,
    requesterGuestId: row.requester_guest_id,
    targetUserId: row.target_user_id,
    targetEmail: row.target_email,
    targetWorkspaceId: row.target_workspace_id,
    targetGuestId: row.target_guest_id,
    outside: row.outside === true,
    state: (AGENT_LINK_STATES as readonly string[]).includes(row.state) ? (row.state as AgentLinkState) : 'ended',
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    endedAt: row.ended_at,
  }
}

/** A request past its time, still marked requested: treated as expired everywhere. */
export function isExpired(link: Pick<AgentLink, 'state' | 'expiresAt'>, now: number = Date.now()): boolean {
  return link.state === 'requested' && link.expiresAt !== null && Date.parse(link.expiresAt) <= now
}

/** Whether this user is on the link (asked, or was asked). */
export function isParty(link: Pick<AgentLink, 'requesterUserId' | 'targetUserId'>, userId: string): boolean {
  return link.requesterUserId === userId || link.targetUserId === userId
}

/** The workspace admin's switch for links outside the workspace (decision 5): on unless set to false. */
export function outsideLinksAllowed(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return true
  return (settings as Record<string, unknown>).outside_agent_links !== false
}

// ── Small reads ─────────────────────────────────────────────────────────────

/** This user's member row in a workspace, or null. Throws on a failed read. */
export async function memberIn(supabase: SupabaseClient, userId: string, workspaceId: string): Promise<{ display_name: string } | null> {
  const { data, error } = await supabase.from('member').select('display_name').eq('user_id', userId).eq('workspace_id', workspaceId).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as { display_name: string } | null) ?? null
}

/** Whether a workspace lets its members link with agents outside it. Throws on a failed read. */
export async function workspaceAllowsOutside(supabase: SupabaseClient, workspaceId: string): Promise<boolean> {
  const { data, error } = await supabase.from('workspace').select('settings').eq('id', workspaceId).maybeSingle()
  if (error) throw new Error(error.message)
  return outsideLinksAllowed((data as { settings?: unknown } | null)?.settings)
}

/** The open link (requested or active) between two people, if any. Throws on a failed read. */
export async function openLinkBetween(supabase: SupabaseClient, a: string, b: string): Promise<AgentLink | null> {
  const { data, error } = await supabase
    .from('agent_link')
    .select(AGENT_LINK_SELECT)
    .in('state', ['requested', 'active'])
    .or(`and(requester_user_id.eq.${a},target_user_id.eq.${b}),and(requester_user_id.eq.${b},target_user_id.eq.${a})`)
  if (error) throw new Error(error.message)
  return ((data ?? []) as AgentLinkRow[]).map(toLink)[0] ?? null
}

/** One link, only for someone on it. Throws on a failed read. */
export async function getLinkForParty(supabase: SupabaseClient, linkId: string, userId: string): Promise<AgentLink | null> {
  const { data, error } = await supabase.from('agent_link').select(AGENT_LINK_SELECT).eq('id', linkId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  const link = toLink(data as AgentLinkRow)
  return isParty(link, userId) ? link : null
}

/**
 * What a held call's card says it came over (AgentLinkCardContext): the
 * active link behind this half, and who is on the other side. Null when no
 * active link stands behind it. Never throws.
 */
export async function cardContextForHalf(supabase: SupabaseClient, half: Pick<AgentGuest, 'id' | 'ownerUserId' | 'peerUserId'>): Promise<AgentLinkCardContext | null> {
  try {
    if (!half.peerUserId) return null
    const link = await openLinkBetween(supabase, half.ownerUserId, half.peerUserId)
    if (!link || link.state !== 'active') return null
    const mine = link.requesterUserId === half.ownerUserId ? link.requesterGuestId : link.targetGuestId
    const peerWorkspaceId = link.requesterUserId === half.ownerUserId ? link.targetWorkspaceId : link.requesterWorkspaceId
    if (mine !== half.id || !peerWorkspaceId) return null
    const [member, ws] = await Promise.all([memberIn(supabase, half.peerUserId, peerWorkspaceId), supabase.from('workspace').select('name').eq('id', peerWorkspaceId).maybeSingle()])
    const workspaceName = (ws.data as { name?: unknown } | null)?.name
    return { linkId: link.id, peerName: member?.display_name?.trim() || 'Someone', workspaceName: typeof workspaceName === 'string' ? workspaceName : null }
  } catch {
    return null
  }
}

/** An owner's half for a Dial8 user: their agent_guest row for them, unless removed. Throws on a failed read. */
export async function halfFor(supabase: SupabaseClient, ownerUserId: string, peerUserId: string): Promise<AgentGuest | null> {
  const { data, error } = await supabase
    .from('agent_guest')
    .select(AGENT_GUEST_SELECT)
    .eq('owner_user_id', ownerUserId)
    .eq('peer_user_id', peerUserId)
    .neq('state', 'removed')
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data ? toGuest(data as Parameters<typeof toGuest>[0]) : null
}

/**
 * A person already on the owner's list (Sam, by Text) becoming the half for
 * this Dial8 user: their own row, not removed, for nobody else. Anything else
 * is refused (not_found), never a second row. Throws on a failed read.
 */
async function ownRowFor(supabase: SupabaseClient, ownerUserId: string, guestId: string, peerUserId: string): Promise<AgentGuest> {
  const { data, error } = await supabase.from('agent_guest').select(AGENT_GUEST_SELECT).eq('id', guestId).eq('owner_user_id', ownerUserId).maybeSingle()
  if (error) throw new Error(error.message)
  const guest = data ? toGuest(data as Parameters<typeof toGuest>[0]) : null
  if (!guest || guest.state === 'removed' || (guest.peerUserId !== null && guest.peerUserId !== peerUserId)) throw new LinkRefusal('not_found')
  return guest
}

function cleanName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const trimmed = name.trim().replace(/\s+/g, ' ')
  return trimmed.length >= 1 && trimmed.length <= GUEST_NAME_MAX ? trimmed : null
}

/** An email as stored: trimmed and lower-cased, or null when it isn't one. */
export function cleanEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null
  const e = email.trim().toLowerCase()
  return e.length >= 3 && e.length <= 320 && /^[^@\s]+@[^@\s]+[.][^@\s]+$/.test(e) ? e : null
}

/** A half's tools from a preset and the owner's own picks (the always-on guest tools added). */
function halfSettings(input: HalfInput): { tools: string[]; askTools: string[]; askBefore: ReturnType<typeof normalizeAskBefore> } {
  const base = presetSettings(input.preset)
  const tools = input.tools ? normalizeGuestTools(input.tools) : base.tools
  const askBefore = input.askBefore ? normalizeAskBefore(input.askBefore) : base.askBefore
  // The owner's own asks are the truth; with none, the preset's, and each tool beyond the preset's its default.
  const askTools =
    input.askTools !== undefined
      ? normalizeAskTools(input.askTools, tools, askBefore)
      : askToolsWithDefaults(base.askTools, tools.filter((t) => !base.tools.includes(t)), tools, askBefore)
  return { tools, askTools, askBefore }
}

export interface HalfInput {
  preset: GuestPresetId
  tools?: readonly string[]
  askTools?: readonly string[]
  askBefore?: readonly string[]
  notes?: string | null
}

/**
 * Make sure this owner has a half for the peer with dial8 on it: an existing
 * row of theirs for that user gains the channel and keeps its tools
 * (decision 1); otherwise a new row with these tools, in `state`.
 */
/** The People list's cap, for any new half: matched email or not, so the refusal never tells the two apart. */
async function refuseWhenFull(supabase: SupabaseClient, ownerUserId: string): Promise<void> {
  const { count, error } = await supabase
    .from('agent_guest')
    .select('id', { count: 'exact', head: true })
    .eq('owner_user_id', ownerUserId)
    .neq('state', 'removed')
    // A business's customers (src/lib/customers/) are not in the People list.
    .neq('preset', 'customer')
  if (error) throw new Error(error.message)
  if ((count ?? 0) >= GUESTS_PER_OWNER) throw new LinkRefusal('too_many')
}

async function ensureHalf(
  supabase: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string; peerUserId: string; displayName: string; state: 'invited' | 'active'; half: HalfInput; guestId?: string | null },
  now: number,
): Promise<{ guest: AgentGuest; created: boolean }> {
  const existing = (await halfFor(supabase, input.ownerUserId, input.peerUserId)) ?? (input.guestId ? await ownRowFor(supabase, input.ownerUserId, input.guestId, input.peerUserId) : null)
  const at = new Date(now).toISOString()
  if (existing) {
    const row: Record<string, unknown> = { updated_at: at }
    if (!existing.channels.includes('dial8')) row.channels = [...existing.channels, 'dial8']
    if (existing.peerUserId === null) row.peer_user_id = input.peerUserId
    if (input.state === 'active') {
      row.peer_bound_at = at
      if (existing.state !== 'active') {
        row.state = 'active'
        row.activated_at = at
      }
    }
    const { data, error } = await supabase.from('agent_guest').update(row).eq('id', existing.id).eq('owner_user_id', input.ownerUserId).select(AGENT_GUEST_SELECT).single()
    if (error || !data) throw new Error(error?.message ?? 'Could not update the half')
    return { guest: toGuest(data as Parameters<typeof toGuest>[0]), created: false }
  }

  await refuseWhenFull(supabase, input.ownerUserId)

  const { tools, askTools, askBefore } = halfSettings(input.half)
  const notes = typeof input.half.notes === 'string' && input.half.notes.trim() ? input.half.notes.trim().slice(0, 2000) : null
  const { data, error } = await supabase
    .from('agent_guest')
    .insert({
      id: randomUUID(),
      owner_user_id: input.ownerUserId,
      workspace_id: input.workspaceId,
      display_name: input.displayName,
      phone_e164: null,
      channels: ['dial8'],
      peer_user_id: input.peerUserId,
      peer_bound_at: input.state === 'active' ? at : null,
      preset: presetOf({ tools, askTools, askBefore }),
      tools,
      ask_tools: askTools,
      ask_before: askBefore,
      notes,
      state: input.state,
      activated_at: input.state === 'active' ? at : null,
    })
    .select(AGENT_GUEST_SELECT)
    .single()
  if (error || !data) throw new Error(error?.message ?? 'Could not add the half')
  return { guest: toGuest(data as Parameters<typeof toGuest>[0]), created: true }
}

/**
 * A half losing its link: dial8 comes off and it is unbound. A half with no
 * channel left is removed (removeGuest, which deletes what its agent
 * learned). A half still invited for an email request has no peer yet: it
 * goes too.
 */
async function dropDial8(supabase: SupabaseClient, ownerUserId: string, guestId: string, now: number): Promise<void> {
  const { data, error } = await supabase.from('agent_guest').select(AGENT_GUEST_SELECT).eq('id', guestId).eq('owner_user_id', ownerUserId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return
  const guest = toGuest(data as Parameters<typeof toGuest>[0])
  if (guest.state === 'removed') return
  const channels = guest.channels.filter((c) => c !== 'dial8')
  if (channels.length === 0) {
    const removed = await removeGuest(supabase, ownerUserId, guestId, now)
    if (!removed.ok && removed.reason !== 'not_found' && removed.reason !== 'wrong_state') throw new Error(`Could not remove the half (${removed.reason})`)
    return
  }
  const { error: updateError } = await supabase
    .from('agent_guest')
    .update({ channels, peer_bound_at: null, updated_at: new Date(now).toISOString() })
    .eq('id', guestId)
    .eq('owner_user_id', ownerUserId)
  if (updateError) throw new Error(updateError.message)
}

class LinkRefusal extends Error {
  constructor(readonly reason: LinkRefusalReason) {
    super(reason)
  }
}

export type LinkRefusalReason =
  | 'self'
  | 'not_member'
  | 'already_linked'
  | 'they_asked'
  | 'too_many_pending'
  | 'too_many'
  | 'outside_off'
  | 'bad_name'
  | 'bad_email'
  | 'bad_preset'
  | 'not_found'
  | 'wrong_state'
  | 'expired'
  | 'failed'

export type LinkResult = { ok: true; link: AgentLink } | { ok: false; reason: LinkRefusalReason }

function refused(error: unknown): { ok: false; reason: LinkRefusalReason } {
  if (error instanceof LinkRefusal) return { ok: false, reason: error.reason }
  return { ok: false, reason: (error as { code?: string } | null)?.code === '23505' ? 'already_linked' : 'failed' }
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface RequestLinkInput extends HalfInput {
  requesterUserId: string
  /** The workspace the requester answers from: the one they're asking in. */
  workspaceId: string
  /** A teammate in that workspace. */
  peerUserId?: string | null
  /** Anyone else, by the email they sign in with (decision 3). */
  email?: string | null
  /** What the requester calls them (People shows it until they accept). */
  displayName: string
  /**
   * Who an email belongs to, when it's a Dial8 user: the outside-workspace
   * phase's lookup (it never says either way to the requester). Left out,
   * an email request is stored for that email alone.
   */
  resolveEmail?: (email: string) => Promise<string | null>
  /**
   * The outside phase's connect link (an HMAC it minted). Alone it's a plain
   * link for whoever redeems it (no user or email); with an email it rides
   * along on that request.
   */
  connectTokenHash?: string | null
  /**
   * Someone already on the requester's list (their agent_guest row) to make
   * the half, keeping its tools: "Their agent" turned on for Sam, by Text.
   * Needs a user (peerUserId, or an email that resolves to one).
   */
  guestId?: string | null
}

export async function requestLink(supabase: SupabaseClient, input: RequestLinkInput, now: number = Date.now()): Promise<LinkResult> {
  const displayName = cleanName(input.displayName)
  if (!displayName) return { ok: false, reason: 'bad_name' }
  if (!isGuestPresetId(input.preset)) return { ok: false, reason: 'bad_preset' }
  const email = input.peerUserId ? null : cleanEmail(input.email)
  const token = typeof input.connectTokenHash === 'string' && input.connectTokenHash ? input.connectTokenHash : null
  if (!input.peerUserId && !email && !(token && (input.email === undefined || input.email === null))) return { ok: false, reason: 'bad_email' }

  try {
    let peerUserId = input.peerUserId ?? null
    let outside = false
    if (peerUserId) {
      if (peerUserId === input.requesterUserId) return { ok: false, reason: 'self' }
      // By id only a teammate: anyone else is asked by email.
      if (!(await memberIn(supabase, peerUserId, input.workspaceId))) return { ok: false, reason: 'not_member' }
    } else {
      // An email or a plain connect link: outside until it turns out to be a teammate.
      outside = true
    }
    if (!input.peerUserId && email) {
      const resolved = input.resolveEmail ? await input.resolveEmail(email) : null
      if (resolved === input.requesterUserId) return { ok: false, reason: 'self' }
      if (resolved) {
        peerUserId = resolved
        outside = !(await memberIn(supabase, resolved, input.workspaceId))
      }
    }
    if (outside && !(await workspaceAllowsOutside(supabase, input.workspaceId))) return { ok: false, reason: 'outside_off' }

    const { count, error: countError } = await supabase
      .from('agent_link')
      .select('id', { count: 'exact', head: true })
      .eq('requester_user_id', input.requesterUserId)
      .eq('state', 'requested')
      .gt('expires_at', new Date(now).toISOString())
    if (countError) return { ok: false, reason: 'failed' }
    if ((count ?? 0) >= AGENT_LINK_PENDING_MAX) return { ok: false, reason: 'too_many_pending' }

    if (peerUserId) {
      const open = await openLinkBetween(supabase, input.requesterUserId, peerUserId)
      if (open && !isExpired(open, now)) {
        if (open.state === 'requested' && open.targetUserId === input.requesterUserId) return { ok: false, reason: 'they_asked' }
        return { ok: false, reason: 'already_linked' }
      }
      if (open) await markExpired(supabase, open, now)
    } else if (email) {
      // The same email asked again: already asked, whoever it is.
      const { data, error } = await supabase
        .from('agent_link')
        .select('id')
        .eq('requester_user_id', input.requesterUserId)
        .eq('target_email', email)
        .eq('state', 'requested')
        .gt('expires_at', new Date(now).toISOString())
      if (error) return { ok: false, reason: 'failed' }
      if ((data ?? []).length > 0) return { ok: false, reason: 'already_linked' }
    }

    // An email request to someone not on Dial8 yet keeps its half invited with no peer (435's agent_guest_dial8_has_peer).
    const half = peerUserId
      ? await ensureHalf(
          supabase,
          { ownerUserId: input.requesterUserId, workspaceId: input.workspaceId, peerUserId, displayName, state: 'invited', half: input, guestId: input.guestId },
          now,
        )
      : ((input.guestId ? await emailOnExistingRow(supabase, input.requesterUserId, input.guestId) : null) ?? (await insertEmailHalf(supabase, input, displayName)))

    const { data, error } = await supabase
      .from('agent_link')
      .insert({
        requester_user_id: input.requesterUserId,
        requester_workspace_id: input.workspaceId,
        requester_guest_id: half.guest.id,
        target_user_id: peerUserId,
        target_email: email,
        connect_token_hash: token,
        outside,
        state: 'requested',
        requested_at: new Date(now).toISOString(),
        expires_at: new Date(now + AGENT_LINK_REQUEST_TTL_MS).toISOString(),
      })
      .select(AGENT_LINK_SELECT)
      .single()
    if (error || !data) {
      if (half.created) await supabase.from('agent_guest').delete().eq('id', half.guest.id).eq('owner_user_id', input.requesterUserId)
      return refused(error)
    }
    return { ok: true, link: toLink(data as AgentLinkRow) }
  } catch (error) {
    return refused(error)
  }
}

/**
 * An email request for someone already listed: a row still invited gains
 * dial8 (no peer yet), keeping its tools. An active row can't hold dial8
 * without a peer (435), so null: the request gets a half of its own, and the
 * outside phase merges them when the email is claimed. The answer is the
 * same either way, so it never says whether the email is anyone's.
 */
async function emailOnExistingRow(supabase: SupabaseClient, ownerUserId: string, guestId: string): Promise<{ guest: AgentGuest; created: boolean } | null> {
  const { data, error } = await supabase.from('agent_guest').select(AGENT_GUEST_SELECT).eq('id', guestId).eq('owner_user_id', ownerUserId).maybeSingle()
  if (error) throw new Error(error.message)
  const guest = data ? toGuest(data as Parameters<typeof toGuest>[0]) : null
  if (!guest || guest.state === 'removed' || guest.peerUserId !== null) throw new LinkRefusal('not_found')
  if (guest.state !== 'invited') return null
  if (guest.channels.includes('dial8')) return { guest, created: false }
  const { data: updated, error: updateError } = await supabase
    .from('agent_guest')
    .update({ channels: [...guest.channels, 'dial8'], updated_at: new Date().toISOString() })
    .eq('id', guestId)
    .eq('owner_user_id', ownerUserId)
    .select(AGENT_GUEST_SELECT)
    .single()
  if (updateError || !updated) throw new Error(updateError?.message ?? 'Could not update the half')
  return { guest: toGuest(updated as Parameters<typeof toGuest>[0]), created: false }
}

async function insertEmailHalf(supabase: SupabaseClient, input: RequestLinkInput, displayName: string): Promise<{ guest: AgentGuest; created: boolean }> {
  await refuseWhenFull(supabase, input.requesterUserId)
  const { tools, askTools, askBefore } = halfSettings(input)
  const { data, error } = await supabase
    .from('agent_guest')
    .insert({
      id: randomUUID(),
      owner_user_id: input.requesterUserId,
      workspace_id: input.workspaceId,
      display_name: displayName,
      phone_e164: null,
      channels: ['dial8'],
      preset: presetOf({ tools, askTools, askBefore }),
      tools,
      ask_tools: askTools,
      ask_before: askBefore,
      notes: typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim().slice(0, 2000) : null,
      state: 'invited',
    })
    .select(AGENT_GUEST_SELECT)
    .single()
  if (error || !data) throw new Error(error?.message ?? 'Could not add the half')
  return { guest: toGuest(data as Parameters<typeof toGuest>[0]), created: true }
}

async function markExpired(supabase: SupabaseClient, link: AgentLink, now: number): Promise<void> {
  const { error } = await supabase.from('agent_link').update({ state: 'expired', updated_at: new Date(now).toISOString() }).eq('id', link.id).eq('state', 'requested')
  if (error) throw new Error(error.message)
  await dropDial8(supabase, link.requesterUserId, link.requesterGuestId, now)
}

export interface AcceptLinkInput extends HalfInput {
  linkId: string
  userId: string
  /** The workspace their agent answers from (decision 4): one they're a member of. */
  workspaceId: string
}

export async function acceptLink(supabase: SupabaseClient, input: AcceptLinkInput, now: number = Date.now()): Promise<LinkResult> {
  if (!isGuestPresetId(input.preset)) return { ok: false, reason: 'bad_preset' }
  try {
    const link = await getLinkForParty(supabase, input.linkId, input.userId)
    if (!link || link.targetUserId !== input.userId) return { ok: false, reason: 'not_found' }
    if (isExpired(link, now)) {
      await markExpired(supabase, link, now)
      return { ok: false, reason: 'expired' }
    }
    if (link.state !== 'requested') return { ok: false, reason: 'wrong_state' }
    const me = await memberIn(supabase, input.userId, input.workspaceId)
    if (!me) return { ok: false, reason: 'not_member' }

    const outside = link.requesterWorkspaceId !== input.workspaceId
    if (outside) {
      const [mine, theirs] = await Promise.all([workspaceAllowsOutside(supabase, input.workspaceId), workspaceAllowsOutside(supabase, link.requesterWorkspaceId)])
      if (!mine || !theirs) return { ok: false, reason: 'outside_off' }
    }

    // What I call them: their name in the workspace they asked from.
    const requester = await memberIn(supabase, link.requesterUserId, link.requesterWorkspaceId)
    const mineHalf = await ensureHalf(
      supabase,
      { ownerUserId: input.userId, workspaceId: input.workspaceId, peerUserId: link.requesterUserId, displayName: requester?.display_name ?? 'Dial8 user', state: 'active', half: input },
      now,
    )
    const { data, error } = await supabase
      .from('agent_link')
      .update({
        state: 'active',
        target_workspace_id: mineHalf.guest.workspaceId,
        target_guest_id: mineHalf.guest.id,
        outside: link.requesterWorkspaceId !== mineHalf.guest.workspaceId,
        accepted_at: new Date(now).toISOString(),
        connect_token_hash: null,
        updated_at: new Date(now).toISOString(),
      })
      .eq('id', link.id)
      .eq('state', 'requested')
      .select(AGENT_LINK_SELECT)
      .maybeSingle()
    if (error) return refused(error)
    if (!data) return { ok: false, reason: 'wrong_state' }

    // The requester's half goes live with it.
    const at = new Date(now).toISOString()
    const { data: theirHalf, error: halfError } = await supabase
      .from('agent_guest')
      .select('state, activated_at')
      .eq('id', link.requesterGuestId)
      .eq('owner_user_id', link.requesterUserId)
      .maybeSingle()
    if (halfError) return { ok: false, reason: 'failed' }
    const half = theirHalf as { state: string; activated_at: string | null } | null
    const patch: Record<string, unknown> = { peer_user_id: input.userId, peer_bound_at: at, updated_at: at }
    if (half && half.state !== 'active') {
      patch.state = 'active'
      patch.activated_at = at
    }
    const { error: bindError } = await supabase.from('agent_guest').update(patch).eq('id', link.requesterGuestId).eq('owner_user_id', link.requesterUserId)
    if (bindError) return { ok: false, reason: 'failed' }
    return { ok: true, link: toLink(data as AgentLinkRow) }
  } catch (error) {
    return refused(error)
  }
}

/** The person asked says no: declined, and the requester's half loses dial8. */
export async function ignoreLink(supabase: SupabaseClient, input: { linkId: string; userId: string }, now: number = Date.now()): Promise<LinkResult> {
  try {
    const link = await getLinkForParty(supabase, input.linkId, input.userId)
    if (!link || link.targetUserId !== input.userId) return { ok: false, reason: 'not_found' }
    if (link.state !== 'requested') return { ok: false, reason: 'wrong_state' }
    const { data, error } = await supabase
      .from('agent_link')
      .update({ state: 'declined', connect_token_hash: null, updated_at: new Date(now).toISOString() })
      .eq('id', link.id)
      .eq('state', 'requested')
      .select(AGENT_LINK_SELECT)
      .maybeSingle()
    if (error) return refused(error)
    if (!data) return { ok: false, reason: 'wrong_state' }
    await dropDial8(supabase, link.requesterUserId, link.requesterGuestId, now)
    return { ok: true, link: toLink(data as AgentLinkRow) }
  } catch (error) {
    return refused(error)
  }
}

/** Either person ends the link, or the requester withdraws their request. */
export async function endLink(supabase: SupabaseClient, input: { linkId: string; userId: string }, now: number = Date.now()): Promise<LinkResult> {
  try {
    const link = await getLinkForParty(supabase, input.linkId, input.userId)
    if (!link) return { ok: false, reason: 'not_found' }
    const open = link.state === 'active' || (link.state === 'requested' && link.requesterUserId === input.userId)
    if (!open) return { ok: false, reason: 'wrong_state' }
    return await finishEnd(supabase, link, input.userId, now)
  } catch (error) {
    return refused(error)
  }
}

/**
 * End a link as neither person on it: a workspace admin turning off outside
 * links (the outside phase). Exactly endLink's step, without the party check:
 * the caller has checked the admin's right to it.
 */
export async function endLinkForWorkspace(supabase: SupabaseClient, input: { linkId: string; byUserId: string }, now: number = Date.now()): Promise<LinkResult> {
  try {
    const { data, error } = await supabase.from('agent_link').select(AGENT_LINK_SELECT).eq('id', input.linkId).maybeSingle()
    if (error) return refused(error)
    if (!data) return { ok: false, reason: 'not_found' }
    const link = toLink(data as AgentLinkRow)
    if (link.state !== 'active' && link.state !== 'requested') return { ok: false, reason: 'wrong_state' }
    return await finishEnd(supabase, link, input.byUserId, now)
  } catch (error) {
    return refused(error)
  }
}

/** Ended for both: both halves lose dial8, open exchanges close. Throws on a failed write. */
async function finishEnd(supabase: SupabaseClient, link: AgentLink, byUserId: string, now: number): Promise<LinkResult> {
  const at = new Date(now).toISOString()
  const { data, error } = await supabase
    .from('agent_link')
    .update({ state: 'ended', ended_at: at, ended_by_user_id: byUserId, connect_token_hash: null, updated_at: at })
    .eq('id', link.id)
    .in('state', ['requested', 'active'])
    .select(AGENT_LINK_SELECT)
    .maybeSingle()
  if (error) return refused(error)
  if (!data) return { ok: false, reason: 'wrong_state' }
  const { error: closeError } = await supabase.from('agent_link_exchange').update({ state: 'done', closed_at: at }).eq('link_id', link.id).eq('state', 'open')
  if (closeError) return { ok: false, reason: 'failed' }
  await dropDial8(supabase, link.requesterUserId, link.requesterGuestId, now)
  if (link.targetUserId && link.targetGuestId) await dropDial8(supabase, link.targetUserId, link.targetGuestId, now)
  return { ok: true, link: toLink(data as AgentLinkRow) }
}

// ── What People reads ───────────────────────────────────────────────────────

/** A half's tools as one line for the other person: "Free/busy, Create calendar events and 2 more". */
export function halfSummary(tools: readonly string[]): string {
  const always = new Set(GUEST_ALWAYS_TOOLS)
  const labels = tools.filter((t) => !always.has(t)).map(guestToolLabel)
  if (labels.length === 0) return 'Only leave messages'
  if (labels.length <= 2) return labels.join(' and ')
  return `${labels.slice(0, 2).join(', ')} and ${labels.length - 2} more`
}

/**
 * This user's links as People shows them, in the workspace they're reading
 * from: open requests both ways (an expired one is marked so and left out)
 * and active links. Throws on a failed read.
 */
export async function listLinks(supabase: SupabaseClient, userId: string, workspaceId: string, now: number = Date.now()): Promise<LinkView[]> {
  const { data, error } = await supabase
    .from('agent_link')
    .select(AGENT_LINK_SELECT)
    .in('state', ['requested', 'active'])
    .or(`requester_user_id.eq.${userId},target_user_id.eq.${userId}`)
    .order('requested_at', { ascending: false })
  if (error) throw new Error(error.message)
  const links: AgentLink[] = []
  for (const link of ((data ?? []) as AgentLinkRow[]).map(toLink)) {
    if (isExpired(link, now)) {
      await markExpired(supabase, link, now)
      continue
    }
    links.push(link)
  }
  if (links.length === 0) return []

  const guestIds = [...new Set(links.flatMap((l) => [l.requesterGuestId, l.targetGuestId]).filter((id): id is string => typeof id === 'string'))]
  const peerIds = [...new Set(links.map((l) => (l.requesterUserId === userId ? l.targetUserId : l.requesterUserId)).filter((id): id is string => typeof id === 'string'))]
  const workspaceIds = [...new Set(links.flatMap((l) => [l.requesterWorkspaceId, l.targetWorkspaceId]).filter((id): id is string => typeof id === 'string'))]
  const [guestsRead, membersRead, workspacesRead, exchangesRead] = await Promise.all([
    supabase.from('agent_guest').select('id, owner_user_id, display_name, tools').in('id', guestIds),
    peerIds.length ? supabase.from('member').select('user_id, workspace_id, display_name').in('user_id', peerIds) : Promise.resolve({ data: [], error: null }),
    supabase.from('workspace').select('id, name').in('id', workspaceIds),
    supabase.from('agent_link_exchange').select('link_id, created_at').in('link_id', links.map((l) => l.id)).order('created_at', { ascending: false }),
  ])
  for (const read of [guestsRead, membersRead, workspacesRead, exchangesRead]) if (read.error) throw new Error(read.error.message)
  const guests = new Map(((guestsRead.data ?? []) as Array<{ id: string; owner_user_id: string; display_name: string; tools: string[] | null }>).map((g) => [g.id, g]))
  const members = (membersRead.data ?? []) as Array<{ user_id: string; workspace_id: string; display_name: string }>
  const workspaces = new Map(((workspacesRead.data ?? []) as Array<{ id: string; name: string }>).map((w) => [w.id, w.name]))
  const lastExchange = new Map<string, string>()
  for (const e of (exchangesRead.data ?? []) as Array<{ link_id: string; created_at: string }>) if (!lastExchange.has(e.link_id)) lastExchange.set(e.link_id, e.created_at)

  return links.map((link): LinkView => {
    const outgoing = link.requesterUserId === userId
    const peerId = outgoing ? link.targetUserId : link.requesterUserId
    const peerWorkspace = outgoing ? link.targetWorkspaceId : link.requesterWorkspaceId
    const myHalfId = outgoing ? link.requesterGuestId : link.targetGuestId
    const theirHalfId = outgoing ? link.targetGuestId : link.requesterGuestId
    const myHalf = myHalfId ? guests.get(myHalfId) : undefined
    const theirHalf = theirHalfId ? guests.get(theirHalfId) : undefined
    const peerMember = peerId ? (members.find((m) => m.user_id === peerId && m.workspace_id === peerWorkspace) ?? members.find((m) => m.user_id === peerId && m.workspace_id === workspaceId)) : undefined
    // Until it's active, an outgoing request shows the name I typed: never whether an email is anyone's.
    const name = outgoing && link.state !== 'active' ? (myHalf?.display_name ?? 'Dial8 user') : (peerMember?.display_name ?? myHalf?.display_name ?? 'Dial8 user')
    return {
      id: link.id,
      state: link.state,
      direction: outgoing ? 'outgoing' : 'incoming',
      peer: {
        userId: outgoing && link.state !== 'active' && link.outside ? null : peerId,
        name,
        agentName: null,
        workspaceName: link.state === 'active' || !outgoing ? (peerWorkspace ? (workspaces.get(peerWorkspace) ?? null) : null) : null,
        sameWorkspace: peerId !== null && members.some((m) => m.user_id === peerId && m.workspace_id === workspaceId),
      },
      myHalfGuestId: myHalfId ?? null,
      theirHalf: link.state === 'active' && theirHalf ? { summary: halfSummary(theirHalf.tools ?? []) } : null,
      outside: link.outside,
      requestedAt: link.requestedAt,
      acceptedAt: link.acceptedAt,
      expiresAt: link.state === 'requested' ? link.expiresAt : null,
      lastExchangeAt: lastExchange.get(link.id) ?? null,
    }
  })
}

/** Teammates in this workspace who could be asked: not me, and not linked or asked either way. Throws on a failed read. */
export async function listLinkCandidates(supabase: SupabaseClient, userId: string, workspaceId: string, links: readonly LinkView[]): Promise<LinkCandidate[]> {
  const { data, error } = await supabase.from('member').select('user_id, display_name').eq('workspace_id', workspaceId).order('display_name')
  if (error) throw new Error(error.message)
  const taken = new Set(links.map((l) => l.peer.userId).filter((id): id is string => typeof id === 'string'))
  return ((data ?? []) as Array<{ user_id: string; display_name: string }>)
    .filter((m) => m.user_id !== userId && !taken.has(m.user_id))
    .map((m) => ({ userId: m.user_id, name: m.display_name, agentName: null }))
}
