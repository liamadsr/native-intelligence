/**
 * A person's pushes (the iOS app): which installs they have, the badge, and
 * one push to every live install of theirs. Server only, on the service
 * client (push_token is no client's to read, migration 562).
 *
 * Push is off until the four APNs settings are set (./apns.ts apnsConfig):
 * then {@link hasPushTarget} is false without a read, and the router and the
 * team chat email behave as they did before push existed. On, a person is a
 * push target when they have a live install of this app (its bundle id is
 * the settings' APNS_BUNDLE_ID; a token Apple said is gone is disabled).
 *
 * What a push says is the caller's (the team chat notification's words, the
 * agent's message); every push carries the person's badge (563's
 * team_chat_badge, their team chat unread in every workspace) and the ids
 * the app opens it at.
 *
 * An install has two tokens (migration 570): its alert token, for the
 * notifications above, and its VoIP token, for a team call's ring and its
 * cancel ({@link voipToPerson}, src/lib/team-calls/ring-push.ts). Each read
 * is of one kind: an alert never goes to a VoIP token, a ring never to an
 * alert token.
 *
 * Privacy: logs carry ids, counts and Apple's reasons, never a token or a
 * word.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  apnsConfig,
  createApnsSender,
  type ApnsConfig,
  type ApnsEnvironment,
  type ApnsNotification,
  type ApnsResult,
  type ApnsSender,
  type ApnsVoipPush,
} from './apns'

/** Which of an install's tokens (migration 570). */
export type PushTokenKind = 'alert' | 'voip'

export interface PushTokenRow {
  id: string
  token: string
  environment: ApnsEnvironment
  /** When the app last registered it: the phone saying it still wants pushes. */
  last_seen_at: string
}

/**
 * How recently an install must have registered to be pushed to. The app
 * registers on every signed-in launch and return while notifications are
 * allowed (and takes the install off when they are turned off), so an install
 * not seen in this long is a phone that stopped asking: pushing to it would
 * stand in for the text, Slack or email the person would actually see.
 */
export const PUSH_TOKEN_FRESH_MS = 30 * 24 * 60 * 60_000

/** The installs seen recently enough to push to. Pure. */
export function freshTokens<T extends Pick<PushTokenRow, 'last_seen_at'>>(rows: readonly T[], nowMs: number): T[] {
  return rows.filter((r) => {
    const seen = Date.parse(r.last_seen_at)
    return Number.isFinite(seen) && nowMs - seen <= PUSH_TOKEN_FRESH_MS
  })
}

let shared: { key: string; sender: ApnsSender } | null = null

/** The process's sender for these settings (one cached provider token, one connection per host). */
function senderFor(config: ApnsConfig): ApnsSender {
  const key = `${config.keyId}:${config.teamId}:${config.bundleId}`
  if (shared?.key !== key) {
    shared?.sender.close()
    shared = { key, sender: createApnsSender({ config }) }
  }
  return shared.sender
}

export interface PushDeps {
  config: ApnsConfig | null
  now?: () => number
  /** The person's installs of this app that aren't disabled, of one kind, newest seen first (freshness is checked by {@link freshTokens}). */
  tokens(userId: string, bundleId: string, kind: PushTokenKind): Promise<PushTokenRow[]>
  /** Stop using an install Apple said is gone. */
  disable(tokenId: string, reason: string): Promise<void>
  badge(userId: string): Promise<number | null>
  send(config: ApnsConfig, input: { token: string; environment: ApnsEnvironment; notification: ApnsNotification }): Promise<ApnsResult>
  sendVoip(config: ApnsConfig, input: { token: string; environment: ApnsEnvironment; push: ApnsVoipPush }): Promise<ApnsResult>
}

/** The real store and Apple, on the service client. */
export function livePushDeps(svc: SupabaseClient, env: Record<string, string | undefined> = process.env): PushDeps {
  return {
    config: apnsConfig(env),
    tokens: async (userId, bundleId, kind) => {
      const { data, error } = await svc
        .from('push_token')
        .select('id, token, environment, last_seen_at')
        .eq('user_id', userId)
        .eq('kind', kind)
        .eq('bundle_id', bundleId)
        .is('disabled_at', null)
        .gt('last_seen_at', new Date(Date.now() - PUSH_TOKEN_FRESH_MS).toISOString())
        .order('last_seen_at', { ascending: false })
        .limit(10)
      if (error) throw new Error(`push_token read failed: ${error.message}`)
      return (data ?? []) as PushTokenRow[]
    },
    disable: async (tokenId, reason) => {
      const { error } = await svc.from('push_token').update({ disabled_at: new Date().toISOString(), disabled_reason: reason.slice(0, 60) }).eq('id', tokenId)
      if (error) console.warn(`[push] token=${tokenId} not disabled:`, error.message)
    },
    badge: async (userId) => {
      const { data, error } = await svc.rpc('team_chat_badge', { for_user: userId })
      if (error) return null
      const n = Number(data)
      return Number.isFinite(n) ? n : null
    },
    send: (config, input) => senderFor(config).send(input),
    sendVoip: (config, input) => senderFor(config).sendVoip(input),
  }
}

