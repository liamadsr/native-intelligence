/**
 * The small round icon a For you card's sentence starts with: the agent mark,
 * or the kind of thing it's about (column-card-copy.ts CompactIcon). The
 * column's compact card and the chat's reply card (chat/card-reply-chip.tsx)
 * both draw it, so the card in the chat reads as the card it came from.
 */
import {
  Building2,
  FileText,
  GitPullRequest,
  Layers,
  Link2,
  ListChecks,
  Mail,
  Mic,
  SquareCheck,
  User,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { AGENT_ICON } from '@/components/agents/agent-icon'
import type { CardReplyIcon } from '@/lib/chat/card-reply'

/** Each icon's glyph: the agent mark, or the kind's. A plain lookup, so a caller draws it as a static component. */
export const SENTENCE_ICON_GLYPHS: Record<CardReplyIcon, LucideIcon> = {
  mail: Mail,
  document: FileText,
  pr: GitPullRequest,
  link: Link2,
  action: SquareCheck,
  capture: Mic,
  contact: User,
  company: Building2,
  list: ListChecks,
  cards: Layers,
  run: Workflow,
  bot: AGENT_ICON,
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
        size === 'sm' ? 'mr-1.5 h-5 w-5' : 'h-6 w-6',
      )}
    >
      <Icon className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
    </span>
  )
}
