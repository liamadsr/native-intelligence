'use client'

/**
 * Landing demo of a shared context package feeding the live agent on a call:
 * the package as it opens in the chat's Knowledge card (DemoCard: the
 * Knowledge header, the package as the active filter, shared with the sales
 * team, one row per piece), and floating over it the live agent's heads-up as
 * the HUD draws it (LiveChatRowView, components/live-chat/live-chat.tsx, on
 * the HUD's glass), each tip lighting the row it was drawn from. Content is
 * FICTIONAL.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Package, Search, Users } from 'lucide-react'
import { LiveChatRowView } from '@/components/live-chat/live-chat'
import { BotFaceChip } from '@/components/bots/bot-face-chip'
import { GlassBackdrop } from '@/components/agent-ui/glass-backdrop'
import { cn } from '@/lib/utils'
import { DemoCard, DemoSky } from './demo-card'

const ITEMS = [
  { title: 'Product overview', meta: 'What Atlas Pro is, who it’s for', kind: 'doc' },
  { title: 'Pricing & discounts', meta: 'List prices, floors, approval rules', kind: 'pricing' },
  { title: 'Competitor battlecard', meta: 'BridgeCRM, Northtrail', kind: 'battlecard' },
  { title: 'Objection plays', meta: 'Price, security, timing', kind: 'playbook' },
  { title: 'Demo script', meta: '15-minute walkthrough', kind: 'script' },
  { title: 'Deal history', meta: 'What we promised, what worked, what stalled', kind: 'history' },
]

// Each tip names the piece of the package it came from (an index into ITEMS).
const TIPS: { text: string; item: number; nudge: 'insight' | 'suggestion' | 'reminder' }[] = [
  { text: 'BridgeCRM came up. Lead with the migration story: Atlas imports their data in a day.', item: 2, nudge: 'insight' },
  { text: 'The discount floor is 15%. Anything deeper needs approval, so lead with ROI first.', item: 1, nudge: 'suggestion' },
  { text: 'Security question: the SOC 2 Type II answer is in the overview. Share it now.', item: 0, nudge: 'reminder' },
  { text: 'Close with the ROI walkthrough from the demo script’s last section.', item: 4, nudge: 'suggestion' },
]

const TIP_MS = 4200
const AGENT = 'Sales Agent'

export function ContextPackageDemo() {
  const [tip, setTip] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTip((i) => (i + 1) % TIPS.length), TIP_MS)
    return () => clearInterval(t)
  }, [])
  const avatar = useMemo(() => <BotFaceChip face={null} name={AGENT} size={12} />, [])
  const current = TIPS[tip]

  return (
    <DemoSky className="p-3 sm:p-4">
      <div className="relative [zoom:0.8]">
        <DemoCard title="Knowledge" className="h-[560px]">
          <div className="flex h-11 shrink-0 items-center gap-2 px-4">
            <span className="text-sm text-muted-foreground">Knowledge</span>
            <span className="inline-flex items-center gap-1 text-sm font-medium">
              <Package className="h-3.5 w-3.5" />
              Library
              <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </span>
            <Search className="ml-auto h-4 w-4 text-muted-foreground" />
          </div>
          <div className="flex h-9 shrink-0 items-center gap-1.5 px-3">
            <span className="inline-flex items-center rounded-full border border-foreground bg-foreground px-3 py-1 text-xs font-medium text-background">
              Atlas Pro · Sales Pack
            </span>
            <span className="inline-flex items-center rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground">All knowledge</span>
            <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users className="h-3.5 w-3.5" />
              Shared with Sales
            </span>
          </div>
          <div className="min-h-0 flex-1 px-3 pt-1">
            {ITEMS.map((item, i) => (
              <div
                key={item.title}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 transition-colors duration-500',
                  i === current.item ? 'bg-primary/[0.07] ring-1 ring-primary/25' : '',
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.title}</p>
                  <p className="truncate text-xs text-muted-foreground">{item.meta}</p>
                </div>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{item.kind}</span>
              </div>
            ))}
          </div>
        </DemoCard>

        {/* The live agent's heads-up, on the HUD's glass, drawn from the lit row. */}
        <div className="absolute -bottom-2 right-2 isolate w-[330px] max-w-[calc(100%-1rem)] p-2.5 sm:-right-2">
          <GlassBackdrop />
          <div key={tip} className="animate-in fade-in slide-in-from-bottom-1 duration-300">
            <LiveChatRowView row={{ kind: 'say', id: `tip-${tip}`, text: current.text, nudgeKind: current.nudge }} name={AGENT} avatar={avatar} thinking={false} />
          </div>
          <p className="px-1.5 pt-1.5 text-[11px] text-[hsl(0_0%_36%)] dark:text-[hsl(0_0%_72%)]">
            From the package: {ITEMS[current.item].title}
          </p>
        </div>
      </div>
    </DemoSky>
  )
}
