/**
 * What a For you column card says (column-compact-card.tsx; Liam, 10-16:
 * "more like Hard where you just see the action button and hide away all
 * the details"): its verb (the pill, the card's primary action), the one
 * sentence that carries on from it, and the details its focus view shows
 * under a divider. Templates over what the shared source already holds,
 * never a fact it doesn't: a title is quoted as written, a recipient named
 * as the card names it, and anything the template can't word falls back to
 * the card's own button label and title.
 *
 * `primary` says what the pill does: `act` performs the verb at once, `show`
 * opens the focus view first (an approval: what runs is shown before it
 * runs, A5), `full` opens the focus view on the full card (the verb needs
 * its controls: a target to pick, a question's options).
 *
 * Pure and client-safe.
 */
import type { AttentionItem } from '@/hooks/use-attention-items'
import { cardEffectLine, cardPrimaryLabel } from '@/lib/attention/card-copy'
import { normalizeProposedChange } from '@/lib/proposed-changes/appliable-combos'
import { isTargetlessUpdate, isUnsupportedChange } from '@/lib/proposed-changes/derive-ui'
import { postCardCopy } from '@/lib/content/post-draft'
import { deliverableNoun, primaryDeliverable, reviewLine } from '@/lib/work/presentation'
import type { WorkDeliverableType, WorkItem } from '@/lib/work/types'
import type { CardReplyIcon } from '@/lib/chat/card-reply'

/** The small round icon before the sentence: the app or kind of thing it's about. */
/** The sentence's round icon (sentence-icon.tsx); the chat's reply card carries the same set (card-reply.ts). */
export type CompactIcon = CardReplyIcon

export interface CompactCopy {
  verb: string
  sentence: string
  /** The focus view's paragraphs, in order (none: it says nothing more). */
  details: string[]
  primary: 'act' | 'show' | 'full'
  icon: CompactIcon | null
}

/** “Title”, as written (curly quotes; a blank one reads "untitled"). */
function quoted(text: string | null | undefined): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  return t ? `“${t}”` : 'an untitled item'
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** The paragraphs, each once, blanks dropped. */
function paragraphs(...texts: Array<string | null | undefined>): string[] {
  const out: string[] = []
  for (const t of texts) {
    const p = t?.trim()
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/** An attention card's words (`agentName`: the agent it's assigned to, when its workspace's list names it). */
export function attentionCopy(item: AttentionItem, { agentName }: { agentName?: string | null } = {}): CompactCopy {
  const p = item.payload ?? {}
  const title = quoted(item.title)
  const effect = cardEffectLine(item, p)
  const base = (verb: string, sentence: string, primary: CompactCopy['primary'] = 'act', icon: CompactIcon | null = null): CompactCopy => ({
    verb,
    sentence,
    primary,
    icon,
    details: paragraphs(item.why, str(p.description), effect),
  })

  if (item.kind === 'approval') return base(p.public_content === true ? 'Approve and post' : 'Approve', title, 'show')
  if (item.kind === 'work_proposal') {
    return { ...base('Start', title, 'act', 'bot'), details: paragraphs(item.why, str(p.task), effect) }
  }
  // A post draft (F3 post_drafts): Post opens X with it filled in; its whole
  // text, its length and what it's based on under the divider.
  const post = item.kind === 'question' ? postCardCopy(p) : null
  if (post) return { verb: post.verb, sentence: post.sentence, primary: 'act', icon: null, details: paragraphs(...post.details) }
  // An FYI to acknowledge: its words read on from "Got it" as they are.
  if (item.kind === 'question') return base('Got it', item.title.trim() || title)
  if (item.kind === 'draft_email') {
    const to = str(p.email_to_name) ?? str(p.email_to_address)
    const subject = str(p.email_subject)
    const sentence = to ? `${p.draft_id ? 'the draft' : 'an email'} to ${to}${subject ? `: ${quoted(subject)}` : ''}` : title
    return {
      ...base(p.draft_id ? 'Retry' : 'Draft', sentence, 'act', 'mail'),
      details: paragraphs(item.title, item.why, str(p.email_context) ?? str(p.description)),
    }
  }
  // Can't apply in one click: the full card (its picker, or why it can't).
  if (isUnsupportedChange(p)) return base('Review', title, 'full')
  if (isTargetlessUpdate(p)) return base('Choose', `which action to update: ${title}`, 'full', 'action')
  if (str(p.assignee_ai_member_id)) return base('Start', `${title} with ${agentName?.trim() || 'its agent'}`, 'act', 'bot')

  const eff = normalizeProposedChange(p)
  const entity = (eff.entity_type || 'item').replace(/_/g, ' ')
  switch (eff.change_type) {
    case 'create':
      return eff.entity_type === 'action' || !eff.entity_type ? base('Add', `${title} to your to-dos`, 'act', 'action') : base('Add', `the ${entity} ${title}`)
    case 'update':
      return base('Apply', `the update ${title}`)
    case 'delete':
      return base('Delete', `the ${entity} ${title}`)
    case 'assign':
      return base('Assign', title)
    case 'mcp_call':
      return base('Run', title)
    case 'send_email':
      return base('Send', title, 'act', 'mail')
    default:
      return base(cardPrimaryLabel(item, p), title)
  }
}

/** The icon for a deliverable's type. */
const DELIVERABLE_ICON: Partial<Record<WorkDeliverableType, CompactIcon>> = {
  email_draft: 'mail',
  document: 'document',
  pr: 'pr',
  url: 'link',
  action: 'action',
  capture: 'capture',
  contact: 'contact',
  company: 'company',
  prospect_list: 'list',
  attention_cards: 'cards',
  flow_run: 'run',
}

/** The round icon for a deliverable of `type` (the chat's deliverable card draws it too), or null. */
export function deliverableIcon(type: WorkDeliverableType): CompactIcon | null {
  return DELIVERABLE_ICON[type] ?? null
}

/** A review's words: its verb opens its output (#722), else the item. */
export function reviewCopy(work: WorkItem): CompactCopy {
  const output = primaryDeliverable(work)
  const details = paragraphs(work.result_summary, reviewLine(work))
  if (!output) return { verb: 'Open', sentence: quoted(work.title), details, primary: 'act', icon: null }
  const label = quoted(output.label || work.title)
  const icon = DELIVERABLE_ICON[output.type] ?? null
  const say = (verb: string, sentence: string): CompactCopy => ({ verb, sentence, details: paragraphs(work.title !== output.label ? work.title : null, ...details), primary: 'act', icon })
  switch (output.type) {
    case 'email_draft':
      return say(output.resolved_at ? 'Open' : 'Review', `the draft ${label}`)
    case 'pr':
      return say('Open', `the pull request ${label}`)
    case 'attention_cards': {
      const n = output.count ?? 1
      return say('See', `${n} ${deliverableNoun('attention_cards', n)} from ${quoted(work.title)}`)
    }
    default:
      return say('Open', label)
  }
}

/**
 * The focus view's small line: the bot's name once, then the card's own bits
 * (its kind, when, seen, its area, its workspace), each once, and none that
 * only says the bot's name again (an area label named after its bot, a kind
 * line that is the bot). Kept short: blanks go.
 */
export function focusMetaLine(botName: string, parts: ReadonlyArray<string | null | undefined>): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of [botName, ...parts]) {
    const text = part?.trim()
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out.join(' · ')
}
