import { usageProviderLabel } from '@/lib/ai/models'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { listMemberEmails } from '@/lib/workspace-member-emails'
import { createEmailDraft } from '@/lib/integrations/email'
import { getValidToken } from '@/lib/oauth/token-manager'
import { logUsage } from '@/lib/ai/auth'
import { usageOnPlan } from '@/lib/chatgpt/plan-route'
import { runUtilityTask } from '@/lib/eve/utility/run-utility'
import { usageCacheMetadata } from '@/lib/chat/eve-usage'
import { NextResponse } from 'next/server'

/**
 * POST /api/account/captures/[id]/draft-followup
 *
 * The generated email body is consumed server-side: it's turned into a
 * Gmail/Outlook draft via the user's OAuth tokens and the route returns
 * structured JSON (draft_id, subject, recipients).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id: captureId } = await params
  const body = await req.json()
  const {
    recipients,
    include_actions = true,
    include_decisions = true,
    tone = 'professional',
    additional_context,
  } = body as {
    recipients?: string[]
    include_actions?: boolean
    include_decisions?: boolean
    tone?: 'formal' | 'casual' | 'brief' | 'professional'
    additional_context?: string
  }

  // 1. Fetch the capture
  const { data: capture, error: captureError } = await supabase
    .from('captures')
    .select(`
      id, title, ai_summary, summary, started_at, ended_at, duration_seconds,
      ai_processed, organizer_email
    `)
    .eq('id', captureId)
    .eq('workspace_id', workspaceId)
    .single()

  if (captureError || !capture) {
    return NextResponse.json({ error: 'Capture not found' }, { status: 404 })
  }

  if (!capture.ai_processed) {
    return NextResponse.json(
      { error: 'Capture has not been AI-processed yet' },
      { status: 400 },
    )
  }

  // 2. Fetch confirmed actions
  let actions: { title: string; assignee_name: string | null; due_at: string | null }[] = []
  if (include_actions) {
    const { data } = await supabase
      .from('actions')
      .select(`
        title, due_at,
        assignee:member!assignee_id(display_name)
      `)
      .eq('source_capture_id', captureId)
      .eq('confirmation', 'confirmed')

    actions = (data || []).map((a) => {
      const assignee = a.assignee as unknown as { display_name: string } | null
      return {
        title: a.title,
        assignee_name: assignee?.display_name || null,
        due_at: a.due_at,
      }
    })
  }

  // 3. Fetch confirmed decisions
  let decisions: { content: string }[] = []
  if (include_decisions) {
    const { data } = await supabase
      .from('decision')
      .select('content')
      .eq('capture_id', captureId)
      .eq('confirmation', 'confirmed')

    decisions = data || []
  }

  // 4. Fetch participant emails. A member's is their sign-in address: there is
  //    no member.email column, so it is resolved through the admin API
  //    (workspace-member-emails.ts).
  const { data: participantRows } = await supabase
    .from('capture_participant')
    .select('external_email, member_id')
    .eq('capture_id', captureId)

  const participants = (participantRows || []) as { external_email: string | null; member_id: string | null }[]
  const memberEmails = new Map(
    participants.some((p) => p.member_id)
      ? (await listMemberEmails(workspaceId)).map((m) => [m.id, m.email])
      : [],
  )
  const participantEmails = participants
    .map((p) => (p.member_id && memberEmails.get(p.member_id)) || p.external_email)
    .filter((e): e is string => !!e)

  const toRecipients = recipients?.length ? recipients : participantEmails

  // 5. The sender's name for the signature: their member row in this
  //    workspace. (The legacy `user_profiles` table has no display_name, so
  //    the read this replaced always failed and the draft was never signed.)
  const { data: profile } = await supabase
    .from('member')
    .select('display_name')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle<{ display_name: string | null }>()

  // 6. Build AI prompt
  const durationMinutes = capture.duration_seconds
    ? Math.round(capture.duration_seconds / 60)
    : null

  const promptParts = [
    `Meeting: ${capture.title}`,
    capture.started_at ? `Date: ${new Date(capture.started_at).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}` : '',
    durationMinutes ? `Duration: ${durationMinutes} minutes` : '',
    toRecipients.length ? `Participants: ${toRecipients.join(', ')}` : '',
    '',
    'Summary:',
    capture.ai_summary || capture.summary || '(No summary available)',
  ]

  if (actions.length) {
    promptParts.push(
      '',
      'Action Items:',
      ...actions.map((a) => {
        const owner = a.assignee_name || 'TBD'
        const due = a.due_at ? ` (due ${new Date(a.due_at).toLocaleDateString()})` : ''
        return `- ${a.title} (Owner: ${owner}${due})`
      }),
    )
  }

  if (decisions.length) {
    promptParts.push(
      '',
      'Decisions Made:',
      ...decisions.map((d) => `- ${d.content}`),
    )
  }

  if (additional_context) {
    promptParts.push('', `Additional notes: ${additional_context}`)
  }

  promptParts.push('', 'Please draft a follow-up email for the participants of this meeting.')
  if (profile?.display_name) {
    promptParts.push(`Sign off as ${profile.display_name}.`)
  }

  // The usage check, opted in to the ChatGPT free tier: a free user's draft
  // runs on their own plan (runUtilityTask's chatgptPlan).
  const chatgptPlan = await usageOnPlan(user.id)

  const startTime = Date.now()

  // One task session on the eve utility agent (kind 'draft_followup'), on the
  // drafting surface's fixed model (SURFACE_MODELS). The meeting
  // context above rides as the message; the tone-templated writing brief is
  // the kind's system prompt, rebuilt by the utility spec route.
  const result = await runUtilityTask({
    kind: 'draft_followup',
    supabase,
    workspaceId,
    userId: user.id,
    chatgptPlan,
    params: { tone: String(tone) },
    message: promptParts.filter(Boolean).join('\n'),
  })

  // eve's cost is 0/absent → null → omitted: log_ai_usage prices the row
  // from ai_model_costs.
  await logUsage(user.id, {
    provider: usageProviderLabel(result.model),
    model: result.model,
    feature: 'draft_followup_email',
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    durationMs: Date.now() - startTime,
    costUsd: result.usage.costUsd ?? undefined,
    metadata: { captureId, ...usageCacheMetadata(result.usage) },
  })

  const emailBody = result.text
  const subject = `Follow-up: ${capture.title}`

  // 7. Try to create draft in email provider
  let draftId: string | null = null
  let emailProvider: string | null = null

  if (toRecipients.length) {
    try {
      const googleToken = await getValidToken(user.id, 'google', 'email')
      const microsoftToken = await getValidToken(user.id, 'microsoft', 'email')

      if (googleToken || microsoftToken) {
        const draft = await createEmailDraft(user.id, {
          to: toRecipients,
          subject,
          body: emailBody,
        })
        draftId = draft.id
        emailProvider = googleToken ? 'google' : 'microsoft'
      }
    } catch (err) {
      console.error('Failed to create email draft:', err)
      // Non-blocking — user can still copy the email
    }
  }

  return NextResponse.json({
    draft_id: draftId,
    subject,
    to: toRecipients,
    body: emailBody,
    provider: emailProvider,
  })
}
