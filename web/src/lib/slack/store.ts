/**
 * Slack: typed DB operations over migration 412.
 *
 * `svc` is always a SERVICE-ROLE client. The tables have read-only RLS for
 * people (their own links, their workspace's installations) and no client
 * write policies, so every write goes through here, after the Slack events
 * route verified the forwarded request or an account route authenticated the
 * person. Every function scopes by the ids it is given.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { LINK_CODE_TTL_MS, linkCodeHash, newLinkCode, normalizeLinkCode } from './link-code'

type Svc = SupabaseClient

export interface SlackInstallation {
  slack_team_id: string
  team_name: string
  team_domain: string
  enterprise_id: string | null
  workspace_id: string
  installed_by_user_id: string | null
  connect_installation_id: string
  bot_user_id: string | null
  status: 'active' | 'revoked'
  created_at: string
}

export interface SlackUserLink {
  slack_team_id: string
  slack_user_id: string
  user_id: string
  slack_user_name: string
  linked_at: string
}

const INSTALLATION_COLUMNS =
  'slack_team_id, team_name, team_domain, enterprise_id, workspace_id, installed_by_user_id, connect_installation_id, bot_user_id, status, created_at'
const LINK_COLUMNS = 'slack_team_id, slack_user_id, user_id, slack_user_name, linked_at'

/** Workspace roles that may link their own Slack account (a guest may not). */
export const LINKING_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'member'])
/** Workspace roles that may connect (or disconnect) a Slack workspace. */
export const INSTALLING_ROLES: ReadonlySet<string> = new Set(['owner', 'admin'])

// ── Installations ───────────────────────────────────────────────────────────

/** A Slack team's installation row (any status), or null. Throws on a failed read. */
export async function getInstallation(svc: Svc, teamId: string): Promise<SlackInstallation | null> {
  const { data, error } = await svc.from('slack_installation').select(INSTALLATION_COLUMNS).eq('slack_team_id', teamId).maybeSingle<SlackInstallation>()
  if (error) throw new Error(`slack: installation read failed: ${error.message}`)
  return data ?? null
}

