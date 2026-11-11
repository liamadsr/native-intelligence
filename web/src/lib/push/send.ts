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
 * Privacy: logs carry ids, counts and Apple's reasons, never a token or a
 * word.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { apnsConfig, createApnsSender, type ApnsConfig, type ApnsEnvironment, type ApnsNotification, type ApnsResult, type ApnsSender } from './apns'

export interface PushTokenRow {
  id: string
  token: string
  environment: ApnsEnvironment
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
  /** The person's live installs of this app. */
  tokens(userId: string, bundleId: string): Promise<PushTokenRow[]>
  /** Stop using an install Apple said is gone. */
  disable(tokenId: string, reason: string): Promise<void>
  badge(userId: string): Promise<number | null>
  send(config: ApnsConfig, input: { token: string; environment: ApnsEnvironment; notification: ApnsNotification }): Promise<ApnsResult>
}

/** The real store and Apple, on the service client. */
export function livePushDeps(svc: SupabaseClient, env: Record<string, string | undefined> = process.env): PushDeps {
  return {
    config: apnsConfig(env),
    tokens: async (userId, bundleId) => {
      const { data, error } = await svc
        .from('push_token')
        .select('id, token, environment')
        .eq('user_id', userId)
        .eq('bundle_id', bundleId)
        .is('disabled_at', null)
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
  }
}

/** Whether a person can be pushed right now: push is on and they have a live install. Never throws (false). */
export async function hasPushTarget(deps: PushDeps, userId: string): Promise<boolean> {
  if (!deps.config) return false
  try {
    return (await deps.tokens(userId, deps.config.bundleId)).length > 0
  } catch (err) {
    console.warn(`[push] user=${userId} targets not read:`, err instanceof Error ? err.message : 'unknown')
    return false
  }
}

export type PushOutcome = 'off' | 'no_target' | 'sent' | 'failed'

/**
 * One push to every live install of the person's; the badge is added here.
 * An install Apple says is gone is disabled. 'sent' when at least one install
 * took it. Never throws.
 */
export async function pushToPerson(deps: PushDeps, input: { userId: string; notification: Omit<ApnsNotification, 'badge'> }): Promise<PushOutcome> {
  const config = deps.config
  if (!config) return 'off'
  let tokens: PushTokenRow[]
  try {
    tokens = await deps.tokens(input.userId, config.bundleId)
  } catch (err) {
    console.warn(`[push] user=${input.userId} targets not read:`, err instanceof Error ? err.message : 'unknown')
    return 'failed'
  }
  if (tokens.length === 0) return 'no_target'
  const badge = await deps.badge(input.userId).catch(() => null)
  const notification: ApnsNotification = { ...input.notification, ...(badge !== null ? { badge } : {}) }
  let sent = 0
  const reasons: string[] = []
  for (const row of tokens) {
    const result = await deps.send(config, { token: row.token, environment: row.environment, notification }).catch(
      (err): ApnsResult => ({ ok: false, gone: false, status: 0, reason: err instanceof Error ? err.message : 'unknown' }),
    )
    if (result.ok) {
      sent++
      continue
    }
    reasons.push(`${result.status}:${result.reason}`)
    if (result.gone) await deps.disable(row.id, result.reason)
  }
  console.info(`[push] user=${input.userId} installs=${tokens.length} sent=${sent}${reasons.length ? ` refused=${reasons.join(',')}` : ''}`)
  return sent > 0 ? 'sent' : 'failed'
}
