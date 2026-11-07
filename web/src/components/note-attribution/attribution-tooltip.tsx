'use client'

import { useEffect, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'

interface AttributionTooltipProps {
  /** The editor container element to watch for hover events */
  containerRef: React.RefObject<HTMLElement | null>
}

/**
 * Renders a tooltip when the user hovers over a note-attribution decoration.
 * Shows the original user note that influenced the AI-enhanced text.
 */
export function AttributionTooltip({ containerRef }: AttributionTooltipProps) {
  const [tooltip, setTooltip] = useState<{
    text: string
    x: number
    y: number
  } | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    function handleMouseOver(e: MouseEvent) {
      const target = e.target as HTMLElement
      const attrEl = target.closest?.('[data-attribution-id]') as HTMLElement | null
      if (!attrEl?.dataset.originalNote) return

      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current)
        hideTimeoutRef.current = null
      }

      const rect = attrEl.getBoundingClientRect()
      setTooltip({
        text: attrEl.dataset.originalNote,
        x: rect.left,
        y: rect.top - 4,
      })
    }

    function handleMouseOut(e: MouseEvent) {
      const related = e.relatedTarget as HTMLElement | null
      // Don't hide if moving into the tooltip itself
      if (related?.closest?.('.attribution-tooltip-container')) return
      // Don't hide if moving to another attribution element
      if (related?.closest?.('[data-attribution-id]')) return

      // Replace, never stack: an older timer left running could not be
      // cancelled by the next mouseover and would hide the next tooltip.
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current)
      hideTimeoutRef.current = setTimeout(() => setTooltip(null), 200)
    }

    container.addEventListener('mouseover', handleMouseOver)
    container.addEventListener('mouseout', handleMouseOut)

    return () => {
      container.removeEventListener('mouseover', handleMouseOver)
      container.removeEventListener('mouseout', handleMouseOut)
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current)
    }
  }, [containerRef])

  // Also hide when mouse leaves the tooltip itself
  useEffect(() => {
    const el = tooltipRef.current
    if (!el) return

    function handleTooltipLeave() {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current)
      hideTimeoutRef.current = setTimeout(() => setTooltip(null), 150)
    }

    function handleTooltipEnter() {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current)
        hideTimeoutRef.current = null
      }
    }

    el.addEventListener('mouseenter', handleTooltipEnter)
    el.addEventListener('mouseleave', handleTooltipLeave)
    return () => {
      el.removeEventListener('mouseenter', handleTooltipEnter)
      el.removeEventListener('mouseleave', handleTooltipLeave)
    }
  })

  if (!tooltip) return null

  return (
    <div
      ref={tooltipRef}
      className="attribution-tooltip-container fixed z-50 max-w-xs animate-in fade-in zoom-in-95 duration-100"
      style={{
        left: tooltip.x,
        top: tooltip.y,
        transform: 'translateY(-100%)',
      }}
    >
      <div className="rounded-md border border-border bg-popover px-3 py-2 shadow-md">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
          <Pencil className="h-2.5 w-2.5" />
          Your note
        </div>
        <p className="text-xs leading-relaxed text-popover-foreground">
          {tooltip.text}
        </p>
      </div>
    </div>
  )
}
