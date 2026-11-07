'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/**
 * The outline pill that fronts an editable property on a CARD surface: an icon,
 * a truncated label that reads as the current value (or the field's name when
 * empty), and a popover holding the picker.
 *
 * ── The component vs. the token-level mirrors ──────────────────────────────
 *
 * Dial8 draws this same pill in two different ways ON PURPOSE, and the split is
 * load-bearing. Do not "finish the job" by collapsing one into the other.
 *
 *   • THIS COMPONENT owns the pill wherever the trigger is a plain `<button>`
 *     that opens a `<Popover>` — proposal cards, the create dialog, attention
 *     cards. Those surfaces get the whole thing: button, popover, open state.
 *
 *   • TOKEN-LEVEL MIRRORS — `chipClass`/`cellTriggerClass` in
 *     `lib/views/property-options.ts` and `chipTriggerClass` in
 *     `components/tasks/push-compose-panel.tsx` — are class strings only,
 *     for surfaces that need a DIFFERENT TRIGGER ELEMENT and therefore cannot
 *     use this component at all:
 *       - `chipClass` dresses read-only `<span>`s in list rows.
 *       - `cellTriggerClass` dresses row-cell picker triggers.
 *       - `chipTriggerClass` dresses the push-compose strip, whose triggers are
 *         Radix `<SelectTrigger>`s. That strip's `aria-label` handles are what
 *         ~50 tests drive, and a Select carries listbox semantics a button in a
 *         Popover does not have. Converting it to `<PropertyPill>` would trade
 *         real Select semantics for a visual match. It stays token-level.
 *
 * The tokens and this component agree on the same visual language — rounded-full,
 * hairline border, small icon, truncated label — but they are deliberately not
 * one implementation, because the elements underneath are not interchangeable.
 *
 * ── Variants ───────────────────────────────────────────────────────────────
 *
 * The three card surfaces never shared an implementation; they were three
 * same-named local components whose sizing, border, popover width and render
 * path all differed. Each `variant` below reproduces one of them EXACTLY, so
 * this extraction is DOM-identical at every call site rather than a
 * visual-regression risk dressed up as a dedup.
 *
 *   • `dialog`    — create-dialog. Padding-sized (no fixed height), supports
 *                   `small`, wide 120px label, 220px popover, `keepOpen`.
 *   • `proposal`  — proposal-card. h-7, shadow-sm, 80px label, 200px popover,
 *                   plus the `error` outline for a missing required field.
 *   • `attention` — attention-card. h-6, softer border/text, flex-truncating
 *                   label, supports `disabled` (renders a bare button, no
 *                   Popover at all) and `shrinkable`.
 */
export type PropertyPillVariant = 'dialog' | 'proposal' | 'attention'

export interface PropertyPillProps {
  icon: React.ReactNode
  label: string
  /** Which card surface this pill belongs to. Each reproduces that surface's exact DOM. */
  variant: PropertyPillVariant
  muted?: boolean
  /**
   * Keep the popover open after a selection (`dialog` only — multi-select
   * fields like labels, where closing on each pick would be hostile).
   */
  keepOpen?: boolean
  /** Tighter sizing for dense rows (`dialog` only). */
  small?: boolean
  /** Red outline marking a required field that is still missing (`proposal` only). */
  error?: boolean
  /**
   * Render a non-interactive pill with no Popover (`attention` only) — used when
   * the card isn't editable or there are no options to pick from.
   */
  disabled?: boolean
  /**
   * When true, this pill absorbs shrinking (its label truncates) so the row
   * stays on one line. Short pills stay shrink-0 at their natural width.
   * (`attention` only.)
   */
  shrinkable?: boolean
  children?: (close: () => void) => React.ReactNode
}

/** Popover width per surface — proposal cards are narrower than the other two. */
const POPOVER_WIDTH: Record<PropertyPillVariant, string> = {
  dialog: 'w-[220px] p-0',
  proposal: 'w-[200px] p-0',
  attention: 'w-[220px] p-0',
}

export function PropertyPill({
  icon,
  label,
  variant,
  muted,
  keepOpen,
  small,
  error,
  disabled,
  shrinkable,
  children,
}: PropertyPillProps) {
  const [open, setOpen] = useState(false)

  let trigger: React.ReactNode
  if (variant === 'dialog') {
    trigger = (
      <button
        className={cn(
          'flex items-center rounded-full border font-medium transition-colors hover:bg-muted',
          small ? 'gap-1 px-2 py-0.5 text-[11px]' : 'gap-1.5 px-2.5 py-1 text-xs',
          muted ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {icon}
        <span className={cn('truncate', small ? 'max-w-[80px]' : 'max-w-[120px]')}>{label}</span>
      </button>
    )
  } else if (variant === 'proposal') {
    trigger = (
      <button
        className={cn(
          'flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium shadow-sm transition-colors hover:bg-muted',
          error
            ? 'border-destructive text-destructive animate-pulse'
            : muted
              ? 'border-border text-muted-foreground'
              : 'border-border text-foreground',
        )}
      >
        {icon}
        <span className="truncate max-w-[80px]">{label}</span>
      </button>
    )
  } else {
    trigger = (
      <button
        type="button"
        disabled={disabled}
        className={cn(
          // Short pills keep their natural width (shrink-0). The shrinkable one
          // (assignee) gets min-w-0 so its label truncates, keeping the row on a
          // single line instead of wrapping.
          'flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors',
          // The shrinkable pill (assignee) also caps its own width so it truncates
          // a touch early — keeps a comfortable margin before the last pill even
          // when the row would otherwise pack edge-to-edge.
          shrinkable ? 'min-w-0 max-w-[120px] shrink' : 'shrink-0',
          disabled ? 'cursor-default border-border/50' : 'hover:bg-muted border-border/60',
          muted ? 'text-muted-foreground' : 'text-foreground/80',
        )}
      >
        <span className="shrink-0">{icon}</span>
        <span className="truncate">{label}</span>
      </button>
    )
  }

  // The attention card's disabled pill is a bare button with no Popover wrapper
  // at all — not a disabled trigger inside one. Keep that: mounting a Popover
  // around a permanently-closed trigger changes the DOM for no benefit.
  if (variant === 'attention' && (disabled || !children)) return <>{trigger}</>

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className={POPOVER_WIDTH[variant]} align="start">
        {children?.(keepOpen ? () => {} : () => setOpen(false))}
      </PopoverContent>
    </Popover>
  )
}
