import type { SupabaseClient } from '@supabase/supabase-js'
import { inChunks } from '@/lib/supabase/paging'

/**
 * FENCES FOR THE PRIVATE GRAPH KINDS: calendar events, team-chat channels and
 * messages, and capture decisions.
 *
 * The knowledge graph's own fence is `entity_link.workspace_id` (and, for the
 * indirect kinds, a parent's workspace). That is enough for a kind every
 * workspace member may read, and too weak for these four:
 *   - calendar_event:    its owner's alone (RLS `auth.uid() = user_id`);
 *   - team_chat_channel: a team channel is its team's, a DM its two members'
 *                        (`team_chat_can_read`, migration 474);
 *   - team_chat_message: whoever may read its channel;
 *   - decision:          no workspace_id; readable through its capture: a
 *                        workspace capture's, the capture owner's, or anyone's
 *                        once confirmed (the decision table's RLS).
 *
 * The graph code that reads them may run on a SERVICE-ROLE client (the eve tool
 * routes, unattended runs), where RLS hides nothing and `auth.uid()` is NULL,
 * so each fence restates its table's read rule for an explicit user, in a
 * fixed number of reads however many ids it is asked about (no per-row RPC).
 * On a user client RLS already holds and the fence is redundant and harmless.
 *
 * Every fence FAILS CLOSED: a read error, a missing row or a missing user is
 * "not visible". `workspaceId`, when given, also requires the row to live in
 * that workspace (a decision through its capture's workspace).
 *
 * The SQL rules these mirror: 474's team_chat_can_read, the
 * local_calendar_event and decision policies (the decision one with 493's
 * grant arm). Change one, change its fence.
 */

/** The graph kinds whose rows only some members may read. */
export const PRIVATE_GRAPH_KINDS = ['calendar_event', 'team_chat_channel', 'team_chat_message', 'decision'] as const
export type PrivateGraphKind = (typeof PRIVATE_GRAPH_KINDS)[number]

export function isPrivateGraphKind(type: string): type is PrivateGraphKind {
  return (PRIVATE_GRAPH_KINDS as readonly string[]).includes(type)
}

/** Ids per `.in(…)`: keeps each request URL well under proxy limits. */
const ID_CHUNK = 200

type Fence = (
  supabase: SupabaseClient,
  userId: string | null | undefined,
  ids: readonly string[],
  workspaceId?: string | null,
) => Promise<Set<string>>

type Row = Record<string, unknown>

const uniq = (ids: readonly string[]) => [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]

