/**
 * The person's own decisions on a kind (docs/plans/earned-autonomy.md §3 and
 * §6), from their click in Settings › Autonomy, never from a model:
 *
 *   hand_over     ask → tell. Only while EARNED_AUTONOMY=graduate, only on a
 *                 kind the SERVER finds eligible now (the record re-read, the
 *                 hard limits applied), never on a client's word. Liam, 11-27,
 *                 decision 1: this yes is the person's final yes for the kind.
 *   not_now       no offer again for 30 days.
 *   never         pinned to ask until they allow offers again.
 *   allow_offers  unpins.
 *   revoke        back to ask at any time ("Revoke stays available at any
 *                 time", decision 1), with the demotion's cooldown.
 *
 * Quiet is never handed over at launch (decision 2). Pure: the route reads and
 * writes.
 */
import type { KindEvaluation } from './rules'

export const KIND_DECISIONS = ['hand_over', 'not_now', 'never', 'allow_offers', 'revoke'] as const
export type KindDecision = (typeof KIND_DECISIONS)[number]

export function isKindDecision(v: unknown): v is KindDecision {
  return typeof v === 'string' && (KIND_DECISIONS as readonly string[]).includes(v)
}

export type DecisionResult = { ok: true; patch: Record<string, unknown> } | { ok: false; code: string; error: string }

export function decideKind(
  decision: KindDecision,
  ev: Pick<KindEvaluation, 'level' | 'eligible' | 'blocked'>,
  ctx: { graduating: boolean; hardLimited: boolean; now: Date },
): DecisionResult {
  const nowIso = ctx.now.toISOString()
  switch (decision) {
    case 'hand_over':
      if (!ctx.graduating) return { ok: false, code: 'OFF', error: 'Handing work over is not switched on yet.' }
      if (ctx.hardLimited) return { ok: false, code: 'HARD_LIMIT', error: 'This kind of work always asks.' }
      if (ev.eligible !== 'tell') return { ok: false, code: 'NOT_ELIGIBLE', error: 'This kind has not earned that yet.' }
      return { ok: true, patch: { level: 'tell', granted_at: nowIso, pinned_ask: false, offer_declined_at: null } }
    case 'not_now':
      return { ok: true, patch: { offer_declined_at: nowIso } }
    case 'never':
      return { ok: true, patch: { pinned_ask: true, level: 'ask', granted_at: null } }
    case 'allow_offers':
      return { ok: true, patch: { pinned_ask: false } }
    case 'revoke':
      return { ok: true, patch: { level: 'ask', granted_at: null, demoted_at: nowIso } }
  }
}
