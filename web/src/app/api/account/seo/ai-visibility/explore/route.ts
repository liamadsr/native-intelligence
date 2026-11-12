/**
 * POST /api/account/seo/ai-visibility/explore: the prompt explorer. Which
 * questions put to AI assistants mention a domain or a brand, the pages the
 * answers cite most, and the totals (AiMentionsExplore), from the provider's
 * dataset of recorded AI answers.
 *
 *   { target, platform?: 'google' | 'chat_gpt', parts?: ['questions' |
 *     'pages' | 'totals'], location_code?, language_code?, limit?, refresh?,
 *     confirmed? }
 *
 * PAID (each part is a call, about 10 cents and up), metered as the person's
 * own request. A lookup estimated above CONFIRM_ABOVE_USD answers 409
 * CONFIRMATION_REQUIRED with `estimate_usd` until `confirmed: true`. A stored
 * lookup younger than a day answers for free (`from_cache`). ChatGPT data is
 * United States, English only.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { exploreAiMentions } from '@/lib/seo/ai-visibility/explore'
import { aiFailureResponse, jsonBody } from '@/lib/seo/ai-visibility/http'
import { exploreRequestSchema } from '@/lib/seo/ai-visibility/input'
import { seoFailureResponse } from '@/lib/seo/paid'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const parsed = exploreRequestSchema.safeParse(await jsonBody(request))
  if (!parsed.success) return badRequest('That lookup isn’t valid.')
  try {
    const out = await exploreAiMentions(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      parsed.data,
    )
    if (!out.ok) return aiFailureResponse(out)
    return NextResponse.json({
      explore: out.result,
      estimate_usd: out.estimate_usd,
    })
  } catch (err) {
    return seoFailureResponse(err, 'ai visibility explore')
  }
}
