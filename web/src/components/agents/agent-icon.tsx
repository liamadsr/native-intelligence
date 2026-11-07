/**
 * The one mark for an agent (Liam, 2026-10-17: no faces, no initials):
 * lucide's Boxes, the icon the agent picker always wore, in a neutral muted
 * colour. Every place that shows an agent uses it, sized to fit
 * (`className`); a place that takes an icon component (a menu row, an icon
 * map) uses AGENT_ICON. The live HUD keeps its own chip (bots/bot-face-chip),
 * and the agent itself has one face where it stands as itself, the side
 * panel's computer card and the voice bird (bots/agent-bot.tsx, 10-23).
 * Decorative: it always stands beside the agent's name.
 */
import { Boxes } from 'lucide-react'
import { cn } from '@/lib/utils'

export const AGENT_ICON = Boxes

export function AgentIcon({ className }: { className?: string }) {
  return <Boxes aria-hidden data-agent-icon="" className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', className)} />
}
