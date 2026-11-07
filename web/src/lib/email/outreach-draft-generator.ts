/**
 * Outreach draft generator (loop-closure Phase 3, WS-2a).
 *
 * The apply-engine's `sendEmail` creates an `email_draft` SHELL when a
 * `send_email` proposal is applied: status 'pending_review', body NULL — it
 * never sends (apply-engine.ts sendEmail). This module FILLS that shell: given
 * the shell's id and the proposal's context, it makes ONE LLM call to write a
 * short, first-person outreach body and writes body_text/body_html back into the
 * SAME row, leaving status 'pending_review'. It NEVER creates a draft and NEVER
 * sends — SEND stays a human act, always.
 *
 * The accept route calls this AFTER the claim-then-apply flow so the card only
 * resolves once a real, filled draft exists; on failure the shell survives and
 * the card offers a retry into this same row (route: attention-items PATCH).
 *
 * The model call mirrors src/lib/crm/email-drafts.ts: one task session on the
 * eve utility agent (kind 'outreach_draft'), on the workspace's drafting model,
 * with the same usage-logging utils.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { usageProviderLabel } from '@/lib/ai/models'
import { logUsage } from '@/lib/ai/auth'
import { runUtilityTask } from '@/lib/eve/utility/run-utility'
import { usageCacheMetadata } from '@/lib/chat/eve-usage'
import { plainTextToHtml } from '@/lib/email/plain-text-to-html'
import { chatgptPlanFor } from '@/lib/chatgpt/plan-route'

/** The proposal-derived context that grounds the draft. All fields optional —
 *  a synthesized outreach proposal (WS-2b) may carry only an address + subject. */
export interface OutreachDraftContext {
  to_name: string | null
  to_address: string | null
  subject: string | null
  email_context: string | null
  trigger_quote: string | null
  capture_id: string | null
}

export interface OutreachDraftResult {
  success: boolean
  error?: string
}

/**
 * Fill an existing `email_draft` shell with a generated body. Workspace-fenced on
 * every read/write. Returns `{ success:false }` — honestly, never a half-write —
 * when the model call throws, returns empty, or the write fails; the caller keeps
 * the card pending for retry in that case.
 */
export async function generateOutreachDraft(
  supabase: SupabaseClient,
  workspaceId: string,
  draftId: string,
  context: OutreachDraftContext,
): Promise<OutreachDraftResult> {
  // Confirm the shell exists in this workspace and grab user_id for usage logging.
  const { data: draft, error: draftErr } = await supabase
    .from('email_draft')
    .select('id, user_id')
    .eq('id', draftId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (draftErr) return { success: false, error: draftErr.message }
  if (!draft) return { success: false, error: 'Draft not found' }
  // The draft owner's id is known here (selected above) — capture it so the
  // Gateway attribution (below) can be applied to the model call, not just the
  // post-call logUsage. Same value logUsage uses.
  const ownerUserId = draft.user_id as string

  // Best-effort sign-off name from the authenticated caller (the draft owner).
  let userName = 'me'
  try {
    const { data: auth } = await supabase.auth.getUser()
    const full = auth?.user?.user_metadata?.full_name
    if (typeof full === 'string' && full.trim()) userName = full.trim()
  } catch {
    // Fall back to the generic sign-off.
  }

  // Best-effort meeting grounding — the substance already rides email_context /
  // trigger_quote, so a missing capture is not fatal.
  let captureLine = ''
  if (context.capture_id) {
    try {
      const { data: cap } = await supabase
        .from('captures')
        .select('title, ai_summary')
        .eq('id', context.capture_id)
        .eq('workspace_id', workspaceId)
        // Never ground a real outreach email in a synthetic mock meeting
        // (`is_eval`, migration 252). A drafted email quoting a fake sales call
        // is the worst failure mode this feature has, and it is irreversible
        // once sent. Grounding is best-effort anyway, so the fence costs a
        // sentence of context and nothing else. See docs/plans/evals.md §5.2.
        .neq('is_eval', true)
        .maybeSingle()
      const title = typeof cap?.title === 'string' ? cap.title : ''
      const summary = typeof cap?.ai_summary === 'string' ? cap.ai_summary.slice(0, 400) : ''
      if (title || summary) captureLine = `\nFrom the meeting "${title}": ${summary}`
    } catch {
      // Grounding is optional — proceed without it.
    }
  }

  const recipient = context.to_name || context.to_address || 'the recipient'
  // The drafting rules — first person as userName, the sign-off rule that
  // branches on whether a real name was found — are the utility kind's system
  // prompt (src/lib/eve/utility/prompts.ts outreachDraftInstructions), rebuilt
  // by the utility spec route from the userName param below.

  const parts = [
    `Reaching out to: ${recipient}${context.to_address ? ` <${context.to_address}>` : ''}`,
    context.subject ? `Intended subject: ${context.subject}` : '',
    context.email_context ? `Why I'm reaching out: ${context.email_context}` : '',
    context.trigger_quote ? `What I said I'd do (my own words): "${context.trigger_quote}"` : '',
    captureLine,
  ].filter(Boolean)
  const userPrompt = `${parts.join('\n')}\n\nDraft the email body.`

  const startTime = Date.now()
  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  let costUsd: number | undefined
  let cacheMetadata: Record<string, number> = {}
  let draftModel = ''
  try {
    // One task session on the eve utility agent, on the drafting surface's
    // fixed model (SURFACE_MODELS). ANY failure — model, timeout,
    // transport — is an honest { success:false } below, never a half-write.
    const result = await runUtilityTask({
      kind: 'outreach_draft',
      supabase,
      workspaceId,
      userId: ownerUserId,
      // No usage check on this path: a free user's draft runs on their own
      // ChatGPT plan, everyone else's as before.
      chatgptPlan: await chatgptPlanFor(ownerUserId),
      params: { userName },
      message: userPrompt,
    })
    text = (result.text ?? '').trim()
    draftModel = result.model
    inputTokens = result.usage.inputTokens
    outputTokens = result.usage.outputTokens
    // eve's cost is 0/absent → null → omitted: log_ai_usage prices the row.
    costUsd = result.usage.costUsd ?? undefined
    cacheMetadata = usageCacheMetadata(result.usage)
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Draft generation failed' }
  }
  if (!text) return { success: false, error: 'Model returned an empty draft' }

  const bodyHtml = plainTextToHtml(text)

  // Fill the SAME shell. status is left 'pending_review' (untouched) — SEND is a
  // human act. A write error is an honest failure the caller retries.
  const { error: updateErr } = await supabase
    .from('email_draft')
    .update({ body_text: text, body_html: bodyHtml })
    .eq('id', draftId)
    .eq('workspace_id', workspaceId)
  if (updateErr) return { success: false, error: updateErr.message }

  // Usage logging is billing visibility, not draft correctness: a written draft
  // is ready even if this hiccups (logUsage has its own durable retry).
  try {
    await logUsage(ownerUserId, {
      provider: usageProviderLabel(draftModel),
      model: draftModel,
      feature: 'outreach_draft',
      inputTokens,
      outputTokens,
      durationMs: Date.now() - startTime,
      costUsd,
      ...(Object.keys(cacheMetadata).length > 0 ? { metadata: cacheMetadata } : {}),
    })
  } catch {
    // Non-fatal.
  }

  return { success: true }
}
