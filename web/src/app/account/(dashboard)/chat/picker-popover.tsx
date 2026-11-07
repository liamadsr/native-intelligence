'use client'

import { useState, useEffect, useRef } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverAnchor,
} from '@/components/ui/popover'
import { usePopoverLock } from './chat-input'
import { useFloatingChatContainerRef } from './floating-chat'

/** The chat's reading-column cap (px). The upper bound (full-screen-chat /
 *  collapsed mode); the expanded mode column is narrower (see
 *  `.chat-reading-col` in tailwind.css). Popover panels anchored above the chat
 *  input clamp to `measureChatReadingColumn()` so they match whichever width the
 *  column is currently at; this constant is only the fallback ceiling. */
export const CHAT_READING_COLUMN_MAX = 634

/**
 * The CURRENT rendered width of the chat's reading column (`.chat-reading-col`),
 * which varies by collapse state (a percentage of the strip when expanded, up to
 * 634px full-screen). Popovers anchored above the chat input match this so they
 * never overrun the visible message/input column. Falls back to the given strip
 * width (clamped to the 634px ceiling) if the column isn't in the DOM yet. */
export function measureChatReadingColumn(stripWidth: number): number {
  if (typeof document !== 'undefined') {
    const col = document.querySelector('.chat-reading-col')
    const w = col?.getBoundingClientRect().width
    if (w && w > 0) return w
  }
  return Math.min(stripWidth, CHAT_READING_COLUMN_MAX)
}

export interface PickerPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchorRef: React.RefObject<HTMLElement | null>
  /** Ref to the toggle button — clicks on it won't auto-dismiss the popover */
  toggleRef?: React.RefObject<HTMLElement | null>
  placeholder: string
  emptyMessage: string
  loadingMessage?: string
  maxHeight?: string
  itemCount: number
  onSelect: (index: number) => void
  onSearchChange?: (search: string) => void
  isLoading?: boolean
  children: React.ReactNode
  /** Current highlight index (controlled) */
  highlightIndex: number
  onHighlightChange: (index: number) => void
  /** Which way the panel opens from its anchor. Default 'top' (above the chat
   *  input); 'bottom' for a picker opened from the top bar. */
  side?: 'top' | 'bottom'
  /** Fixed width (px), instead of matching the chat's reading column. */
  width?: number
}

/**
 * Shared popover wrapper for all chat picker panels (captures, recipes, history).
 * Handles: popover lock, search input, keyboard navigation, consistent styling/alignment.
 */
export function PickerPopover({
  open,
  onOpenChange,
  anchorRef,
  toggleRef,
  placeholder,
  emptyMessage,
  loadingMessage = 'Loading...',
  maxHeight = 'max-h-80',
  itemCount,
  onSelect,
  onSearchChange,
  isLoading = false,
  children,
  highlightIndex,
  onHighlightChange,
  side = 'top',
  width,
}: PickerPopoverProps) {
  const floatingContainerRef = useFloatingChatContainerRef()
  const lockPopover = usePopoverLock()
  const [search, setSearch] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Notify parent popover lock
  useEffect(() => {
    if (!open) return
    lockPopover(true)
    return () => lockPopover(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Reset search when opening
  useEffect(() => {
    if (open) {
      setSearch('')
      onSearchChange?.('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Focus search input when popover opens
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => searchInputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [open])

  const handleSearchChange = (value: string) => {
    setSearch(value)
    onSearchChange?.(value)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      onHighlightChange(Math.min(highlightIndex + 1, itemCount - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      onHighlightChange(Math.max(highlightIndex - 1, 0))
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      if (itemCount > 0) onSelect(highlightIndex)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onOpenChange(false)
    } else if (e.key === 'Backspace' && search === '') {
      e.preventDefault()
      onOpenChange(false)
    }
  }

  // Anchor to the input wrapper so popovers appear just above the input,
  // not above the entire expanded chat container
  const popoverAnchorRef = anchorRef

  // Calculate the space on the side the panel opens toward, to cap its height
  // (above the anchor by default; below it for a top-bar picker).
  const [space, setSpace] = useState(400)
  useEffect(() => {
    if (!open || !anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    const available = side === 'bottom' ? window.innerHeight - rect.bottom : rect.top
    setSpace(Math.max(available - 80, 120)) // 80px edge padding, 120px minimum
  }, [open, anchorRef, side])

  if (!open) return null

  // Cap the scroll area: available space minus popover chrome (search input ~52px + sideOffset 6px)
  const scrollMaxH = Math.min(space - 58, 320)

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={popoverAnchorRef as any} />
      <PopoverContent
        side={side}
        align="center"
        sideOffset={6}
        className="rounded-3xl border border-border bg-background p-0 shadow-xs"
        style={width ? { width } : {
          // Match the chat's reading column, never the raw strip. The container
          // ref is the full-width strip — which in full-screen-chat (collapsed)
          // mode is the ENTIRE window, so following it would make the picker
          // bloom wall-to-wall. The messages/input are capped to `.chat-reading-col`
          // (640px expanded / 634px collapsed), so measure THAT and match it,
          // then inset 36px (20px card padding + 16px gutter) so it doesn't touch
          // the card walls.
          width:
            measureChatReadingColumn(
              floatingContainerRef.current?.getBoundingClientRect().width ??
                anchorRef.current?.getBoundingClientRect().width ??
                320,
            ) - 36,
        }}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => {
          // If the click landed on the toggle button, prevent Radix from
          // auto-dismissing so the button's own onClick can handle the toggle.
          if (toggleRef?.current?.contains(e.target as Node)) {
            e.preventDefault()
          }
        }}
      >
        <div className="border-b p-2">
          <input
            ref={searchInputRef}
            placeholder={placeholder}
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-8 w-full rounded-md bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {/*
          Native overflow, not Radix ScrollArea. ScrollArea's Viewport is
          `h-full`, which against a parent constrained only by max-height
          resolves to auto — so the viewport grew to fit every item and the
          Root just clipped it with overflow-hidden. There was never a real
          scroll container, which is why two-finger trackpad scrolling did
          nothing in the desktop WebView. Every other scrollable popover here
          (dropdown-menu, select, command) uses plain overflow-y-auto.
          overscroll-contain keeps a scroll that hits the end from bleeding
          into the chat behind the popover. rounded-[inherit] makes the scroll
          clip box follow the popover's rounded-3xl corners instead of clipping
          with a square edge — the Radix Viewport this replaced had it.
        */}
        <div
          className="overflow-y-auto overflow-x-hidden overscroll-contain rounded-[inherit]"
          style={{ maxHeight: scrollMaxH }}
        >
          {isLoading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              {loadingMessage}
            </div>
          ) : itemCount === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              {emptyMessage}
            </div>
          ) : (
            // p-2 (not p-1): the popover is rounded-3xl (24px), so a
            // rounded-md row 4px from the corner got its highlight box
            // carved ~2px by the curve — obvious with a single result.
            // 8px clears the arc by ~4px, comfortably past subpixel.
            <div className="p-2">{children}</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Shared className for picker list items */
export function pickerItemClassName(isHighlighted: boolean) {
  return `flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm transition-colors ${
    isHighlighted ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
  }`
}
