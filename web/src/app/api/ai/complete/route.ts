import { surfaceModel } from '@/lib/ai/model-defaults'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { authenticateUser } from '@/lib/ai/auth'
import { usageOnPlan } from '@/lib/chatgpt/plan-route'
import { routeModelTimeoutMs, streamUtilityResponse } from '@/lib/eve/utility/stream-route'
import { badRequest } from '@/lib/api-errors'
import { UTILITY_KIND_SPECS } from '@/lib/eve/utility/spec'

export const maxDuration = 60

export async function POST(req: Request) {
  // The eve session's timer starts only after the pre-work below; its budget
  // is measured from here so the whole invocation fits in maxDuration.
  const routeStartedAt = Date.now()
  try {
    const { user } = await authenticateUser(req)
    // Opted in to the ChatGPT free tier: a free user's completion runs on their plan.
    const chatgptPlan = await usageOnPlan(user.id)

    const body = (await req.json()) as { context?: unknown } | null
    const context = body?.context

    // A non-empty STRING only. The value becomes the eve task message, which
    // also accepts UserContent — an array of file parts from a browser body
    // would otherwise reach the utility agent as a multimodal message (and
    // provision its sandbox to stage the bytes). Only server-built messages
    // (reference ingest) may carry file parts.
    if (typeof context !== 'string' || context.length === 0) {
      return badRequest('context is required')
    }

    // Streams from the eve utility agent, on the drafting surface's fixed
    // model (SURFACE_MODELS: nobody picks a model). The workspace rides the
    // token (tenancy for the run), when the request resolves one.
    const workspaceId = await getCurrentWorkspaceId()
    const model = surfaceModel('drafting')

    // `await`, so a session that cannot start lands in the catch below.
    return await streamUtilityResponse({
      userId: user.id,
      chatgptPlan,
      feature: 'ai_complete',
      model,
      prompt: context,
      kind: 'note_continuation',
      workspaceId,
      timeoutMs: routeModelTimeoutMs(
        UTILITY_KIND_SPECS.note_continuation.timeoutMs,
        routeStartedAt,
        maxDuration * 1000,
      ),
    })
  } catch (error) {
    if (error instanceof Response) return error

    console.error('AI complete error:', error)
    return new Response(
      JSON.stringify({ error: 'Completion failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
}