/** Read rows by id (chunked); null on any error so callers fail closed. */
async function rowsByIds(
  ids: readonly string[],
  read: (chunkIds: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<Row[] | null> {
  if (ids.length === 0) return []
  const { data, error } = await inChunks(ids, ID_CHUNK, async (c) => {
    const res = await read(c)
    return { data: (res.data ?? []) as Row[], error: res.error }
  })
  if (error) {
    console.warn('[entity-fences] read failed:', error.message)
    return null
  }
  return data
}

/** The requester's member row in each of `workspaceIds`: workspace id → member id. */
async function memberIdsByWorkspace(
  supabase: SupabaseClient,
  userId: string,
  workspaceIds: readonly string[],
): Promise<Map<string, string> | null> {
  const wanted = uniq(workspaceIds)
  if (wanted.length === 0) return new Map()
  const rows = await rowsByIds(wanted, (c) =>
    supabase.from('member').select('id, workspace_id').eq('user_id', userId).in('workspace_id', c),
  )
  if (!rows) return null
  const out = new Map<string, string>()
  for (const r of rows) if (typeof r.workspace_id === 'string' && typeof r.id === 'string') out.set(r.workspace_id, r.id)
  return out
}

/** A calendar event is its owner's alone. */
const calendarEventFence: Fence = async (supabase, userId, ids, workspaceId) => {
  const wanted = uniq(ids)
  if (!userId || wanted.length === 0) return new Set()
  const rows = await rowsByIds(wanted, (c) => {
    let q = supabase.from('local_calendar_event').select('id').eq('user_id', userId).in('id', c)
    if (workspaceId) q = q.eq('workspace_id', workspaceId)
    return q
  })
  return new Set((rows ?? []).map((r) => r.id as string))
}

/**
 * team_chat_can_read for an explicit user: a member of the channel's
 * workspace and, for a team channel, of the team; for a DM, one of its
 * members. Archived channels stay readable.
 */
const teamChatChannelFence: Fence = async (supabase, userId, ids, workspaceId) => {
  const wanted = uniq(ids)
  if (!userId || wanted.length === 0) return new Set()
  const channels = await rowsByIds(wanted, (c) => {
    let q = supabase.from('team_chat_channel').select('id, workspace_id, team_id, kind').in('id', c)
    if (workspaceId) q = q.eq('workspace_id', workspaceId)
    return q
  })
  if (!channels || channels.length === 0) return new Set()
  const members = await memberIdsByWorkspace(
    supabase,
    userId,
    channels.map((c) => c.workspace_id as string),
  )
  if (!members || members.size === 0) return new Set()
  const myMemberIds = [...members.values()]

  const teamIds = uniq(channels.filter((c) => c.kind === 'channel' && c.team_id).map((c) => c.team_id as string))
  const dmIds = uniq(channels.filter((c) => c.kind === 'dm').map((c) => c.id as string))
  const [teamRows, dmRows] = await Promise.all([
    teamIds.length
      ? rowsByIds(teamIds, (c) => supabase.from('team_member').select('team_id, member_id').in('team_id', c).in('member_id', myMemberIds))
      : Promise.resolve([] as Row[]),
    dmIds.length
      ? rowsByIds(dmIds, (c) => supabase.from('team_chat_member').select('channel_id, member_id').in('channel_id', c).in('member_id', myMemberIds))
      : Promise.resolve([] as Row[]),
  ])
  const myTeams = new Set((teamRows ?? []).map((r) => r.team_id as string))
  const myDms = new Set((dmRows ?? []).map((r) => `${r.channel_id as string}:${r.member_id as string}`))

  const out = new Set<string>()
  for (const c of channels) {
    const me = members.get(c.workspace_id as string)
    if (!me) continue
    if (c.kind === 'channel') {
      if (!c.team_id || (teamRows && myTeams.has(c.team_id as string))) out.add(c.id as string)
    } else if (c.kind === 'dm') {
      if (dmRows && myDms.has(`${c.id as string}:${me}`)) out.add(c.id as string)
    }
  }
  return out
}

/** A message is readable by whoever may read its channel. */
const teamChatMessageFence: Fence = async (supabase, userId, ids, workspaceId) => {
  const wanted = uniq(ids)
  if (!userId || wanted.length === 0) return new Set()
  const messages = await rowsByIds(wanted, (c) => {
    let q = supabase.from('team_chat_message').select('id, channel_id').in('id', c)
    if (workspaceId) q = q.eq('workspace_id', workspaceId)
    return q
  })
  if (!messages || messages.length === 0) return new Set()
  const readable = await teamChatChannelFence(
    supabase,
    userId,
    messages.map((m) => m.channel_id as string),
    workspaceId,
  )
  return new Set(messages.filter((m) => readable.has(m.channel_id as string)).map((m) => m.id as string))
}

/**
 * The decision table's RLS for an explicit user: a member of its capture's
 * workspace, and the capture is a workspace one, or theirs, or the decision is
 * confirmed, or a grant on the capture reaches them (migration 493; the
 * mirror is src/lib/entity-access/grants.ts). Evaluation captures (`is_eval`)
 * are never in the product.
 */
const decisionFence: Fence = async (supabase, userId, ids, workspaceId) => {
  const wanted = uniq(ids)
  if (!userId || wanted.length === 0) return new Set()
  const decisions = await rowsByIds(wanted, (c) => supabase.from('decision').select('id, capture_id, confirmation').in('id', c))
  if (!decisions || decisions.length === 0) return new Set()
  const captures = await rowsByIds(
    uniq(decisions.map((d) => d.capture_id as string)),
    (c) => {
      let q = supabase.from('captures').select('id, workspace_id, visibility, user_id, is_eval').in('id', c)
      if (workspaceId) q = q.eq('workspace_id', workspaceId)
      return q
    },
  )
  if (!captures || captures.length === 0) return new Set()
  const members = await memberIdsByWorkspace(
    supabase,
    userId,
    captures.map((c) => c.workspace_id as string),
  )
  if (!members) return new Set()
  const byId = new Map(captures.map((c) => [c.id as string, c]))
  const out = new Set<string>()
  // Another member's private capture whose decision isn't confirmed: readable only through a grant (493).
  const viaGrant = new Map<string, string[]>()
  for (const d of decisions) {
    const capture = byId.get(d.capture_id as string)
    if (!capture || capture.is_eval === true) continue
    if (!members.has(capture.workspace_id as string)) continue
    if (capture.visibility === 'workspace' || capture.user_id === userId || d.confirmation === 'confirmed') {
      out.add(d.id as string)
    } else {
      const ws = capture.workspace_id as string
      ;(viaGrant.get(ws) ?? viaGrant.set(ws, []).get(ws)!).push(capture.id as string)
    }
  }
  if (viaGrant.size > 0) {
    // Loaded here, not at the top: the grant mirror reads this file's team chat fence.
    const { grantedEntityIds } = await import('@/lib/entity-access/grants')
    const granted = new Set<string>()
    await Promise.all(
      [...viaGrant.entries()].map(async ([ws, captureIds]) => {
        for (const id of await grantedEntityIds(supabase, { userId, workspaceId: ws }, 'capture', captureIds)) granted.add(id)
      }),
    )
    for (const d of decisions) if (granted.has(d.capture_id as string)) out.add(d.id as string)
  }
  return out
}

const FENCES: Record<PrivateGraphKind, Fence> = {
  calendar_event: calendarEventFence,
  team_chat_channel: teamChatChannelFence,
  team_chat_message: teamChatMessageFence,
  decision: decisionFence,
}

/**
 * The ids among `ids` of a private graph kind that `userId` may read (inside
 * `workspaceId` when given). No user: none of them.
 */
export async function visiblePrivateKindIds(
  supabase: SupabaseClient,
  type: PrivateGraphKind,
  userId: string | null | undefined,
  ids: readonly string[],
  workspaceId?: string | null,
): Promise<Set<string>> {
  try {
    return await FENCES[type](supabase, userId, ids, workspaceId)
  } catch (err) {
    console.warn('[entity-fences] fence threw:', type, err instanceof Error ? err.message : 'unknown')
    return new Set()
  }
}

/**
 * The `type:id` keys among `refs` naming a private-kind row `userId` may NOT
 * read (inside `workspaceId` when given): one batched fence per kind present.
 * Refs of any other kind are never in it. For the graph walks that run
 * service-role (traverse, get_context_bundle, list_entity_links): a hidden
 * centre shows nothing around it, and a hidden neighbour is left out, never
 * listed by id, as another person's chat or private document is. No user, or a
 * failed read: every private ref is hidden.
 */
export async function hiddenPrivateRefs(
  supabase: SupabaseClient,
  refs: ReadonlyArray<{ type: string; id: string }>,
  userId: string | null | undefined,
  workspaceId?: string | null,
): Promise<Set<string>> {
  const byType = new Map<PrivateGraphKind, Set<string>>()
  for (const r of refs) {
    if (!isPrivateGraphKind(r.type) || typeof r.id !== 'string') continue
    ;(byType.get(r.type) ?? byType.set(r.type, new Set()).get(r.type)!).add(r.id)
  }
  const hidden = new Set<string>()
  await Promise.all(
    [...byType.entries()].map(async ([type, ids]) => {
      const visible = await visiblePrivateKindIds(supabase, type, userId, [...ids], workspaceId)
      for (const id of ids) if (!visible.has(id)) hidden.add(`${type}:${id}`)
    }),
  )
  return hidden
}

/** The placeholder a hidden node of a private kind shows instead of its label. */
export const PRIVATE_KIND_LABEL: Record<PrivateGraphKind, string> = {
  calendar_event: 'Calendar event (private)',
  team_chat_channel: 'Channel (private)',
  team_chat_message: 'Message (private)',
  decision: 'Decision (private)',
}
