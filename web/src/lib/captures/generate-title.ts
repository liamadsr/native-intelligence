import type { SupabaseClient } from '@supabase/supabase-js'
import { usageProviderLabel } from '@/lib/ai/models'
import { logUsage } from '@/lib/ai/auth'
import { runUtilityTask } from '@/lib/eve/utility/run-utility'
import { usageCacheMetadata } from '@/lib/chat/eve-usage'
import { chatgptPlanFor } from '@/lib/chatgpt/plan-route'

/**
 * Name a capture from its ai_summary — the body of POST
 * /api/account/captures/[id]/generate-title, lifted out so the server-side
 * finalizer (capture-finalizer.ts, a recording whose recorder died before Stop)
 * names the capture exactly as the Stop path's fire-and-forget call does.
 *
 * Only runs while the title is still the auto-generated placeholder
 * ("Capture Mon D H:MM AM/PM") and a summary exists. A failed generation
 * THROWS (the route maps it to a 500); every guard is a `skipped` result.
 */
export type GenerateCaptureTitleResult =
  | { status: 'ok'; title: string }
  | { status: 'not_found' }
  | { status: 'skipped'; reason: string }

const AUTO_TITLE = /^Capture\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{1,2}:\d{2}\s*(AM|PM)$/i

export async function generateCaptureTitle(
  supabase: SupabaseClient,
  args: { captureId: string; workspaceId: string; userId: string },
): Promise<GenerateCaptureTitleResult> {
  const { captureId, workspaceId, userId } = args

  const { data: capture } = await supabase
    .from('captures')
    .select('title, ai_summary')
    .eq('id', captureId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!capture) return { status: 'not_found' }

  // Only generate if the title is still the auto-generated placeholder
  if (!AUTO_TITLE.test(capture.title?.trim() || '')) {
    return { status: 'skipped', reason: 'Title already set' }
  }

  if (!capture.ai_summary) {
    return { status: 'skipped', reason: 'No summary to generate from' }
  }

  const startTime = Date.now()

  // One task session on the eve utility agent, on the drafting surface's
  // fixed model (SURFACE_MODELS). The prompt rides as the message.
  const result = await runUtilityTask({
    kind: 'generate_title',
    supabase,
    workspaceId,
    userId,
    // No usage check on this path: a free user's title runs on their own
    // ChatGPT plan, everyone else's as before.
    chatgptPlan: await chatgptPlanFor(userId),
    message: `Generate a short, descriptive title (3-8 words) for this meeting based on the summary below. Return ONLY the title text, nothing else. No quotes, no prefix, no explanation.

Summary:
${capture.ai_summary.slice(0, 2000)}`,
  })

  // Bare app id the session ran on; eve's cost signal is 0/absent → null →
  // omitted, so log_ai_usage prices the row from ai_model_costs.
  await logUsage(userId, {
    provider: usageProviderLabel(result.model),
    model: result.model,
    feature: 'generate_title',
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    durationMs: Date.now() - startTime,
    costUsd: result.usage.costUsd ?? undefined,
    metadata: { captureId, ...usageCacheMetadata(result.usage) },
  })

  const title = result.text.trim().replace(/^["']|["']$/g, '')
  if (!title || title.length > 100) {
    return { status: 'skipped', reason: 'Generated title invalid' }
  }

  await supabase
    .from('captures')
    .update({ title })
    .eq('id', captureId)
    .eq('workspace_id', workspaceId)

  return { status: 'ok', title }
}
