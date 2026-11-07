'use client'

import * as React from 'react'
import { Check, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Cell trigger ───────────────────────────────────────────

interface BooleanCellTriggerProps {
  value: boolean | null | undefined
  onChange: (value: boolean) => void
  /** Optional label icons — e.g. a star for `is_starred` */
  trueIcon?: React.ReactNode
  falseIcon?: React.ReactNode
  /** Accessible label — e.g. "Pinned", "Unread" */
  label: string
}

/**
 * Simple click-to-toggle boolean cell. Avoids the popover overhead since the
 * only action is flipping the value.
 */
export function BooleanCellTrigger({
  value, onChange, trueIcon, falseIcon, label,
}: BooleanCellTriggerProps) {
  const isTrue = !!value
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onChange(!isTrue) }}
      className={cn(
        'inline-flex h-5 w-5 items-center justify-center rounded-full transition-colors',
        isTrue ? 'text-foreground' : 'text-muted-foreground/50 opacity-0 group-hover:opacity-100',
        'hover:bg-muted/40',
      )}
      aria-label={label}
      aria-pressed={isTrue}
    >
      {isTrue ? (trueIcon ?? <Check className="h-3.5 w-3.5" />) : (falseIcon ?? <Minus className="h-3.5 w-3.5" />)}
    </button>
  )
}

// ── Panel field ────────────────────────────────────────────

interface BooleanPanelFieldProps {
  value: boolean | null | undefined
  onChange: (value: boolean) => void
  label: string
  icon?: React.ReactNode
  /**
   * Horizontal padding of the row, so this field lines up with the sibling rows
   * of whichever panel mounts it — the same two conventions `ProjectPanelField`
   * carries: `px-3` (capture, eval suite) and `px-2` (action, contact).
   */
  padding?: 'px-2' | 'px-3'
}

export function BooleanPanelField({ value, onChange, label, icon, padding = 'px-2' }: BooleanPanelFieldProps) {
  const isTrue = !!value
  return (
    <button
      onClick={() => onChange(!isTrue)}
      className={cn('flex h-8 w-full items-center gap-2 rounded-md text-sm transition-colors hover:bg-muted/50', padding)}
      aria-pressed={isTrue}
    >
      {icon}
      <span>{label}</span>
      <span className={cn('ml-auto text-xs', isTrue ? 'text-foreground' : 'text-muted-foreground')}>
        {isTrue ? 'On' : 'Off'}
      </span>
    </button>
  )
}
