import 'server-only'
import { getAdminServiceClient, requireAdmin } from '@/lib/admin'
import { JEV_PROVEN_MIN_AGREEMENT, JEV_PROVEN_MIN_CASES } from '@/lib/agent-events/router'

/**
 * `provenFromThumbs` (live sidekick Phase 7): how Jev's shadow `nudge.worth`
 * answers line up with the person's own thumbs on the same nudges. A READOUT
 * only: nothing enforces it, and it changes no bar. The bar it is compared to is
 * the router's (JEV_PROVEN_MIN_CASES trusted answers at JEV_PROVEN_MIN_AGREEMENT,
 * one version), imported, never restated or lowered here.
 *
 * The join: each answer's ai_usage_logs row carries `message_id` (the nudge's
 * chat row ui_message_id, nudge-worth-shadow.ts); a thumbs rating is an
 * eval_candidate row with ref_type 'chat_message', ref_id = that id, source
 * thumbs_up or thumbs_down, and for a thumbs-down the reason chip in
 * evidence.nudge_reason.
 *
 * What counts as right:
 *   - 👍                                         → send was right;
 *   - 👎 with not_useful, repeated or wrong      → hold was right;
 *   - 👎 with no chip                            → hold was right (the plain
 *                                                  thumbs-down rule);
 *   - 👎 with too_late                           → a TIMING problem, not a worth
 *                                                  one: counted on its own
 *                                                  (tooLate), left out of
 *                                                  agreement.
 * Only trusted answers are scored (an untrusted one is "unsure": runDecision
 * logged it with outcome `escalate`, and nothing would act on it). A false
 * suppression is a trusted `hold` on a nudge the person thumbed up: the costly
 * error once Jev holds nudges.
 */

/** One `decision.nudge.worth` usage row, projected. */
export interface NudgeWorthAnswerRow {
  message_id: string | null
  version: string | null
  outcome: string | null
  choice: string | null
  created_at?: string
}

/** One thumbs rating on a chat message, projected. */
export interface NudgeThumbRow {
  ref_id: string | null
  source: string | null
  nudge_reason: string | null
}

export interface NudgeWorthVersionReadout {
  version: string
  /** Answer rows for this version (one per nudge). */
  answers: number
  /** Trusted picks. */
  send: number
  hold: number
  /** Jev answered under the trust bar (recorded, never acted on). */
  unsure: number
  /** No answer: the call failed, timed out or was cancelled. */
  failed: number
  /** Answers whose nudge the person rated (any pick, trusted or not). */
  thumbed: number
  thumbsUp: number
  thumbsDown: number
  /** Thumbed 👎 with the too_late chip: a timing problem, out of agreement. */
  tooLate: number
  /** Trusted, thumbed, not too_late: the answers agreement is measured on. */
  scored: number
  agreed: number
  /** agreed / scored, or null with nothing scored. */
  agreement: number | null
  /** A trusted hold on a 👍 nudge. */
  falseSuppressions: number
  /** A trusted send on a 👎 (not too_late) nudge. */
  falseSends: number
  /** Whether it would meet the router's proof bar. Informational only: nothing reads it. */
  meetsBar: boolean
}

export interface NudgeWorthReadout {
  windowDays: number
  from: string
  to: string
  bar: { minCases: number; minAgreement: number }
  versions: NudgeWorthVersionReadout[]
  /** A read hit its bound or failed: the counts are partial. */
  partial: boolean
}

const WORTH_DOWN_REASONS = new Set(['not_useful', 'repeated', 'wrong'])

/** The readout per version, newest version name last. Pure. */
export function provenFromThumbs(
  answers: readonly NudgeWorthAnswerRow[],
  thumbs: readonly NudgeThumbRow[],
): NudgeWorthVersionReadout[] {
  const rating = new Map<string, { up: boolean; reason: string | null }>()
  for (const t of thumbs) {
    if (!t.ref_id || (t.source !== 'thumbs_up' && t.source !== 'thumbs_down')) continue
    rating.set(t.ref_id, { up: t.source === 'thumbs_up', reason: t.source === 'thumbs_down' ? t.nudge_reason ?? null : null })
  }
  // One answer per (version, nudge): the newest row wins (rows arrive oldest first).
  const latest = new Map<string, NudgeWorthAnswerRow>()
  answers.forEach((row, index) => {
    const version = row.version || 'unknown'
    latest.set(`${version}\u0000${row.message_id ?? `row:${index}`}`, row)
  })
  const byVersion = new Map<string, NudgeWorthVersionReadout>()
  for (const row of latest.values()) {
    const version = row.version || 'unknown'
    let v = byVersion.get(version)
    if (!v) {
      v = { version, answers: 0, send: 0, hold: 0, unsure: 0, failed: 0, thumbed: 0, thumbsUp: 0, thumbsDown: 0,
        tooLate: 0, scored: 0, agreed: 0, agreement: null, falseSuppressions: 0, falseSends: 0, meetsBar: false }
      byVersion.set(version, v)
    }
    v.answers++
    const trusted = row.outcome === 'accepted' && (row.choice === 'send' || row.choice === 'hold') ? row.choice : null
    if (trusted === 'send') v.send++
    else if (trusted === 'hold') v.hold++
    else if (row.outcome === 'escalate' && row.choice) v.unsure++
    else v.failed++
    const rated = row.message_id ? rating.get(row.message_id) : undefined
    if (!rated) continue
    v.thumbed++
    if (rated.up) v.thumbsUp++
    else v.thumbsDown++
    if (!rated.up && rated.reason === 'too_late') {
      v.tooLate++
      continue
    }
    // A thumbs-down with a chip outside the worth reasons (none today) isn't scored.
    if (!rated.up && rated.reason !== null && !WORTH_DOWN_REASONS.has(rated.reason)) continue
    if (!trusted) continue
    v.scored++
    const right = rated.up ? 'send' : 'hold'
    if (trusted === right) v.agreed++
    else if (trusted === 'hold') v.falseSuppressions++
    else v.falseSends++
  }
  return [...byVersion.values()]
    .map((v) => {
      const agreement = v.scored > 0 ? v.agreed / v.scored : null
      return { ...v, agreement, meetsBar: v.scored >= JEV_PROVEN_MIN_CASES && agreement !== null && agreement >= JEV_PROVEN_MIN_AGREEMENT }
    })
    .sort((a, b) => a.version.localeCompare(b.version))
}

