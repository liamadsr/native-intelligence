'use client'

/**
 * "Refine in chat" on a bot's card (bots-v4.md Phase 3, "Everything waiting,
 * settled at the bot"): an email card's Refine, in a bot's bubble or on its
 * page, talks to THAT bot, never the main chat. It posts to the bot's own
 * chat: the run's chat when the card's run parked one (bots v3 Phase 4,
 * item-run-chat.ts `replyRun`), else the bot's own thread with the card
 * attached as its "About:" (bots v3 1d, `itemAboutRef`); the agent's own card
 * (one face) goes to the person's home thread instead, handed to the chat
 * strip's home tab (openHomeThread), the card riding the turn as its id. On the Agents page
 * (no bot) it still posts to the main chat (attention-card.tsx).
 *
 * What it says is a template, as the main chat's is (chat-panel.tsx
 * handleChatAboutProposal), worded for a teammate: it may draft in the chat
 * (a bot's own chat can't write a Mail draft unless its owner widened it).
 */
import type { AreaKey } from '@/lib/packs/registry'
import type { AttentionItem } from '@/hooks/use-attention-items'
import { sendToTeammate } from '@/hooks/use-teammate-chat'
import { runChatRefusalOf, sendToRunChat } from '@/hooks/use-run-chat'
import { homeHandoffAbout, type TeammateAboutRef } from '@/lib/chat/teammate-about-ref'
import { toast } from 'sonner'
import { handOffToHome } from '@/lib/chat/home-thread-client'
import type { BubbleItem } from './bubble-items'
import { aboutTitle, itemAboutRef, replyRun } from './item-run-chat'

/** Where a refine goes, and what the chat's "About:" line names. */
export interface RefineTarget {
  /** The run whose chat continues the card (a loop run that parked its session); null: the bot's own thread. */
  runId: string | null
  /** The card, attached to what goes to the bot's own thread. */
  context: TeammateAboutRef | null
  /** The card's title, as the "About:" line shows it. */
  title: string
  /** The card's workspace. */
  workspaceId: string | null
}

/** The message a card's Refine sends its bot. */
export function refineText(card: Pick<AttentionItem, 'title' | 'payload'>): string {
  const p = card.payload ?? {}
  const text = (typeof p.display_text === 'string' && p.display_text.trim()) || card.title
  const recipient = (typeof p.email_to_name === 'string' && p.email_to_name) || (typeof p.email_to_address === 'string' && p.email_to_address) || null
  const lines = [`Let’s work on this email${recipient ? ` to ${recipient}` : ''}: “${text}”`]
  if (typeof p.email_to_address === 'string' && p.email_to_address) lines.push(`Recipient address: ${p.email_to_address}`)
  if (typeof p.email_subject === 'string' && p.email_subject) lines.push(`Suggested subject: ${p.email_subject}`)
  if (typeof p.email_context === 'string' && p.email_context) lines.push(`What it should cover: ${p.email_context}`)
  else if (typeof p.description === 'string' && p.description) lines.push(`Context: ${p.description}`)
  lines.push('Draft it here first, so we can refine it together.')
  return lines.join('\n')
}

/**
 * Where `card` (one of `item`'s: the card itself, or one of a run's cards) is
 * refined: its run's chat when the run parked one, else the bot's own thread
 * with the card attached.
 */
export function refineTarget(item: BubbleItem | null, card: AttentionItem): RefineTarget {
  const own: BubbleItem = item ?? { kind: 'card', id: card.id, card }
  const run = replyRun(own)
  const context = itemAboutRef(own.kind === 'batch' ? { kind: 'card', id: card.id, card } : own)
  return {
    runId: run && !run.asking ? run.runId : null,
    context,
    title: aboutTitle(card.title || 'this card'),
    workspaceId: card.workspace_id ?? null,
  }
}

/**
 * Posts the refine: to the run's chat (falling back to the bot's own thread,
 * with the card, when the route refuses the run), else to the thread. Resolves
 * whether it went out.
 */
export async function sendRefine(
  teammate: { id: string; workspaceId: string | null; focusArea?: AreaKey | null; home?: boolean },
  target: RefineTarget,
  text: string,
): Promise<boolean> {
  if (target.runId) {
    if (await sendToRunChat(target.runId, text)) return true
    if (!runChatRefusalOf(target.runId)) return false
  }
  // The agent's face talks in the home thread (one face, always-on-agent §2c),
  // which only the chat strip's home tab runs: hand it the text there, with
  // the card riding the turn (cardIds → systemContext.aboutCardIds).
  if (teammate.home) {
    const result = await handOffToHome({ ...homeHandoffAbout(text, target.context), workspaceId: target.workspaceId ?? teammate.workspaceId })
    // It went only once the strip took it; else say why (nothing was sent).
    if (!result.ok) toast.error(result.reason)
    return result.ok
  }
  // An area face's page chatted in its focused main-agent conversation (one-agent S3).
  return sendToTeammate(teammate.id, teammate.workspaceId, text, {
    ...(target.context ? { about: target.context } : {}),
    ...(teammate.focusArea ? { focusArea: teammate.focusArea } : {}),
  })
}
