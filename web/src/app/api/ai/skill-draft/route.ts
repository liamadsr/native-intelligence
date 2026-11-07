import { z } from 'zod'
import { usageProviderLabel } from '@/lib/ai/models'
import { getServiceClient } from '@/lib/admin'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { authenticateUser, logUsage } from '@/lib/ai/auth'
import { usageOnPlan } from '@/lib/chatgpt/plan-route'
import { runUtilityTask } from '@/lib/eve/utility/run-utility'
import { usageCacheMetadata } from '@/lib/chat/eve-usage'
import { badRequest, serverError } from '@/lib/api-errors'
import { NextResponse } from 'next/server'

/**
 * POST /api/ai/skill-draft — writes a skill's ROUTING DESCRIPTION from its
 * prompt. Consumed by the "Suggest description" affordance in the Agents &
 * Skills editor (item-dialogs.tsx). Output is used CLIENT-side to fill the
 * form field, so this is a plain server-only generation with no DB write.
 *
 * This route used to carry a second `conversation` mode: the distiller behind
 * the "Save as skill" button, which turned a whole chat conversation into a
 * skill draft. That button is gone — skill authoring is now the /create-skill
 * SYSTEM SKILL (migration 225), which does the same distillation in
 * conversation using the create_skill tool, and can also interview the user,
 * check for near-duplicates, and revise existing skills. The mode had exactly
 * one caller and went with it.
 *
 * The `mode` field is still REQUIRED and must be 'description'. Keeping the
 * discriminator (rather than dropping it for a bare body) means a stale client
 * posting `mode: 'conversation'` gets an explicit 400 instead of silently
 * receiving a description it didn't ask for.
 *
 * Auth/billing wiring mirrors the capture generate-title / draft-followup
 * routes: authenticateUser → checkUsageLimits → one structured task session on
 * the eve utility agent (kind 'skill_draft'; its system prompt lives in
 * src/lib/eve/utility/prompts.ts) → logUsage.
 */

// The description is the ROUTING HINT — chat auto-loads a skill from this line
// alone, so it must state WHEN the skill applies and stay short (the editor's
// own guidance caps it at ~200 chars).
const DescriptionOnly = z.object({
  description: z
    .string()
    .describe(
      'A routing hint stating WHEN this skill applies, so chat can decide to auto-load it. One sentence, at most 200 characters. Describe the situation/trigger, not the mechanics.',
    ),
})

// Server-side input caps so a huge or adversarial prompt can't blow the context
// window or the bill.
const MAX_PROMPT_CHARS = 20_000
const MAX_NAME_CHARS = 200

export async function POST(req: Request) {
  // authenticateUser / checkUsageLimits signal failure by THROWING a Response
  // (the shared idiom in @/lib/ai/auth). Next route handlers don't auto-convert
  // a thrown Response into the HTTP response, so mirror the sibling routes
  // (see /api/ai/complete): catch it and RETURN it, else a 401/429/503 leaks as
  // an opaque 500.
  try {
    const { user } = await authenticateUser(req)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    if (!body || typeof body !== 'object') {
      return badRequest('Request body must be an object')
    }

    if ((body as { mode?: unknown }).mode !== 'description') {
      return badRequest("mode must be 'description'")
    }

    const prompt = (body as { prompt?: unknown }).prompt
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return badRequest('prompt is required')
    }
    const name = (body as { name?: unknown }).name
    const nameStr = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_CHARS) : ''

    // The usage check, opted in to the ChatGPT free tier: a free user's draft
    // runs on their own plan (runUtilityTask's chatgptPlan).
    const chatgptPlan = await usageOnPlan(user.id)
    const startTime = Date.now()

    const promptText = [
      nameStr ? `Skill name: ${nameStr}` : '',
      'Skill prompt:',
      prompt.trim().slice(0, MAX_PROMPT_CHARS),
    ]
      .filter(Boolean)
      .join('\n\n')

    // Runs on the drafting surface's fixed model (SURFACE_MODELS) —
    // runUtilityTask resolves it and reports the model it ran on.
    const workspaceId = await getCurrentWorkspaceId()

    try {
      const result = await runUtilityTask({
        kind: 'skill_draft',
        supabase: getServiceClient(),
        workspaceId,
        userId: user.id,
        chatgptPlan,
        message: promptText,
        outputSchema: DescriptionOnly,
      })

      await logUsage(user.id, {
        provider: usageProviderLabel(result.model),
        model: result.model,
        feature: 'skill_draft',
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        durationMs: Date.now() - startTime,
        costUsd: result.usage.costUsd ?? undefined,
        metadata: { mode: 'description', ...usageCacheMetadata(result.usage) },
      })

      return NextResponse.json({ description: result.object.description })
    } catch (err) {
      console.error('[skill-draft] description mode failed:', err)
      return serverError('Failed to draft description')
    }
  } catch (error) {
    if (error instanceof Response) return error

    console.error('[skill-draft] unexpected error:', error)
    return serverError('Failed to draft description')
  }
}
