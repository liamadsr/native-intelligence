/**
 * The Settings list's read (docs/plans/earned-autonomy.md §6, read-only in
 * phase 1): each kind the person has a record for, its level, its record,
 * what it still needs before the agent may offer to take it over, or why it
 * always asks.
 *
 * Reads the person's own rows (RLS: owner select) with the caller's client.
 * The grouping and evaluation are pure (summarizeKinds) so they're tested
 * without a database.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { HARD_LIMIT_WORDS, hardLimitOfKind, type HardLimit } from './hard-limits'
import { kindLabel, parseKindKey } from './kind'
import { evaluateKind, OUTCOMES_READ, type AutonomyLevel, type AutonomyOutcomeKind, type KindDecisions, type NotEligible, type OutcomeEvent } from './rules'

export interface OutcomeRow {
  kind_key: string
  outcome: AutonomyOutcomeKind
  edit_ratio: number | string | null
  created_at: string
}

export interface KindRow {
  kind_key: string
  level: AutonomyLevel
  pinned_ask: boolean
  granted_at: string | null
  demoted_at: string | null
  offer_declined_at: string | null
}

export interface KindSummary {
  key: string
  label: string
  level: AutonomyLevel
  /** Why it always asks, when it does (a hard limit), as the list says it. */
  alwaysAsks: { limit: HardLimit; words: string } | null
  eligible: 'tell' | 'quiet' | null
  blocked: NotEligible | null
  streak: number
  needs: { more: number; days: number }
  counts: Record<AutonomyOutcomeKind, number>
  lastAt: string | null
}

/** The most rows the list reads for one person (newest first). */
export const RECORD_READ_MAX = 2000

/** Group, evaluate and order: kinds with the newest activity first. Pure. */
export function summarizeKinds(outcomes: readonly OutcomeRow[], kinds: readonly KindRow[], now: Date): KindSummary[] {
  const byKey = new Map<string, OutcomeEvent[]>()
  for (const row of outcomes) {
    const list = byKey.get(row.kind_key) ?? []
    if (list.length >= OUTCOMES_READ) continue
    const ratio = row.edit_ratio === null || row.edit_ratio === undefined ? null : Number(row.edit_ratio)
    list.push({ outcome: row.outcome, at: row.created_at, editRatio: Number.isFinite(ratio) ? ratio : null })
    byKey.set(row.kind_key, list)
  }
  const decisions = new Map(kinds.map((k) => [k.kind_key, k]))
  for (const k of kinds) if (!byKey.has(k.kind_key)) byKey.set(k.kind_key, [])
  const out: KindSummary[] = []
  for (const [key, events] of byKey) {
    const parsed = parseKindKey(key)
    if (!parsed) continue
    const limit = hardLimitOfKind(parsed)
    const d = decisions.get(key)
    const dec: KindDecisions = d
      ? { level: d.level, pinnedAsk: d.pinned_ask, grantedAt: d.granted_at, demotedAt: d.demoted_at, offerDeclinedAt: d.offer_declined_at }
      : {}
    const ev = evaluateKind(events, dec, now, limit !== null)
    out.push({
      key,
      label: kindLabel(parsed),
      level: ev.level,
      alwaysAsks: limit ? { limit, words: HARD_LIMIT_WORDS[limit] } : null,
      eligible: ev.eligible,
      blocked: ev.blocked,
      streak: ev.streak,
      needs: ev.needs,
      counts: ev.counts,
      lastAt: ev.lastAt,
    })
  }
  return out.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || a.label.localeCompare(b.label))
}

/** The person's own list, in this workspace. Throws on a failed read (the route answers it). */
export async function listKindSummaries(supabase: SupabaseClient, args: { userId: string; workspaceId: string; now?: Date }): Promise<KindSummary[]> {
  const [outcomes, kinds] = await Promise.all([
    supabase
      .from('autonomy_outcome')
      .select('kind_key, outcome, edit_ratio, created_at')
      .eq('user_id', args.userId)
      .eq('workspace_id', args.workspaceId)
      .order('created_at', { ascending: false })
      .limit(RECORD_READ_MAX),
    supabase
      .from('autonomy_kind')
      .select('kind_key, level, pinned_ask, granted_at, demoted_at, offer_declined_at')
      .eq('user_id', args.userId)
      .eq('workspace_id', args.workspaceId),
  ])
  if (outcomes.error) throw new Error(`autonomy record: ${outcomes.error.message}`)
  if (kinds.error) throw new Error(`autonomy kinds: ${kinds.error.message}`)
  return summarizeKinds((outcomes.data ?? []) as OutcomeRow[], (kinds.data ?? []) as KindRow[], args.now ?? new Date())
}
