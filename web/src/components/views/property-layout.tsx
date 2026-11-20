import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * THE PROPERTIES PANEL'S FRAME (docs/plans/properties-panels.md), shared by
 * every detail page so each reads the same way from the top:
 *
 *   1. the core rows: what state the record is in and whose it is. Always
 *      shown, set or not (a status, a priority, an assignee);
 *   2. the optional properties that HAVE a value, each a full row;
 *   3. the optional properties that have none, as one wrapping strip of small
 *      "add" chips instead of a row apiece ("Due date", "Estimate", "Add
 *      label", "Set project"…). An empty property costs a chip, not a line.
 *
 * `PropertyRows` is the list; `OptionalProperty` wraps one optional field and
 * says whether it is set. NOTHING IS HIDDEN and nothing costs an extra click:
 * a chip is the field's own trigger, restyled, so it opens the same picker
 * the full row would. And the field stays the same React element in the same
 * place whether set or not (CSS `order` moves it between the rows and the
 * strip), so a picker that is open while its value arrives stays open: a date
 * picked, then its time; a link pasted into the row that just grew a list.
 *
 * The strip is CSS over the field's own markup (a `button` trigger with an
 * icon and a muted label) rather than a second "chip" variant of every
 * picker: one implementation of each field, and a panel moves a field between
 * "always a row" and "optional" by wrapping or unwrapping it.
 */
export function PropertyRows({
  children,
  className,
  inset = 'px-2',
}: {
  children: React.ReactNode
  className?: string
  /**
   * The horizontal padding this panel's rows use, so a chip's icon starts
   * where a row's does: `px-2` (action, project, contact…) or `px-3` (capture).
   */
  inset?: 'px-2' | 'px-3'
}) {
  return (
    <div data-property-rows="" data-inset={inset} className={cn('group/rows flex min-w-0 flex-wrap items-start', className)}>
      {children}
    </div>
  )
}

/** A full-width row among the rows: a core field, or anything that is not a lone trigger. */
export function PropertyRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('order-1 w-full min-w-0', className)}>{children}</div>
}

/**
 * What turns a field's own empty-state trigger into a chip. The selectors
 * reach the trigger wherever the field puts it (a bare button, a button in a
 * `flex h-8` wrapper, a Radix Select's trigger) and beat the field's own
 * utility classes on specificity, with `!` for the few that are themselves
 * variants (`hover:`, `disabled:`).
 */
const ADD_CHIP = [
  'order-3 min-w-0 max-w-full',
  '[&>div]:!h-7',
  '[&_button]:!h-7 [&_button]:!w-auto [&_button]:!flex-none [&_button]:!gap-1.5 [&_button]:!rounded-md [&_button]:!px-2',
  'group-data-[inset=px-3]/rows:[&_button]:!px-3',
  '[&_button]:!text-xs [&_button]:!text-muted-foreground hover:[&_button]:!text-foreground',
  '[&_button_span]:!text-xs',
  '[&_svg]:!h-3.5 [&_svg]:!w-3.5 [&_svg]:!m-0',
  // A row's expand chevron says "there is a list under here"; a chip has none yet.
  '[&_svg.ml-auto]:!hidden',
].join(' ')

/**
 * One optional property. `set`: it has a value (or is open for input), so it
 * is a full row among the rows; otherwise it is a chip in the add strip.
 */
export function OptionalProperty({
  set,
  children,
  className,
}: {
  set: boolean
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-optional-property={set ? 'set' : 'empty'}
      className={cn(set ? 'order-2 w-full min-w-0' : ADD_CHIP, className)}
    >
      {children}
    </div>
  )
}
