'use client'

/**
 * The app's surfaces for the landing demos, at a window's scale:
 *   - DemoSky: the app's sky behind the chat, contained in a rounded panel
 *     (a lightly washed daytime gradient in each theme; the page's own sky,
 *     components/sky/marketing-sky.tsx, is fixed to the viewport);
 *   - DemoCard: a chat card's window (components/chat-cards/card-glass.tsx:
 *     its frame and glass) with the card header ShowToolCard draws: Back and
 *     Forward, the kind's icon, the title.
 * Demos are pictures of the product: they take no input (`inert`).
 */
import type { CSSProperties, ReactNode } from 'react'
import { ChevronLeft, ChevronRight, LayoutList, type LucideIcon } from 'lucide-react'
import { CARD_GLASS_FRAME, CardGlass } from '@/components/chat-cards/card-glass'
import { marketingGradients, NEUTRAL_DAY_SOURCE } from '@/lib/sky/marketing-sky'
import { cn } from '@/lib/utils'

const SKY = marketingGradients(NEUTRAL_DAY_SOURCE, new Date(Date.UTC(2026, 5, 21, 14, 30)), [0.12, 0.2])
const SKY_VARS = { '--demo-sky-light': SKY.light, '--demo-sky-dark': SKY.dark } as CSSProperties

export function DemoSky({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      aria-hidden
      inert
      style={SKY_VARS}
      className={cn(
        'pointer-events-none relative isolate w-full select-none overflow-hidden rounded-[28px] bg-[image:var(--demo-sky-light)] shadow-xl ring-1 ring-black/5 dark:bg-[image:var(--demo-sky-dark)] dark:ring-white/10',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function DemoCard({
  title,
  icon: Icon = LayoutList,
  headerRight,
  children,
  className,
}: {
  title: string
  icon?: LucideIcon
  headerRight?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('relative flex w-full flex-col overflow-hidden', CARD_GLASS_FRAME, className)}>
      <CardGlass />
      <div className="relative z-10 flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <div className="-ml-1.5 flex shrink-0 items-center gap-0.5">
          {[ChevronLeft, ChevronRight].map((Chevron, i) => (
            <span key={i} className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 opacity-30">
              <Chevron className="size-4" />
            </span>
          ))}
        </div>
        <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <span className="min-w-0 truncate text-[13px] font-medium">{title}</span>
        {headerRight && <div className="ml-auto flex shrink-0 items-center gap-1">{headerRight}</div>}
      </div>
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  )
}

/** A record's tab row (the contact's Overview / Details / …), the active one filled. */
export function DemoTabs({ tabs, active }: { tabs: { label: string; count?: number }[]; active: string }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 overflow-hidden px-3">
      {tabs.map((t) => (
        <span
          key={t.label}
          className={cn(
            'inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-colors',
            t.label === active ? 'border-foreground bg-foreground font-medium text-background' : 'border-border bg-background text-muted-foreground',
          )}
        >
          {t.label}
          {t.count != null && <span className="ml-1.5 text-[10px] opacity-70">{t.count}</span>}
        </span>
      ))}
    </div>
  )
}
