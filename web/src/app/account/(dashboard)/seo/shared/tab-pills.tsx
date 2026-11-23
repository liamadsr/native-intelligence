'use client'

/**
 * A page's sub-views as pills (the evals suite's TabPill look, as the Site
 * audit page uses it): a tablist of buttons, the active one filled, an
 * optional count that hides at zero. In a card's header (`header`), the
 * same tabs as the header's capsule of 24px segments (Liam, 11-23: "all the
 * SEO pages"), the one in force lifted.
 */
import { CARD_HEADER_CAPSULE, CARD_HEADER_SEGMENT } from '@/components/chat-cards/card-header-button'
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
  header,
}: {
  tabs: ReadonlyArray<TabPillItem<T>>
  value: T
  onChange: (tab: T) => void
  /** What the tabs are of, for assistive tech ("Tracker"). */
  label: string
  className?: string
  /** Drawn in the card's header: a capsule of segments. */
  header?: boolean
}) {
  if (header) {
    return (
      <div role="tablist" aria-label={label} data-seo-tabs="header" className={cn(CARD_HEADER_CAPSULE, className)}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === value}
            data-seo-tab={tab.id}
            onClick={() => onChange(tab.id)}
            className={CARD_HEADER_SEGMENT}
          >
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && <span className="ml-1 tabular-nums opacity-60">{tab.count.toLocaleString()}</span>}
          </button>
        ))}
      </div>
    )
  }
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

/**
 * A small filter as a radiogroup of buttons (the Files type filter's look).
 * In a card's header (`header`), a capsule of 24px segments; an option's
 * `short` words stand in for its label where the header is narrow.
 */
export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  header,
}: {
  options: ReadonlyArray<{ value: T; label: string; short?: string }>
  value: T
  onChange: (value: T) => void
  label: string
  className?: string
  header?: boolean
}) {
  if (header) {
    return (
      <div role="radiogroup" aria-label={label} data-seo-filter-group="header" className={cn(CARD_HEADER_CAPSULE, className)}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            data-seo-filter={option.value}
            title={option.short ? option.label : undefined}
            onClick={() => onChange(option.value)}
            className={CARD_HEADER_SEGMENT}
          >
            {option.short ? (
              <>
                <span className="@[56rem]:hidden">{option.short}</span>
                <span className="hidden @[56rem]:inline">{option.label}</span>
              </>
            ) : (
              option.label
            )}
          </button>
        ))}
      </div>
    )
  }
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