/** The readout's window and its read bounds. */
export const NUDGE_WORTH_WINDOW_DAYS = 30
export const NUDGE_WORTH_ROW_LIMIT = 5000
const PAGE = 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const NUDGE_WORTH_ANSWER_PROJECTION = [
  'created_at', 'message_id:metadata->>message_id', 'version:metadata->>decision_version',
  'outcome:metadata->>outcome', 'choice:metadata->answers->worth->>choice',
].join(',')
export const NUDGE_THUMB_PROJECTION = 'ref_id,source,nudge_reason:evidence->>nudge_reason'

type Page<T> = { data: T[] | null; error: unknown }

/** Up to NUDGE_WORTH_ROW_LIMIT rows, a page at a time; `partial` when the bound was hit or a page failed. */
async function bounded<T>(page: (from: number, to: number) => PromiseLike<Page<T>>): Promise<{ rows: T[]; partial: boolean }> {
  const rows: T[] = []
  try {
    for (let offset = 0; offset <= NUDGE_WORTH_ROW_LIMIT; offset += PAGE) {
      const res = await page(offset, offset + PAGE - 1)
      if (res.error || !Array.isArray(res.data)) return { rows, partial: true }
      rows.push(...res.data)
      if (res.data.length < PAGE) return { rows, partial: false }
      if (rows.length >= NUDGE_WORTH_ROW_LIMIT) return { rows: rows.slice(0, NUDGE_WORTH_ROW_LIMIT), partial: true }
    }
  } catch {
    return { rows, partial: true }
  }
  return { rows, partial: true }
}

/**
 * Admin-only, bounded reads (never a model call): the last 30 days of
 * nudge.worth answers and of thumbs on nudges (a nudge is rated after its
 * call, so its rating is never older than its answer), joined in memory.
 */
export async function loadNudgeWorthReadout(opts: { workspaceId?: string; now?: number } = {}): Promise<NudgeWorthReadout> {
  await requireAdmin()
  const db = await getAdminServiceClient()
  const to = new Date(opts.now ?? Date.now())
  const from = new Date(to.getTime() - NUDGE_WORTH_WINDOW_DAYS * 86_400_000)
  const workspaceId = opts.workspaceId && UUID.test(opts.workspaceId) ? opts.workspaceId.toLowerCase() : undefined
  const [answers, thumbs] = await Promise.all([
    bounded<NudgeWorthAnswerRow>((a, b) => {
      let q = db.from('ai_usage_logs').select(NUDGE_WORTH_ANSWER_PROJECTION)
        .eq('feature', 'decision.nudge.worth')
        .gte('created_at', from.toISOString()).lt('created_at', to.toISOString())
      if (workspaceId) q = q.eq('metadata->>workspace_id', workspaceId)
      return q.order('created_at', { ascending: true }).order('id', { ascending: true }).range(a, b).returns<NudgeWorthAnswerRow[]>()
    }),
    bounded<NudgeThumbRow>((a, b) => {
      let q = db.from('eval_candidate').select(NUDGE_THUMB_PROJECTION)
        .eq('ref_type', 'chat_message').in('source', ['thumbs_up', 'thumbs_down'])
        .not('evidence->>nudge_kind', 'is', null)
        .gte('created_at', from.toISOString())
      if (workspaceId) q = q.eq('workspace_id', workspaceId)
      return q.order('created_at', { ascending: true }).order('id', { ascending: true }).range(a, b).returns<NudgeThumbRow[]>()
    }),
  ])
  return {
    windowDays: NUDGE_WORTH_WINDOW_DAYS,
    from: from.toISOString(),
    to: to.toISOString(),
    bar: { minCases: JEV_PROVEN_MIN_CASES, minAgreement: JEV_PROVEN_MIN_AGREEMENT },
    versions: provenFromThumbs(answers.rows, thumbs.rows),
    partial: answers.partial || thumbs.partial,
  }
}
