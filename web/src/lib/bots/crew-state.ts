/**
 * Who the AI usage limit has stopped (docs/plans/bots-v4.md Phase 4b): the
 * agent's page and the main agent's reads say why a teammate
 * sleeps.
 *
 * The AI limit (aiLimitedTeammates) is the shared source's answer
 * (`ai_limited`, queries.ts listAiLimitedTeammates, read with the light read)
 * moved on by the rows pushed since it was read: one stopped by the limit
 * sleeps from that moment, and a later run of any kind wakes it.
 *
 * Pure, so it reads anywhere.
 */
import { AI_LIMIT_WINDOW_MS, isPausedFailure, settledAt } from '@/lib/work/presentation'
import type { AiLimitedTeammate } from '@/lib/work/queries'
import type { WorkItem } from '@/lib/work/types'

/** Who the AI limit has stopped, by teammate id, with when (a settled time). */
export type AiLimited = ReadonlyMap<string, string>

/** A held row as the AI limit reads it: a light row (no error message) or a full one. */
export type AiLimitRow = Pick<WorkItem, 'id' | 'ai_team_member_id' | 'status' | 'created_at'> &
  Partial<Pick<WorkItem, 'error_message' | 'finished_at'>>

const time = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN)

/** When a row last moved: when it settled, else when it started. */
const movedAt = (row: AiLimitRow): number => {
  const finished = time(row.finished_at)
  return Number.isFinite(finished) ? finished : time(row.created_at)
}

/**
 * The teammates the AI usage limit has stopped, now: the answer's (read at
 * `asOf`), then each held row that started or settled after `asOf`, in the
 * order they did, for its teammate (the channel's pushes: a run already going
 * when the answer was read and stopped by the limit after it counts too): a
 * run stopped by the limit stops it from when it settled, any other run wakes
 * it. Then only those stopped within AI_LIMIT_WINDOW_MS of `now` (as the
 * page's stoppedByAiLimit). With no `asOf` the answer stands alone.
 */
export function aiLimitedTeammates(
  answer: readonly AiLimitedTeammate[],
  asOf: string | null,
  rows: readonly AiLimitRow[] | null,
  now: number,
): Map<string, string> {
  const stopped = new Map<string, string>(answer.map((t) => [t.teammate_id, t.at]))
  const from = time(asOf)
  if (Number.isFinite(from) && rows) {
    const later = rows
      .filter((r) => r.ai_team_member_id && (time(r.created_at) > from || time(r.finished_at) > from))
      .sort((a, b) => movedAt(a) - movedAt(b))
    for (const row of later) {
      const id = row.ai_team_member_id as string
      if (isPausedFailure({ status: row.status, error_message: row.error_message ?? null })) {
        stopped.set(id, settledAt({ finished_at: row.finished_at ?? null, created_at: row.created_at }))
      } else {
        stopped.delete(id)
      }
    }
  }
  for (const [id, at] of stopped) {
    const t = time(at)
    if (!Number.isFinite(t) || now - t > AI_LIMIT_WINDOW_MS) stopped.delete(id)
  }
  return stopped
}
