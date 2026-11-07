'use client'

import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react'

import { cn } from '@/lib/utils'

type EntityTitleInputProps = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  /** Fires on Enter and on blur, for panels that commit a draft rather than every keystroke. */
  onCommit?: () => void
  /** Fires on Escape, for panels with a cancellable edit mode. */
  onCancel?: () => void
  autoFocus?: boolean
  /** Exposed so click-to-edit panels can focus/select the field when entering edit mode. */
  inputRef?: RefObject<HTMLTextAreaElement | null>
  'aria-label'?: string
}

/**
 * The title field at the top of a detail panel (action, project, initiative,
 * capture, document, contact).
 *
 * This is a textarea rather than an input so a long title wraps onto as many
 * lines as it needs instead of scrolling sideways out of view — the whole title
 * is always readable. The textarea is height-autosized to its content, so it
 * still *looks* like a plain heading: no scrollbar, no resize handle, no fixed
 * row count.
 *
 * Enter is swallowed (titles are single-line values even though the box wraps);
 * a paste containing newlines is flattened to spaces for the same reason.
 */
export function EntityTitleInput({
  value,
  onChange,
  placeholder,
  className,
  onCommit,
  onCancel,
  autoFocus,
  inputRef,
  'aria-label': ariaLabel,
}: EntityTitleInputProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null)

  // Autosize to the content. Reset to 'auto' first so the box can shrink when
  // text is deleted, not just grow.
  const resize = (el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  useLayoutEffect(() => {
    resize(ref.current)
  }, [value])

  // A narrower panel rewraps the same text onto more lines, so the height has
  // to be recomputed on width changes too — not just on edits.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => resize(el))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      onCommit?.()
      if (!onCommit) e.currentTarget.blur()
    }
    if (e.key === 'Escape') onCancel?.()
  }

  return (
    <textarea
      ref={(el) => {
        ref.current = el
        if (inputRef) inputRef.current = el
        resize(el)
      }}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, ' '))}
      onBlur={onCommit}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      className={cn(
        'w-full resize-none overflow-hidden bg-transparent text-xl font-semibold leading-snug outline-none placeholder:text-muted-foreground',
        className,
      )}
    />
  )
}
