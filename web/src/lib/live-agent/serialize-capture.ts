/**
 * Serializes the current capture state into a compact string for the live agent prompt.
 * This replaces the message-history approach — instead of re-reading the full conversation,
 * each agent call receives a snapshot of what has been extracted so far.
 *
 * Target: under 1,500 tokens even for long meetings.
 */

export interface CaptureStateForPrompt {
  title: string | null
  ai_summary: string | null
  project_id: string | null
  project_name?: string | null
  participants: Array<{ name?: string; email?: string }> | null
}

export interface PendingProposal {
  id: string
  change_type: string
  entity_type: string
  entity_id: string | null
  display_text: string
  title: string | null
  description: string | null
  reasoning: string | null
  assignee_name: string | null
  project_id: string | null
  status_to: string | null
}

export interface Correction {
  field: string
  agentProposed: string
  userCorrected: string
}

/** A proposal that has already been auto-accepted (status='applied'). The agent
 *  can still edit_proposal / dismiss_proposal these — the change reaches through
 *  to the real entity. */
export interface AppliedProposal {
  id: string
  change_type: string
  entity_type: string
  display_text: string
  assignee_name: string | null
  status_to: string | null
}

export function serializeCaptureForPrompt(
  capture: CaptureStateForPrompt,
  pendingProposals: PendingProposal[],
  correctionsLog: Correction[],
  appliedProposals: AppliedProposal[] = [],
): string {
  const parts: string[] = []

  // ── Capture metadata ──
  parts.push('## Current Capture State')
  parts.push(`Title: ${capture.title || 'Untitled'}`)

  // ── Enhanced notes (what the agent has written so far) ──
  if (capture.ai_summary) {
    parts.push('')
    parts.push('## Enhanced Notes (what you have written so far)')
    parts.push(capture.ai_summary)
  }

  // ── Grounding state ──
  parts.push('')
  parts.push('## Grounding State')
  if (capture.project_id) {
    const label = capture.project_name || capture.project_id
    parts.push(`Project: [CONFIRMED] ${label} (ID: ${capture.project_id})`)
  } else {
    parts.push('Project: [UNRESOLVED] — infer from transcript if confident, else flag for user')
  }

  // ── Pending proposed changes ──
  if (pendingProposals.length > 0) {
    parts.push('')
    parts.push('## Pending Proposed Changes')
    for (const p of pendingProposals) {
      const meta = [
        p.change_type,
        p.entity_type,
        p.entity_id ? `entity:${p.entity_id}` : null,
        p.assignee_name ? `assignee:${p.assignee_name}` : null,
        p.status_to ? `→ ${p.status_to}` : null,
      ]
        .filter(Boolean)
        .join(' | ')
      parts.push(`- [${p.id}] ${p.display_text} (${meta})`)
      // Include richer context so the agent can decide whether to enrich or consolidate
      if (p.description) parts.push(`  Context: ${p.description}`)
      if (p.reasoning) parts.push(`  Reasoning: ${p.reasoning}`)
    }
  }

  // ── Already-applied (auto-accepted) items ──
  // The agent must know these exist so it can refine or retract them as the
  // conversation evolves. edit_proposal / dismiss_proposal on these reach
  // through to the real entity — no re-confirmation needed.
  if (appliedProposals.length > 0) {
    parts.push('')
    parts.push('## Already Applied (auto-accepted — you can STILL edit or dismiss these)')
    parts.push(
      'These were auto-accepted at high confidence and are now live. If the conversation refines one (new deadline, different owner, changed scope) call edit_proposal with its id — the change updates the real item in place. If it became obsolete, call dismiss_proposal to delete it.',
    )
    for (const p of appliedProposals) {
      const meta = [
        p.change_type,
        p.entity_type,
        p.assignee_name ? `assignee:${p.assignee_name}` : null,
        p.status_to ? `→ ${p.status_to}` : null,
      ]
        .filter(Boolean)
        .join(' | ')
      parts.push(`- [${p.id}] ${p.display_text} (${meta})`)
    }
  }

  // ── Corrections log ──
  if (correctionsLog.length > 0) {
    parts.push('')
    parts.push('## Corrections Log (your errors this session — do not repeat)')
    for (const c of correctionsLog) {
      parts.push(`- ${c.field}: you proposed "${c.agentProposed}" → user corrected to "${c.userCorrected}"`)
    }
  }

  return parts.join('\n')
}
