'use client'

/**
 * A panel's two-way switch (Home's Recent | Inbox: home-side.ts): a radio
 * group (one tab stop, the arrow keys move), the chosen side raised, as Team
 * chat's All | Recent (team-chat-panel.tsx ModeSwitch) and the app's other
 * switches. Its corners follow the panel card's 24px: 15px from 9px inside
 * its edge, its options 13px, 2px inside.
 */
import { useRef, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'

export interface PanelSwitchOption<T extends string> {
  id: T
  label: string
  /** Something waits on that side (Inbox's unread): a small dot after its label. */
  dot?: boolean
  /** The dot's colour: the theme's own, or orange (a coding chat needs the person: home-recents.tsx). */
  dotTone?: 'orange'
  /** What the dot says to a screen reader (default: "something new"). */
  dotWords?: string
}

export function PanelSwitch<T extends string>({
  options,
  value,
  onChange,
  label,
  data,
}: {
  options: readonly PanelSwitchOption<T>[]
  value: T
  onChange: (next: T) => void
  label: string
  /** The group's data attribute name (tests and styles find it by it). */
  data: string
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    e.stopPropagation()
    const at = (options.findIndex((o) => o.id === value) + step + options.length) % options.length
    onChange(options[at].id)
    refs.current[at]?.focus()
  }
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} {...{ [data]: value }} className="flex min-w-0 flex-1 items-center gap-0.5 rounded-[15px] bg-muted p-0.5">
      {options.map((o, i) => {
        const checked = value === o.id
        return (
          <button
            key={o.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            {...{ [`${data}-option`]: o.id }}
            onClick={() => !checked && onChange(o.id)}
            className={cn(
              'inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[13px] text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
              checked ? 'bg-background font-medium text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
            {o.dot && (
              <span data-panel-switch-dot={o.dotTone ?? ''} className={cn('size-1.5 shrink-0 rounded-full', o.dotTone === 'orange' ? 'bg-orange-500' : 'bg-primary')}>
                <span className="sr-only">, {o.dotWords ?? 'something new'}</span>
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
