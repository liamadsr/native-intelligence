'use client'

/**
 * Landing demo of the shared-intelligence loop: company knowledge feeds the
 * live agent, the agent shows up in customer conversations, those
 * conversations produce new knowledge, and that knowledge goes back into the
 * shared context. Four steps in a vertical chain with a dashed return path
 * closing the cycle; the active step cycles so the loop reads as continuous.
 * The steps wear the agents' glass on the app's sky (DemoSky), the orb on
 * the live agent's step.
 */

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { ArrowRight, Library, MessageSquare, Lightbulb } from 'lucide-react'
import { OrbLoader } from '@/components/ui/loader'
import { BOT_GLASS, BOT_GLASS_INSET, BOT_GLASS_MUTED } from '@/components/agent-ui/glass'
import { DemoSky } from './demo-card'

interface LoopStep {
  icon?: React.ComponentType<{ className?: string }>
  orb?: true
  title: string
  detail: string
}

const STEPS: LoopStep[] = [
  {
    icon: Library,
    title: 'Company knowledge',
    detail: 'Playbooks, pricing, battlecards, deal history',
  },
  {
    // The AI step wears the product's thinking orb rather than an icon.
    orb: true as const,
    title: 'Live agent',
    detail: 'Brings the right piece into the call',
  },
  {
    icon: MessageSquare,
    title: 'Customer conversations',
    detail: 'Objections, questions, what actually lands',
  },
  {
    icon: Lightbulb,
    title: 'New knowledge',
    detail: 'Captured and shared with the whole team',
  },
]

const STEP_INTERVAL_MS = 1900

export function IntelligenceLoopDemo() {
  const [active, setActive] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setActive((i) => (i + 1) % STEPS.length)
    }, STEP_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

  return (
    <DemoSky className="p-5 sm:p-7">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold tracking-tight text-foreground">Shared intelligence</h3>
        <span className={cn('text-[10px] font-medium uppercase tracking-wider', BOT_GLASS_MUTED)}>Every call feeds it</span>
      </div>

      {/* pl leaves a gutter for the dashed return path that closes the loop */}
      <div className="relative mt-5 pl-7">
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-7 left-0 top-7 w-5 rounded-l-xl border-y border-l border-dashed border-foreground/25"
        />
        <ArrowRight aria-hidden className="absolute left-[11px] top-[21px] h-3.5 w-3.5 text-foreground/50" />

        <div className="space-y-2.5">
          {STEPS.map((step, i) => {
            const isActive = i === active
            return (
              <div key={step.title}>
                {/* The agents' glass (components/agent-ui/glass.ts), the HUD's chips' highlight on the step at work. */}
                <div
                  className={cn(
                    BOT_GLASS,
                    'flex items-start gap-3 rounded-[18px] px-3 py-2.5 transition-[box-shadow,background-color] duration-500',
                    isActive && 'ring-1 ring-primary/40',
                  )}
                >
                  {step.orb ? (
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center">
                      <OrbLoader state={isActive ? 'working' : 'listening'} size="sm" />
                    </span>
                  ) : (
                    <span
                      className={cn(
                        'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors duration-500',
                        isActive ? 'bg-primary text-primary-foreground' : cn(BOT_GLASS_INSET, 'text-foreground/70'),
                      )}
                    >
                      {step.icon && <step.icon className="h-3 w-3" />}
                    </span>
                  )}
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium leading-5 text-foreground">{step.title}</p>
                    <p className={cn('text-xs', BOT_GLASS_MUTED)}>{step.detail}</p>
                  </div>
                </div>
                {i < STEPS.length - 1 && <div aria-hidden className="ml-6 h-2.5 w-px bg-foreground/25" />}
              </div>
            )
          })}
        </div>
      </div>
    </DemoSky>
  )
}
