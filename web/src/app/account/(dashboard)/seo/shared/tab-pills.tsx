'use client'

/**
 * A page's sub-views as pills, and a small filter in the same look: the
 * pill every page's tabs wear (components/views/page-tabs.tsx: a list's saved
 * views, a project's sections), so the SEO pages read as the rest of the app
 * (Liam, 11-23: "can you make sure it's updated everywhere? and everything
 * looks the same as the projects page"). Never in a card's header: a page's
 * sections are its first row (DETAIL_TAB_ROW), in the card's corner.
 *
 * On a narrow page the pills scroll sideways instead of wrapping, as a
 * detail page's sections do. The wrapper takes the caller's placement
 * (margins, flex), so the pills' own room for the focus ring moves nothing.
 */
import { PAGE_TAB_COUNT, pageTabClass } from '@/components/views/page-tabs'
import { cn } from '@/lib/utils'

/** The scrolling line of pills, with room above and below for the focus ring. */
const PILL_ROW = '-my-1 flex min-w-0 items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'

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
    <div className={cn('min-w-0', className)}>
      <div role="tablist" aria-label={label} className={PILL_ROW}>
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
              className={pageTabClass(active)}
            >
              {tab.label}
              {tab.count !== undefined && tab.count > 0 && <span className={PAGE_TAB_COUNT}>{tab.count.toLocaleString()}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * A small filter as a radiogroup of the same pills. An option's `short`
 * words stand in for its label where the nearest size container is under
 * 46rem (Search performance's period at the end of its first row).
 */
export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: ReadonlyArray<{ value: T; label: string; short?: string }>
  value: T
  onChange: (value: T) => void
  label: string
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div role="radiogroup" aria-label={label} className={PILL_ROW}>
        {options.map((option) => {
          const checked = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={checked}
              data-seo-filter={option.value}
              title={option.short ? option.label : undefined}
              onClick={() => onChange(option.value)}
              className={pageTabClass(checked)}
            >
              {option.short ? (
                <>
                  <span className="@[46rem]:hidden">{option.short}</span>
                  <span className="hidden @[46rem]:inline">{option.label}</span>
                </>
              ) : (
                option.label
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