/** The live Slack teams bound to a Dial8 workspace, oldest first. Throws on a failed read. */
export async function installationsForWorkspace(svc: Svc, workspaceId: string): Promise<SlackInstallation[]> {
  const { data, error } = await svc
    .from('slack_installation')
    .select(INSTALLATION_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
  if (error) throw new Error(`slack: installations read failed: ${error.message}`)
  return (data ?? []) as SlackInstallation[]
}

export interface BindInstallationInput {
  teamId: string
  teamName: string
  teamDomain: string
  enterpriseId: string | null
  workspaceId: string
  userId: string
  installationId: string
  botUserId: string | null
}

export type BindResult = { ok: true; rebound: boolean } | { ok: false; reason: 'other_workspace' | 'failed' }

/**
 * Bind a Slack team to a Dial8 workspace. A team is bound to ONE workspace:
 * live and bound elsewhere → refused. A revoked row for another workspace is
 * deleted first (its links go with it, by cascade); a row for this workspace
 * is brought back to life with its links kept.
 */
export async function bindInstallation(svc: Svc, input: BindInstallationInput): Promise<BindResult> {
  let existing: SlackInstallation | null
  try {
    existing = await getInstallation(svc, input.teamId)
  } catch {
    return { ok: false, reason: 'failed' }
  }
  if (existing && existing.workspace_id !== input.workspaceId) {
    if (existing.status === 'active') return { ok: false, reason: 'other_workspace' }
    const { error } = await svc.from('slack_installation').delete().eq('slack_team_id', input.teamId).eq('status', 'revoked')
    if (error) return { ok: false, reason: 'failed' }
    existing = null
  }
  const row = {
    slack_team_id: input.teamId,
    team_name: input.teamName.slice(0, 200),
    team_domain: input.teamDomain.slice(0, 200),
    enterprise_id: input.enterpriseId,
    workspace_id: input.workspaceId,
    connect_installation_id: input.installationId,
    bot_user_id: input.botUserId,
    status: 'active' as const,
    revoked_at: null,
  }
  if (existing) {
    const { error } = await svc.from('slack_installation').update(row).eq('slack_team_id', input.teamId).eq('workspace_id', input.workspaceId)
    return error ? { ok: false, reason: 'failed' } : { ok: true, rebound: existing.status !== 'active' }
  }
  const { error } = await svc.from('slack_installation').insert({ ...row, installed_by_user_id: input.userId })
  // A concurrent bind of the same team: whoever won holds it.
  if (error?.code === '23505') return { ok: false, reason: 'other_workspace' }
  return error ? { ok: false, reason: 'failed' } : { ok: true, rebound: false }
}

/** Mark a team's installation revoked (uninstalled in Slack, or disconnected in Dial8). */
export async function markInstallationRevoked(svc: Svc, teamId: string, workspaceId?: string): Promise<boolean> {
  let query = svc
    .from('slack_installation')
    .update({ status: 'revoked', revoked_at: new Date().toISOString() })
    .eq('slack_team_id', teamId)
    .eq('status', 'active')
  if (workspaceId) query = query.eq('workspace_id', workspaceId)
  const { error } = await query
  return !error
}

// ── Person links ────────────────────────────────────────────────────────────

/** The Dial8 user a Slack user is linked to in a team, or null. Throws on a failed read. */
export async function linkForSlackUser(svc: Svc, teamId: string, slackUserId: string): Promise<SlackUserLink | null> {
  const { data, error } = await svc
    .from('slack_user_link')
    .select(LINK_COLUMNS)
    .eq('slack_team_id', teamId)
    .eq('slack_user_id', slackUserId)
    .maybeSingle<SlackUserLink>()
  if (error) throw new Error(`slack: link read failed: ${error.message}`)
  return data ?? null
}

/** A person's Slack links in the given teams. Throws on a failed read. */
export async function linksForUser(svc: Svc, userId: string, teamIds: readonly string[]): Promise<SlackUserLink[]> {
  if (teamIds.length === 0) return []
  const { data, error } = await svc.from('slack_user_link').select(LINK_COLUMNS).eq('user_id', userId).in('slack_team_id', [...teamIds])
  if (error) throw new Error(`slack: links read failed: ${error.message}`)
  return (data ?? []) as SlackUserLink[]
}

/**
 * Link a Slack user to a Dial8 user in a team. The Slack account decides: a
 * code sent from it replaces whatever it was linked to before, and the
 * person's own earlier Slack account in that team is unlinked (one each way).
 */
export async function linkSlackUser(
  svc: Svc,
  input: { teamId: string; slackUserId: string; userId: string; slackUserName: string },
): Promise<boolean> {
  const bySlackUser = await svc.from('slack_user_link').delete().eq('slack_team_id', input.teamId).eq('slack_user_id', input.slackUserId)
  if (bySlackUser.error) return false
  const byPerson = await svc.from('slack_user_link').delete().eq('slack_team_id', input.teamId).eq('user_id', input.userId)
  if (byPerson.error) return false
  const { error } = await svc.from('slack_user_link').insert({
    slack_team_id: input.teamId,
    slack_user_id: input.slackUserId,
    user_id: input.userId,
    slack_user_name: input.slackUserName.slice(0, 200),
  })
  return !error
}

/** Remove a person's own link in a team. */
export async function unlinkSlackUser(svc: Svc, teamId: string, userId: string): Promise<boolean> {
  const { error } = await svc.from('slack_user_link').delete().eq('slack_team_id', teamId).eq('user_id', userId)
  return !error
}

// ── Link codes ──────────────────────────────────────────────────────────────

/**
 * A fresh link code for a person in a workspace (shown once, in Settings).
 * Their earlier unused codes stop working. Throws on a failed write.
 */
export async function createLinkCode(svc: Svc, input: { userId: string; workspaceId: string; now?: number }): Promise<{ code: string; expiresAt: string }> {
  const now = input.now ?? Date.now()
  await svc.from('slack_link_code').delete().eq('user_id', input.userId).is('used_at', null)
  const code = newLinkCode()
  const expiresAt = new Date(now + LINK_CODE_TTL_MS).toISOString()
  const { error } = await svc.from('slack_link_code').insert({
    code_hash: linkCodeHash(normalizeLinkCode(code)!),
    user_id: input.userId,
    workspace_id: input.workspaceId,
    expires_at: expiresAt,
  })
  if (error) throw new Error(`slack: link code write failed: ${error.message}`)
  return { code, expiresAt }
}

/**
 * Spend a code: one conditional update (unused, unexpired) that marks it used
 * and returns whose it was. Null when it is unknown, used or expired. A code
 * spends once whatever happens next.
 */
export async function redeemLinkCode(svc: Svc, canonical: string, now: number = Date.now()): Promise<{ userId: string; workspaceId: string } | null> {
  const nowIso = new Date(now).toISOString()
  const { data, error } = await svc
    .from('slack_link_code')
    .update({ used_at: nowIso })
    .eq('code_hash', linkCodeHash(canonical))
    .is('used_at', null)
    .gt('expires_at', nowIso)
    .select('user_id, workspace_id')
  if (error || !Array.isArray(data) || data.length !== 1) return null
  const row = data[0] as { user_id?: unknown; workspace_id?: unknown }
  return typeof row.user_id === 'string' && typeof row.workspace_id === 'string' ? { userId: row.user_id, workspaceId: row.workspace_id } : null
}

// ── Members ─────────────────────────────────────────────────────────────────

/** A person's role in a workspace, or null when they are not a member. Throws on a failed read. */
export async function memberRole(svc: Svc, workspaceId: string, userId: string): Promise<string | null> {
  const { data, error } = await svc.from('member').select('role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle<{ role: string | null }>()
  if (error) throw new Error(`slack: member read failed: ${error.message}`)
  return data ? (data.role ?? 'member') : null
}

// ── Event dedupe ────────────────────────────────────────────────────────────

const EVENT_KEEP_MS = 2 * 24 * 60 * 60_000

/**
 * Record an event id. True when this is its first delivery, false for a
 * retry Slack (or Connect) sent again. Throws when the write failed for any
 * other reason (the route answers 500 so the event is retried).
 */
export async function firstDelivery(svc: Svc, eventId: string, teamId: string): Promise<boolean> {
  const { error } = await svc.from('slack_event').insert({ event_id: eventId.slice(0, 100), slack_team_id: teamId.slice(0, 40) })
  if (!error) return true
  if (error.code === '23505') return false
  throw new Error(`slack: event dedupe failed: ${error.message}`)
}

/** Drop dedupe rows and wrong-code rows older than two days. Best-effort. */
export async function purgeOldEvents(svc: Svc, now: number = Date.now()): Promise<void> {
  const before = new Date(now - EVENT_KEEP_MS).toISOString()
  await svc.from('slack_event').delete().lt('received_at', before)
  await svc.from('slack_link_attempt').delete().lt('attempted_at', before)
}

// ── The code-guess cap ──────────────────────────────────────────────────────

/** Wrong codes a Slack user may send in an hour before their codes aren't tried. */
export const LINK_ATTEMPTS_PER_USER_HOUR = 5
/** Wrong codes a whole Slack team may send in an hour. */
export const LINK_ATTEMPTS_PER_TEAM_HOUR = 20
const HOUR_MS = 60 * 60_000

/** Record one wrong code from a Slack user. Best-effort. */
export async function recordFailedLinkAttempt(svc: Svc, teamId: string, slackUserId: string): Promise<void> {
  await svc.from('slack_link_attempt').insert({ slack_team_id: teamId.slice(0, 40), slack_user_id: slackUserId.slice(0, 40) })
}

/**
 * True when this Slack user, or their team, sent too many wrong codes in the
 * last hour: their next code isn't even tried (so a code can't be guessed).
 * Fails closed: a failed count is blocked.
 */
export async function linkAttemptsBlocked(svc: Svc, teamId: string, slackUserId: string, now: number = Date.now()): Promise<boolean> {
  const since = new Date(now - HOUR_MS).toISOString()
  const [byUser, byTeam] = await Promise.all([
    svc.from('slack_link_attempt').select('id', { count: 'exact', head: true }).eq('slack_team_id', teamId).eq('slack_user_id', slackUserId).gte('attempted_at', since),
    svc.from('slack_link_attempt').select('id', { count: 'exact', head: true }).eq('slack_team_id', teamId).gte('attempted_at', since),
  ])
  if (byUser.error || byTeam.error) return true
  return (byUser.count ?? 0) >= LINK_ATTEMPTS_PER_USER_HOUR || (byTeam.count ?? 0) >= LINK_ATTEMPTS_PER_TEAM_HOUR
}

/** A person's member row id in a workspace, or null. Throws on a failed read. */
export async function memberIdOf(svc: Svc, workspaceId: string, userId: string): Promise<string | null> {
  const { data, error } = await svc.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle<{ id: string }>()
  if (error) throw new Error(`slack: member read failed: ${error.message}`)
  return data?.id ?? null
}

// ── Channel threads (414): each person's own conversation for a thread ──────

export interface SlackThread {
  slack_team_id: string
  channel_id: string
  thread_ts: string
  user_id: string
  conversation_id: string
  last_mention_ts: string | null
}

const THREAD_COLUMNS = 'slack_team_id, channel_id, thread_ts, user_id, conversation_id, last_mention_ts'

/**
 * The person's conversation for one Slack channel thread, made on their first
 * mention there: a chat_conversations row marked `outside_channel: 'slack'`
 * (never their home thread) and its slack_thread row. Two first mentions
 * racing land on one (the unique row wins; the loser's empty conversation is
 * removed). Throws on a failed write.
 */
export async function ensureSlackThread(
  svc: Svc,
  input: { teamId: string; channelId: string; threadTs: string; userId: string; workspaceId: string; title: string },
): Promise<SlackThread> {
  const find = async () => {
    const { data, error } = await svc
      .from('slack_thread')
      .select(THREAD_COLUMNS)
      .eq('slack_team_id', input.teamId)
      .eq('channel_id', input.channelId)
      .eq('thread_ts', input.threadTs)
      .eq('user_id', input.userId)
      .maybeSingle<SlackThread>()
    if (error) throw new Error(`slack: thread read failed: ${error.message}`)
    return data ?? null
  }
  const existing = await find()
  if (existing) return existing

  const { data: conv, error: convError } = await svc
    .from('chat_conversations')
    .insert({ user_id: input.userId, workspace_id: input.workspaceId, title: input.title.slice(0, 120), outside_channel: 'slack' })
    .select('id')
    .single<{ id: string }>()
  if (convError || !conv) throw new Error(`slack: thread conversation create failed: ${convError?.message ?? 'no row'}`)
  const { error } = await svc.from('slack_thread').insert({
    slack_team_id: input.teamId,
    channel_id: input.channelId,
    thread_ts: input.threadTs,
    user_id: input.userId,
    conversation_id: conv.id,
  })
  if (!error) return { slack_team_id: input.teamId, channel_id: input.channelId, thread_ts: input.threadTs, user_id: input.userId, conversation_id: conv.id, last_mention_ts: null }
  // Lost a race with another first mention: theirs is the thread's.
  await svc.from('chat_conversations').delete().eq('id', conv.id).eq('user_id', input.userId)
  if (error.code !== '23505') throw new Error(`slack: thread write failed: ${error.message}`)
  const raced = await find()
  if (!raced) throw new Error('slack: thread missing after a race')
  return raced
}

/** Note the newest mention in a thread (the reply's 👀 comes off it). Best-effort. */
export async function noteThreadMention(svc: Svc, conversationId: string, ts: string): Promise<void> {
  await svc.from('slack_thread').update({ last_mention_ts: ts }).eq('conversation_id', conversationId)
}

/** The Slack thread a conversation answers, or null for any other conversation. Throws on a failed read. */
export async function threadForConversation(svc: Svc, conversationId: string, userId: string): Promise<SlackThread | null> {
  const { data, error } = await svc.from('slack_thread').select(THREAD_COLUMNS).eq('conversation_id', conversationId).eq('user_id', userId).maybeSingle<SlackThread>()
  if (error) throw new Error(`slack: thread read failed: ${error.message}`)
  return data ?? null
}