/** The person's installs that may be pushed to now, of one kind: not disabled, seen recently. Throws on a failed read. */
async function liveInstalls(deps: PushDeps, userId: string, config: ApnsConfig, kind: PushTokenKind = 'alert'): Promise<PushTokenRow[]> {
  return freshTokens(await deps.tokens(userId, config.bundleId, kind), (deps.now ?? Date.now)())
}

/** Whether a person can be pushed right now: push is on and they have a live, recently seen install. Never throws (false). */
export async function hasPushTarget(deps: PushDeps, userId: string): Promise<boolean> {
  if (!deps.config) return false
  try {
    return (await liveInstalls(deps, userId, deps.config)).length > 0
  } catch (err) {
    console.warn(`[push] user=${userId} targets not read:`, err instanceof Error ? err.message : 'unknown')
    return false
  }
}

export type PushOutcome = 'off' | 'no_target' | 'sent' | 'failed'

/**
 * Pushes to every live install of the person's: one or several (a send run's
 * conversations), their installs read and their badge counted ONCE for all of
 * them. An install Apple says is gone is disabled and not tried again in the
 * run. 'sent' when at least one install took at least one push. Never throws.
 */
export async function pushToPerson(deps: PushDeps, input: { userId: string; notifications: ReadonlyArray<Omit<ApnsNotification, 'badge'>> }): Promise<PushOutcome> {
  const config = deps.config
  if (!config) return 'off'
  let tokens: PushTokenRow[]
  try {
    tokens = await liveInstalls(deps, input.userId, config)
  } catch (err) {
    console.warn(`[push] user=${input.userId} targets not read:`, err instanceof Error ? err.message : 'unknown')
    return 'failed'
  }
  if (tokens.length === 0) return 'no_target'
  if (input.notifications.length === 0) return 'failed'
  const badge = await deps.badge(input.userId).catch(() => null)
  let sent = 0
  const reasons: string[] = []
  const gone = new Set<string>()
  for (const one of input.notifications) {
    const notification: ApnsNotification = { ...one, ...(badge !== null ? { badge } : {}) }
    for (const row of tokens) {
      if (gone.has(row.id)) continue
      const result = await deps.send(config, { token: row.token, environment: row.environment, notification }).catch(
        (err): ApnsResult => ({ ok: false, gone: false, status: 0, reason: err instanceof Error ? err.message : 'unknown' }),
      )
      if (result.ok) {
        sent++
        continue
      }
      reasons.push(`${result.status}:${result.reason}`)
      if (result.gone) {
        gone.add(row.id)
        await deps.disable(row.id, result.reason)
      }
    }
  }
  console.info(`[push] user=${input.userId} installs=${tokens.length} pushes=${input.notifications.length} sent=${sent}${reasons.length ? ` refused=${reasons.join(',')}` : ''}`)
  return sent > 0 ? 'sent' : 'failed'
}

/**
 * One VoIP push (a team call's ring, or its cancel) to every live VoIP
 * install of the person's but the ones named in `exceptTokens` (the phone
 * that answered: it is in the call, and needs no cancel). An install Apple
 * says is gone is disabled. 'sent' when at least one took it. No badge, no
 * words: the phone draws the call itself. Never throws.
 */
export async function voipToPerson(
  deps: PushDeps,
  input: { userId: string; push: ApnsVoipPush; exceptTokens?: readonly string[] },
): Promise<PushOutcome> {
  const config = deps.config
  if (!config) return 'off'
  let tokens: PushTokenRow[]
  try {
    tokens = await liveInstalls(deps, input.userId, config, 'voip')
  } catch (err) {
    console.warn(`[push] user=${input.userId} voip targets not read:`, err instanceof Error ? err.message : 'unknown')
    return 'failed'
  }
  const except = new Set((input.exceptTokens ?? []).map((t) => t.toLowerCase()))
  const targets = tokens.filter((t) => !except.has(t.token.toLowerCase()))
  if (targets.length === 0) return 'no_target'
  let sent = 0
  const reasons: string[] = []
  for (const row of targets) {
    const result = await deps.sendVoip(config, { token: row.token, environment: row.environment, push: input.push }).catch(
      (err): ApnsResult => ({ ok: false, gone: false, status: 0, reason: err instanceof Error ? err.message : 'unknown' }),
    )
    if (result.ok) {
      sent++
      continue
    }
    reasons.push(`${result.status}:${result.reason}`)
    if (result.gone) await deps.disable(row.id, result.reason)
  }
  console.info(`[push] user=${input.userId} voip installs=${targets.length} sent=${sent}${reasons.length ? ` refused=${reasons.join(',')}` : ''}`)
  return sent > 0 ? 'sent' : 'failed'
}
