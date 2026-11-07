'use client'

/**
 * The HUD's Briefing line (live sidekick plan, Phase 4): the person's
 * pre-call brief (lib/live-agent/hud-brief.ts) as one collapsible glass line,
 * the live chat's ProposalsLine pattern.
 *   - collapsed (the default): "Briefing" and the goal, else the prep's first
 *     line, on one truncated line;
 *   - expanded: the goal and the prep's top section as plain text (line
 *     breaks kept, nothing rendered as HTML or markdown), scrolling inside a
 *     capped height so the fixed window keeps its chat.
 * No brief, nothing: the host renders it only with one. No timers.
 */
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BOT_GLASS, BOT_GLASS_MUTED } from '@/components/agent-ui/glass'
import { hudBriefLead, plainBriefText, type HudBrief } from '@/lib/live-agent/hud-brief'

export function HudBriefingLine({ brief }: { brief: HudBrief | null }) {
  const [open, setOpen] = useState(false)
  if (!brief || (!brief.goal && !brief.prepTop)) return null
  const lead = hudBriefLead(brief)
  return (
    <div className={cn(BOT_GLASS, 'shrink-0 overflow-hidden rounded-[18px]')} data-hud-briefing="">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
      >
        <span className="shrink-0 font-medium text-foreground">Briefing</span>
        {lead && (
          <span className={cn('min-w-0 flex-1 truncate', BOT_GLASS_MUTED)} data-hud-briefing-lead="">
            {lead}
          </span>
        )}
        <ChevronDown className={cn('ml-auto h-3.5 w-3.5 shrink-0 transition-transform', BOT_GLASS_MUTED, open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div
          data-hud-briefing-body=""
          className="max-h-40 overflow-y-auto overscroll-contain px-3 pb-2 text-[12px] leading-[18px] text-foreground [scrollbar-width:none]"
        >
          {brief.goal && (
            <section data-hud-briefing-goal="">
              <span className={cn('block text-[10px] font-semibold uppercase tracking-[0.06em]', BOT_GLASS_MUTED)}>Your goal</span>
              <p className="whitespace-pre-line break-words">{brief.goal}</p>
            </section>
          )}
          {brief.prepTop && (
            <section data-hud-briefing-prep="" className={cn(brief.goal && 'mt-2')}>
              <span className={cn('block text-[10px] font-semibold uppercase tracking-[0.06em]', BOT_GLASS_MUTED)}>
                {brief.prepTitle || 'Prep'}
              </span>
              <p className="whitespace-pre-line break-words">{plainBriefText(brief.prepTop)}</p>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
