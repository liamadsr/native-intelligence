/**
 * POST /api/internal/onboarding-research/settle — the onboarding researcher's
 * ledger hand-off (Sequence row 6). `finish_research` runs in the eve runtime,
 * which cannot import the work recorder, so after it persists `done` /
 * `skipped` on the member it posts the session id here and this route settles
 * the run's Activity row.
 *
 * Trusts nothing but the session id: the row is found by `run_key`, and what
 * it becomes is read from the member's stored `onboarding_progress.research`
 * (which must name the same session). Authenticated with the agent-run
 * internal secret, like /api/internal/crm-enrichment.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { extractInternalSecret, verifyInternalSecret } from '@/lib/agent-run/agent-run-token'
import { badRequest, serverError, unauthorized } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { settleOnboardingResearchWork } from '@/lib/work/onboarding-research-mirror'

export const dynamic = 'force-dynamic'

const BodySchema = z.object({ sessionId: z.string().min(1).max(200) })

export async function POST(request: Request) {
  if (!verifyInternalSecret(extractInternalSecret(request))) {
    return unauthorized()
  }
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return badRequest('Body must be JSON')
  }
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) return badRequest('sessionId is required', parsed.error.flatten())

  try {
    const result = await settleOnboardingResearchWork(getServiceClient(), parsed.data.sessionId)
    // Not settling is not an error for the caller (a run with no ledger row, a
    // replayed call): it reports why and the tool moves on.
    return NextResponse.json(result)
  } catch (err) {
    console.error('[onboarding-research/settle] failed:', err instanceof Error ? err.message : err)
    return serverError('Could not settle the research item')
  }
}
