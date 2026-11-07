/**
 * GET /api/account/prospecting/spend — the workspace's month-to-date
 * prospecting spend against its ceiling (spec §9).
 *
 * The ceiling is the guardrail that makes "any member can start a run"
 * (decision 5) safe, and it is invisible until a run parks with
 * `error='monthly_cap'`. That is a bad first time to learn about it: the run
 * you were waiting on is the one that failed. This route is what lets the UI
 * show the number BEFORE a run — on the consent gate and in the list header —
 * so hitting the cap is a thing you saw coming.
 *
 * THE SUM IS THE ENGINE'S OWN. It calls {@link readMonthlySpend}, the same
 * paged function `preflight` gates on, rather than a second query of its own.
 * Two implementations of "what has this workspace spent this month" would
 * disagree the moment one of them forgets to page, and the disagreement would
 * surface as a UI that says $4.20 of $20 next to a run that parked at the
 * ceiling. The run-id argument is `''` because there is no run to exclude
 * here — this is the whole month including everything that has finished.
 *
 * Read-only, and the numbers are not secret within the workspace: any member
 * may see the shared budget they are spending from.
 */
import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { readMonthlySpend } from '@/lib/prospecting/run-shared'
import { PROSPECTING_MONTHLY_CAP_DOLLARS } from '@/lib/prospecting/spend'

export interface ProspectingSpendResponse {
  month_spent_dollars: number
  cap_dollars: number
  /** When the window rolls over: the first instant of the next UTC month. */
  resets_at: string
}

/**
 * The first instant of the UTC month AFTER the one containing `now`.
 *
 * `Date.UTC` normalizes month 12 into January of the next year, so December
 * needs no special case. UTC to match `monthStartIso` — a ceiling shared by a
 * workspace cannot roll over in one member's timezone.
 */
function nextMonthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
}

export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  let spent: number
  try {
    // No run to exclude: every run this month counts, including the one that
    // may be live right now. Its `spent_dollars` is written as it goes, so the
    // number tracks a running search rather than jumping when it finishes.
    spent = await readMonthlySpend(supabase, workspaceId, '', new Date())
  } catch (err) {
    // readMonthlySpend FAILS CLOSED by throwing — it guards real money and
    // must never report $0 for a read it could not make. A 500 is the honest
    // answer; the UI shows nothing rather than a reassuring zero.
    console.error('[prospecting] spend read failed:', err)
    return serverError()
  }

  const body: ProspectingSpendResponse = {
    month_spent_dollars: spent,
    cap_dollars: PROSPECTING_MONTHLY_CAP_DOLLARS,
    resets_at: nextMonthStartIso(new Date()),
  }
  return NextResponse.json(body)
}
