/**
 * The agent's offer to take a kind over (docs/plans/earned-autonomy.md §3,
 * phase 2): once a kind is eligible, one templated line in the person's home
 * thread says what it has done and asks whether it may handle these itself.
 * Nothing graduates silently: the yes is the person's own click in Settings ›
 * Autonomy (decide.ts, through their own session). The words and numbers come
 * from the record, by code, never from a model.
 *
 * Only while EARNED_AUTONOMY=graduate (an offer under 'record' would be a yes
 * that does nothing). Only to tell: quiet is off at launch (Liam, 11-27,
 * decision 2), so nothing offers it. At most one offer per kind per
 * OFFER_DECLINED_COOLDOWN_DAYS. Never throws.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { appendHomeMessage } from '@/lib/chat/home-message-writer'
import { earnedAutonomyGraduating } from './config'
import { hardLimitOfKind } from './hard-limits'
import { kindLabel, parseKindKey } from './kind'
import { evaluateKind, OFFER_DECLINED_COOLDOWN_DAYS, OUTCOMES_READ, type AutonomyOutcomeKind, type KindEvaluation } from './rules'
import { UNDO_WINDOW_MINUTES } from './graduate'

export const AUTONOMY_SETTINGS_PATH = '/account/settings/autonomy'

/** The offer's words, from the record. Pure. */
export function offerText(label: string, ev: Pick<KindEvaluation, 'streak' | 'streakDays'>): string {
  const days = Math.max(1, Math.round(ev.streakDays))
  return (
    `${label}: I've drafted the last ${ev.streak} of these over ${days} days, and you approved every one as it was. ` +
    `Want me to handle these myself and tell you each time? Each one would wait ${UNDO_WINDOW_MINUTES} minutes so you can stop it, and you can take it back at any time. ` +
    `Say yes in [Settings › Autonomy](${AUTONOMY_SETTINGS_PATH}).`
  )
}

export async function maybeOfferKind(
  db: SupabaseClient,
  args: { workspaceId: string; userId: string; kindKey: string; now?: Date },
  deps: { env?: Record<string, string | undefined>; append?: typeof appendHomeMessage } = {},
): Promise<boolean> {
  if (!earnedAutonomyGraduating(deps.env ?? process.env)) return false
  const parsed = parseKindKey(args.kindKey)
  if (!parsed || hardLimitOfKind(parsed)) return false
  const now = args.now ?? new Date()
  try {
    const { data: kindRow, error: kindError } = await db
      .from('autonomy_kind')
      .select('id, level, pinned_ask, granted_at, demoted_at, offered_at, offer_declined_at')
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .eq('kind_key', args.kindKey)
      .maybeSingle()
    if (kindError) return false
    const k = kindRow as { id: string; level: 'ask' | 'tell' | 'quiet'; pinned_ask: boolean; granted_at: string | null; demoted_at: string | null; offered_at: string | null; offer_declined_at: string | null } | null
    if (k && (k.level !== 'ask' || k.pinned_ask)) return false
    const offered = Date.parse(k?.offered_at ?? '')
    if (Number.isFinite(offered) && now.getTime() - offered < OFFER_DECLINED_COOLDOWN_DAYS * 86_400_000) return false

    const { data, error } = await db
      .from('autonomy_outcome')
      .select('outcome, edit_ratio, created_at')
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .eq('kind_key', args.kindKey)
      .order('created_at', { ascending: false })
      .limit(OUTCOMES_READ)
    if (error) return false
    const events = ((data ?? []) as Array<{ outcome: AutonomyOutcomeKind; edit_ratio: number | string | null; created_at: string }>).map((o) => ({ outcome: o.outcome, at: o.created_at, editRatio: o.edit_ratio === null ? null : Number(o.edit_ratio) }))
    const ev = evaluateKind(events, k ? { level: k.level, pinnedAsk: k.pinned_ask, grantedAt: k.granted_at, demotedAt: k.demoted_at, offerDeclinedAt: k.offer_declined_at } : {}, now, false)
    if (ev.eligible !== 'tell') return false

    const nowIso = now.toISOString()
    const stamp = k
      ? await db.from('autonomy_kind').update({ offered_at: nowIso, updated_at: nowIso }).eq('id', k.id)
      : await db.from('autonomy_kind').insert({ workspace_id: args.workspaceId, user_id: args.userId, kind_key: args.kindKey, level: 'ask', offered_at: nowIso })
    if (stamp.error) return false
    const id = createHash('sha256').update(`${args.workspaceId}|${args.userId}|${args.kindKey}|${nowIso.slice(0, 10)}`).digest('hex').slice(0, 24)
    const written = await (deps.append ?? appendHomeMessage)(db, {
      userId: args.userId,
      workspaceId: args.workspaceId,
      messageId: `autonomy-offer-${id}`,
      parts: [{ type: 'text', text: offerText(kindLabel(parsed), ev) }],
      metadata: { kind: 'autonomy_offer', kind_key: args.kindKey },
    })
    return written.written === true
  } catch {
    return false
  }
}
