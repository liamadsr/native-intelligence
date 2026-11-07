/**
 * What an attention card's primary button says, and the plain line for what
 * accepting it does (WS-1a/1b), read off its payload. Pure and client-safe
 * (the card: attention-card.tsx).
 */
import type { AttentionItem, AttentionPayload } from '@/hooks/use-attention-items'
import { isTargetlessUpdate, isUnsupportedChange } from '@/lib/proposed-changes/derive-ui'
import { normalizeProposedChange } from '@/lib/proposed-changes/appliable-combos'
import { postCardCopy } from '@/lib/content/post-draft'

/** The verb-accurate primary-button label — never a bare "Accept" (WS-1b). Email
 *  cards are labelled by the caller (they carry a retry state). */
export function cardPrimaryLabel(item: Pick<AttentionItem, 'kind'>, p: AttentionPayload): string {
  if (item.kind === 'approval') return p.public_content === true ? 'Approve and post' : 'Approve'
  if (item.kind === 'work_proposal') return 'Start'
  if (item.kind === 'question') return postCardCopy(p)?.verb ?? 'Got it'
  if (p.assignee_ai_member_id) return 'Assign & start'
  // Drift guard: a combo with no apply-engine handler can only dead-end on accept.
  // Name the type so the disabled card explains itself (FUTURE-drift backstop).
  if (isUnsupportedChange(p)) return `Unsupported: ${p.change_type} ${p.entity_type}`
  // W-4b: a target-less update names no action — it can't apply in one click.
  // Label names the missing step; the button opens an action picker (W-4c).
  if (isTargetlessUpdate(p)) return 'Choose target'
  // Label what accepting will ACTUALLY do: a target-less assign (any entity)
  // applies as create:action, a target-less decision update as create:decision.
  const eff = normalizeProposedChange(p)
  if (eff.change_type === 'update') return 'Apply update'
  if (eff.change_type === 'create') {
    return eff.entity_type === 'action' ? 'Create action' : `Create ${eff.entity_type || 'item'}`
  }
  // The rest name their verb too (never a bare "Apply" over what it does).
  if (eff.change_type === 'delete') return `Delete ${eff.entity_type || 'item'}`
  if (eff.change_type === 'assign') return 'Assign'
  if (eff.change_type === 'mcp_call') return 'Run tool'
  if (eff.change_type === 'send_email') return 'Send email'
  return 'Apply'
}

/** The plain-language effect of accepting, derived from the payload (WS-1a). */
export function cardEffectLine(item: Pick<AttentionItem, 'kind' | 'title'>, p: AttentionPayload): string {
  if (item.kind === 'approval') {
    const tool = typeof (p as { tool?: unknown }).tool === 'string' ? (p as { tool: string }).tool : 'the tool'
    return p.public_content === true
      ? `Posts publicly: runs ${truncate(tool, 60)} once, with exactly the inputs shown`
      : `Runs ${truncate(tool, 60)} once, with exactly the inputs shown`
  }
  if (item.kind === 'work_proposal') {
    const task = (p.task ?? item.title).trim()
    return `Runs an agent: ${truncate(task, 80)}`
  }
  if (item.kind === 'draft_email') {
    return `Drafts email to ${p.email_to_name ?? p.email_to_address ?? 'the recipient'}`
  }
  if (item.kind === 'question') {
    if (postCardCopy(p)) return 'Opens X with the post filled in; you post it there'
    return 'No board change — acknowledge'
  }
  // Same normalization the apply engine performs — describe the real effect,
  // naming the verb and what it acts on (the overlay says this beside its
  // Accept, bots-v4.md Phase 3, so it must say what happens, never just a title).
  const eff = normalizeProposedChange(p)
  const what = p.title ?? item.title
  if (eff.change_type === 'create') {
    return `Creates ${eff.entity_type || 'action'}: ${what}`
  }
  // W-4b: a target-less update needs a target before it can apply — say so.
  if (isTargetlessUpdate(p)) return 'Pick which action to update'
  if (eff.change_type === 'update') return `Updates ${eff.entity_type || 'item'}: ${what}`
  if (eff.change_type === 'delete') return `Deletes ${eff.entity_type || 'item'}: ${what}`
  if (eff.change_type === 'assign') return `Assigns ${eff.entity_type || 'item'}: ${what}`
  if (eff.change_type === 'mcp_call' || eff.entity_type === 'external') return `Runs an outside tool: ${what}`
  if (eff.change_type === 'send_email') return `Sends an email: ${what}`
  return what
}

/** Trim a string to at most `n` chars with an ellipsis (the effect line + task). */
export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
