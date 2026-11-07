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
 * controls, so narrow windows can offer a useful input without moving Close. */
export const ExpandableSearch = forwardRef<ExpandableSearchHandle, ExpandableSearchProps>(function ExpandableSearch({
  value, onChange, label, placeholder,
}, ref) {
  const [open, setOpen] = useState(false)
  const [width, setWidth] = useState(256)
  const expanded = open || value.length > 0
  const rootRef = useRef<HTMLDivElement>(null)
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
      className="relative size-8 shrink-0"
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
        className={cn('flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', expanded && 'pointer-events-none opacity-0')}
      >
        <Search className="size-3.5" aria-hidden />
      </button>
      <div
        id={inputId}
        aria-hidden={!expanded}
        className={cn('absolute right-0 top-0 z-20 flex h-8 items-center overflow-hidden rounded-full border border-border bg-background shadow-sm transition-[width,opacity] duration-150 ease-out focus-within:ring-1 focus-within:ring-ring/30 motion-reduce:transition-none', expanded ? 'opacity-100' : 'pointer-events-none opacity-0')}
        style={{ width: expanded ? width : 32 }}
      >
        {expanded && <>
          <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-label={label}
            placeholder={placeholder}
            className="h-full w-full min-w-0 bg-transparent pl-8 pr-8 text-sm outline-none placeholder:text-muted-foreground/60"
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
            className="absolute right-1 flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => {
              if (!value) return close()
              onChange('')
              inputRef.current?.focus()
            }}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </>}
      </div>
    </div>
  )
})
