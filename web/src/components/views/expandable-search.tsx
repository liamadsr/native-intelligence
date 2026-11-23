'use client'

import { forwardRef, useCallback, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ExpandableSearchHandle {
  focus: () => void
}

interface ExpandableSearchProps {
  value: string
  onChange: (value: string) => void
  label: string
  placeholder: string
}

/** A compact header button. The field expands to its left over adjacent
 * controls, so narrow windows can offer a useful input without moving Close.
 * In a card's header (its island, or its row in the chat), it takes its room
 * instead: the header widens and what stands left of it moves over (Liam,
 * 11-21: "when this open up it should make room in the header"). */
export const ExpandableSearch = forwardRef<ExpandableSearchHandle, ExpandableSearchProps>(function ExpandableSearch({
  value, onChange, label, placeholder,
}, ref) {
  const [open, setOpen] = useState(false)
  const [width, setWidth] = useState(256)
  const expanded = open || value.length > 0
  const rootRef = useRef<HTMLDivElement>(null)
  // In a card's header (portalled into its slot): read once it is in the page.
  const [inHeader, setInHeader] = useState(false)
  useLayoutEffect(() => {
    setInHeader(!!rootRef.current?.closest('[data-card-header]'))
  }, [])
  const buttonRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const focusRequested = useRef(false)
  const inputId = useId()

  const focus = useCallback(() => {
    focusRequested.current = true
    setOpen(true)
    if (inputRef.current) {
      inputRef.current.focus()
      focusRequested.current = false
    }
  }, [])
  useImperativeHandle(ref, () => ({ focus }), [focus])

  useLayoutEffect(() => {
    if (!expanded) return
    const root = rootRef.current
    if (!root) return
    const boundary = root.closest('[data-content-window]')
    const measure = () => {
      const available = root.getBoundingClientRect().right - (boundary?.getBoundingClientRect().left ?? 0) - 16
      // jsdom has no layout; retain the normal width there.
      if (available > 0) setWidth(Math.min(256, available))
    }
    measure()
    if (focusRequested.current) {
      inputRef.current?.focus()
      focusRequested.current = false
    }
    if (!boundary || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(boundary)
    return () => observer.disconnect()
  }, [expanded])

  const close = () => {
    if (value) onChange('')
    setOpen(false)
    buttonRef.current?.focus()
  }

  return (
    <div
      ref={rootRef}
      // In a header 24px, as its other controls are (card-header-button.ts).
      // Open in a header it is a field, and keeps a field's distance from what stands beside it (card-header-button.ts CARD_HEADER_SPACED).
      className={cn('relative shrink-0', inHeader ? 'h-6 transition-[width] duration-150 ease-out motion-reduce:transition-none' : 'size-8', inHeader && expanded && 'ni-header-spaced')}
      // In a header the field's width is its own: the header makes room for it.
      style={inHeader ? { width: expanded ? width : 24 } : undefined}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !value) setOpen(false)
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={expanded}
        aria-hidden={expanded}
        aria-controls={inputId}
        tabIndex={expanded ? -1 : 0}
        onClick={focus}
        className={cn(
          'flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          inHeader ? 'size-6 rounded-full text-muted-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground' : 'size-8 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground',
          expanded && 'pointer-events-none opacity-0',
        )}
      >
        <Search className="size-3.5" aria-hidden />
      </button>
      <div
        id={inputId}
        aria-hidden={!expanded}
        className={cn(
          'absolute right-0 top-0 z-20 flex items-center overflow-hidden rounded-full border transition-[width,opacity] duration-150 ease-out focus-within:ring-1 focus-within:ring-ring/30 motion-reduce:transition-none',
          inHeader ? 'h-6' : 'h-8',
          // In a header, on its glass like the layout switcher's capsule; elsewhere a field over what it covers.
          inHeader ? 'border-transparent bg-foreground/[0.05]' : 'border-border bg-background shadow-sm',
          expanded ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        style={{ width: expanded ? width : inHeader ? 24 : 32 }}
      >
        {expanded && <>
          <Search className={cn('pointer-events-none absolute size-3.5 text-muted-foreground', inHeader ? 'left-2' : 'left-2.5')} aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-label={label}
            placeholder={placeholder}
            className={cn('h-full w-full min-w-0 bg-transparent outline-none placeholder:text-muted-foreground/60', inHeader ? 'pl-7 pr-7 text-[13px]' : 'pl-8 pr-8 text-sm')}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
              event.preventDefault()
              event.stopPropagation()
              close()
            }}
          />
          <button
            type="button"
            aria-label={value ? 'Clear search' : 'Close search'}
            title={value ? 'Clear search' : 'Close search'}
            className={cn('absolute flex items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', inHeader ? 'right-0.5 size-5' : 'right-1 size-6')}
            onClick={() => {
              if (!value) return close()
              onChange('')
              inputRef.current?.focus()
            }}
          >
            <X className={inHeader ? 'size-3' : 'size-3.5'} aria-hidden />
          </button>
        </>}
      </div>
    </div>
  )
})
