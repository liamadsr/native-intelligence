'use client'

/**
 * A page's sub-views as pills (the evals suite's TabPill look, as the Site
 * audit page uses it): a tablist of buttons, the active one filled, an
 * optional count that hides at zero.
 */
import { cn } from '@/lib/utils'

export interface TabPillItem<T extends string> {
  id: T
  label: string
  count?: number
}

export function TabPills<T extends string>({
  tabs,
  value,
  onChange,
  label,
  className,
}: {
  tabs: ReadonlyArray<TabPillItem<T>>
  value: T
  onChange: (tab: T) => void
  /** What the tabs are of, for assistive tech ("Tracker"). */
  label: string
  className?: string
}) {
  return (
    <div role="tablist" aria-label={label} className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {tabs.map((tab) => {
        const active = tab.id === value
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-seo-tab={tab.id}
            onClick={() => onChange(tab.id)}
            className={cn(
              'inline-flex shrink-0 items-center rounded-full border px-3 py-1 text-xs whitespace-nowrap transition-colors',
              active ? 'border-foreground bg-foreground font-medium text-background' : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && <span className="ml-1.5 text-[10px] tabular-nums opacity-70">{tab.count.toLocaleString()}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** A small filter as a radiogroup of buttons (the Files type filter's look). */
export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  label: string
  className?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('flex flex-wrap items-center gap-1', className)}>
      {options.map((option) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            data-seo-filter={option.value}
            onClick={() => onChange(option.value)}
            className={cn('h-7 rounded-lg px-2.5 text-xs transition-colors', checked ? 'bg-foreground/[0.08] text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground')}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
