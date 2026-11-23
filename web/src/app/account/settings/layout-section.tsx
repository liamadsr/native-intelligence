'use client'

/**
 * Preferences › Layout (docs/plans/traditional-layout.md): today's layout,
 * the default, or Traditional, each with a small drawing of its shell. Kept
 * on the account (lib/layout-mode-store.ts), so it follows the person to
 * every device; a phone shows today's layout in both.
 */
import { LayoutPanelLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LayoutMode } from '@/lib/layout-mode'
import { saveLayoutMode, useLayoutMode } from '@/lib/layout-mode-store'
import { toast } from 'sonner'

const OPTIONS: ReadonlyArray<{ id: LayoutMode; label: string; description: string }> = [
  { id: 'default', label: 'Default', description: 'The chat in the middle, pages as cards over it' },
  { id: 'traditional', label: 'Traditional', description: 'Page icons, a sidebar, and pages that fill one frame' },
]

/** Today's shell in small: the rail's icons, a floating panel and a card over the backdrop. */
function DefaultPreview() {
  return (
    <div aria-hidden className="relative flex h-full w-full gap-1 overflow-hidden rounded-md bg-gradient-to-br from-sky-200 to-indigo-200 p-1 dark:from-sky-900 dark:to-indigo-950">
      <div className="flex w-2.5 flex-col items-center gap-[3px] rounded-full bg-background/70 py-1">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="size-1 rounded-full bg-foreground/40" />
        ))}
      </div>
      <div className="w-6 rounded-md bg-background/70" />
      <div className="flex flex-1 flex-col justify-end">
        <div className="mx-auto mb-0.5 h-2 w-4/5 rounded-full bg-background/80" />
      </div>
      <div className="absolute inset-y-2 left-12 right-2 rounded-md bg-background/85 shadow-sm" />
    </div>
  )
}

/** Traditional in small: a sidebar of labelled rows, a slim top bar, a flat page. */
function TraditionalPreview() {
  return (
    <div aria-hidden className="flex h-full w-full overflow-hidden rounded-md border border-border bg-background">
      <div className="flex w-8 flex-col gap-[3px] border-r border-border bg-sidebar p-1">
        <div className="mb-0.5 h-1.5 w-5 rounded-sm bg-foreground/30" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className={cn('h-1 rounded-sm', i === 1 ? 'w-6 bg-foreground/40' : 'w-5 bg-foreground/15')} />
        ))}
      </div>
      <div className="flex flex-1 flex-col">
        <div className="h-3 border-b border-border" />
        <div className="flex flex-1 flex-col gap-[3px] p-1">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-1 w-full rounded-sm bg-foreground/10" />
          ))}
        </div>
      </div>
    </div>
  )
}

export function LayoutSection() {
  const layout = useLayoutMode()
  const choose = (mode: LayoutMode) => {
    if (mode === layout) return
    void saveLayoutMode(mode).then((ok) => {
      if (!ok) toast.error("Couldn't save your layout. Try again.")
    })
  }
  return (
    <div className="px-5 py-4" data-preferences-layout="">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
          <LayoutPanelLeft className="h-4.5 w-4.5 text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium">Layout</p>
          <p className="text-[13px] text-muted-foreground">How the app is arranged on a larger screen. Every page works the same in both.</p>
        </div>
      </div>
      <div role="radiogroup" aria-label="Layout" className="flex flex-wrap gap-4 rounded-lg bg-muted/40 px-4 py-3">
        {OPTIONS.map((o) => {
          const active = layout === o.id
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={active}
              data-layout-option={o.id}
              onClick={() => choose(o.id)}
              className="group flex w-44 flex-col gap-2 text-left focus-visible:outline-none"
            >
              <div
                className={cn(
                  'h-[88px] w-full rounded-xl border-2 p-1 transition-colors group-focus-visible:ring-2 group-focus-visible:ring-ring',
                  active ? 'border-primary' : 'border-transparent group-hover:border-border',
                )}
              >
                {o.id === 'default' ? <DefaultPreview /> : <TraditionalPreview />}
              </div>
              <div className="px-0.5">
                <p className={cn('text-[13px]', active ? 'font-medium text-foreground' : 'text-foreground/80')}>{o.label}</p>
                <p className="text-[11px] leading-snug text-muted-foreground">{o.description}</p>
              </div>
            </button>
          )
        })}
      </div>
      {layout === 'traditional' && (
        <p className="mt-2 px-1 text-[11px] text-muted-foreground/80">
          Traditional draws flat, opaque panes, so the Background below shows only in the default layout.
        </p>
      )}
    </div>
  )
}
