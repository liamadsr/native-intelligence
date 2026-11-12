/**
 * POST /api/account/seo/ai-visibility/estimate: what checks would cost,
 * before anything is saved or asked (AiCostEstimate: one check, a month of
 * the schedule, per engine, whether a check needs confirmation, engines the
 * country can't serve).
 *
 *   { tracker_id, ...changes }  a saved tracker, with changes laid over it
 *                               (prompt_count overrides its active prompts).
 *   { prompt_count, engines?, schedule_interval?, location_code?,
 *     language_code? }          settings not saved yet (the setup form).
 *
 * Free: pure maths from the provider's prices.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { aiFailureResponse, jsonBody } from '@/lib/seo/ai-visibility/http'
import { estimateRequestSchema } from '@/lib/seo/ai-visibility/input'
import {
  estimateProposal,
  estimateTracker,
} from '@/lib/seo/ai-visibility/trackers'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const parsed = estimateRequestSchema.safeParse(await jsonBody(request))
  if (!parsed.success) return badRequest('That estimate request isn’t valid.')
  const { tracker_id, prompt_count, ...settings } = parsed.data
  try {
    const out = tracker_id
      ? await estimateTracker(
          getServiceClient(),
          auth.workspaceId,
          tracker_id,
          { ...settings, prompt_count },
        )
      : estimateProposal({ ...settings, prompt_count: prompt_count ?? 0 })
    if (!out.ok) return aiFailureResponse(out)
    return NextResponse.json({ estimate: out.estimate })
  } catch (err) {
    console.error('[seo-ai] estimate failed', err)
    return serverError('Could not work out the estimate just now.')
  }
}
