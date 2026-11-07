'use client'

/**
 * The live HUD's agent chip, beside the live agent's replies: its name's
 * initial in a small round chip. The HUD's own look, kept as it was when the
 * faces went (it never drew a face: it passes `face={null}`). Everywhere else
 * an agent shows as AgentIcon (components/agents/agent-icon.tsx).
 * Decorative: it always stands beside the name.
 */
import { cn } from '@/lib/utils'

export function BotFaceChip({
  name,
  size = 14,
  className,
}: {
  /** Always null: the HUD draws no face. */
  face: null
  name: string
  /** The letter's box, px; the chip is a little wider. */
  size?: number
  className?: string
}) {
  const box = size + 6
  return (
    <span
      aria-hidden
      data-bot-face-chip=""
      className={cn('flex shrink-0 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06]', className)}
      style={{ width: box, height: box }}
    >
      <span className="text-[10px] font-semibold leading-none">{(name.trim().slice(0, 1) || '?').toUpperCase()}</span>
    </span>
  )
}
