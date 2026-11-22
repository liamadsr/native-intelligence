/**
 * The small round icon a For you card's sentence starts with: the agent mark,
 * or the kind of thing it's about (column-card-copy.ts CompactIcon). The
 * column's compact card and the chat's reply card (chat/card-reply-chip.tsx)
 * both draw it, so the card in the chat reads as the card it came from.
 */
import { GitPullRequest, Layers, Link2, ListChecks, Workflow, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ENTITY_COLOR_TEXT, ENTITY_IDENTITIES, type EntityIdentityKind } from '@/lib/entities/entity-identity'
import type { CardReplyIcon } from '@/lib/chat/card-reply'

/** The icons that are a kind of record: drawn as that kind's identity (its glyph, its colour). */
const SENTENCE_ICON_KINDS: Partial<Record<CardReplyIcon, EntityIdentityKind>> = {
  mail: 'email_thread',
  document: 'document',
  action: 'action',
  capture: 'capture',
  contact: 'contact',
  company: 'company',
  bot: 'agent',
}

/** The icons that are no record's kind. */
const OTHER_GLYPHS: Partial<Record<CardReplyIcon, LucideIcon>> = {
  pr: GitPullRequest,
  link: Link2,
  list: ListChecks,
  cards: Layers,
  run: Workflow,
}

const glyphOf = (icon: CardReplyIcon): LucideIcon => {
  const kind = SENTENCE_ICON_KINDS[icon]
  return kind ? ENTITY_IDENTITIES[kind].icon : (OTHER_GLYPHS[icon] ?? Link2)
}

/** Each icon's glyph: the kind's own (entity-identity.ts), or the icon's. A plain lookup, so a caller draws it as a static component. */
export const SENTENCE_ICON_GLYPHS: Record<CardReplyIcon, LucideIcon> = {
  mail: glyphOf('mail'),
  document: glyphOf('document'),
  pr: glyphOf('pr'),
  link: glyphOf('link'),
  action: glyphOf('action'),
  capture: glyphOf('capture'),
  contact: glyphOf('contact'),
  company: glyphOf('company'),
  list: glyphOf('list'),
  cards: glyphOf('cards'),
  run: glyphOf('run'),
  bot: glyphOf('bot'),
}

/** A kind's ink for its icon ('' for an icon that is no kind's: the ink around it). */
export function sentenceIconInk(icon: CardReplyIcon | null | undefined): string {
  const kind = icon ? SENTENCE_ICON_KINDS[icon] : undefined
  return kind ? ENTITY_COLOR_TEXT[ENTITY_IDENTITIES[kind].color] : ''
}

/** `sm`: the column's line (20px); `md`: the reply card's, at the chat's text size (24px). */
export function SentenceIcon({ icon, size = 'sm' }: { icon: CardReplyIcon | null | undefined; size?: 'sm' | 'md' }) {
  if (!icon) return null
  const Icon = SENTENCE_ICON_GLYPHS[icon]
  return (
    <span
      aria-hidden
      data-sentence-icon={icon}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] align-middle text-foreground/70',
        sentenceIconInk(icon),
        size === 'sm' ? 'mr-1.5 h-5 w-5' : 'h-6 w-6',
      )}
    >
      <Icon className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
    </span>
  )
}
