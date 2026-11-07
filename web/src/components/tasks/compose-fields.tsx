'use client'

/**
 * The shared field furniture — the chip vocabulary compose invented, extracted
 * so a second reader of a provider's fields can speak it without forking it.
 *
 * Everything here was private to `push-compose-panel.tsx` and moved out
 * UNCHANGED: same class strings, same DOM, same `data-compose-*` markers, same
 * aria-labels. That is not incidental tidiness — the ~50 tests in
 * `__tests__/push-compose-panel.test.tsx` locate every field through those
 * attributes and assert those classes, so they are the parity proof for this
 * extraction and none of them were touched.
 *
 * WHY IT MOVED. Compose reads OPTION LISTS (what a create could choose) and
 * writes once. The property lens reads a linked ticket's LIVE field values and
 * writes per field. Those are different request lifecycles over the SAME
 * controls: a chip that shows the current value, falls back to the field's name
 * when unset, goes destructive when required-and-unanswered, and crosses the
 * `YYYY-MM-DD` boundary without moving a deadline by a day. Two copies of that
 * would drift on the first restyle, and the drift would be invisible — a lens
 * chip a pixel taller than a compose chip in the same row.
 *
 * WHAT DID NOT MOVE: anything create-shaped. `buildOverrides`' dirty-diff
 * against the admin's configured default, the Create button's `blockedReason`
 * wall, the Jira createmeta classification, the provider field components
 * themselves (`JiraFields`/`AsanaFields`/`LinearFields`) all stay in the panel.
 * The line is "does this know what a create is" — if yes, it stayed.
 */

import { AlertTriangle, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DateTimePicker } from '@/components/ui/datetime-picker'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { type ComposeLoadFailure } from './use-compose-options'

/** The sentinel a `<Select>` uses for "leave this unset" (empty value is illegal). */
export const NONE = '__none__'

export type ComposeProvider = 'asana' | 'jira' | 'linear'

/**
 * Where the form is drawn.
 *
 * `strip` is the row surfaces' one-line horizontal scroller; `stack` is the
 * detail panel's vertical sidebar group. Nothing about the FIELDS varies with
 * it — see the file header.
 */
export type ComposeLayout = 'strip' | 'stack'

/**
 * THE CHIP. The strip's unit of presentation, and the reason this file no
 * longer looks like a form.
 *
 * Dial8 renders an action's own properties as a row of compact outline pills —
 * `PropertyPill` in proposal-card.tsx / create-dialog.tsx / attention-card.tsx,
 * plus `chipClass`/`cellTriggerClass` in lib/views/property-options.ts. All of
 * them agree on the same tokens: `h-7`, `rounded-full`, a hairline border, a
 * 3x3 icon, `text-xs`, and a truncated label that reads as the CURRENT VALUE
 * when there is one and as the field's NAME when there isn't.
 *
 * The compose strip used to ignore that entirely: uppercase captions stacked
 * above boxed inputs of three different heights, which read as a form dropped
 * into a row rather than as the row's own properties. Liam's objection was
 * never about pop-ups alone — the spec was always "the SAME property
 * presentation the action already has, populated with the provider's options".
 * So the caption is GONE (the value carries the meaning; the placeholder
 * carries the name) and every control is one of these.
 *
 * `h-7` on every chip is what kills the staircase: the old strip mixed h-8
 * controls with 10px captions and one-line hints, so each field had a
 * different total height and the row's bottom edge was ragged. One height, one
 * baseline, `items-center` — a chip row, not a form.
 */
export const chipTriggerClass =
  'flex h-7 shrink-0 items-center gap-1 rounded-full border border-border bg-transparent px-2.5 text-xs font-medium shadow-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 data-placeholder:text-muted-foreground'

/** A required chip whose answer is still missing, matching PropertyPill's `error`. */
export const chipErrorClass = 'border-destructive text-destructive'

/**
 * One control.
 *
 * In `stack` it is the full-width labelled row the sidebar's other properties
 * already are — the sidebar is a vertical column of named properties and a
 * caption reads correctly there, so that layout keeps its labels.
 *
 * In `strip` the wrapper is nothing but a shrink-0 flex item: no caption, no
 * fixed width, no hint. The chip inside sizes to its own content, which is what
 * makes the row read as properties rather than as columns — a 128px box holding
 * the word "Low" is a form field, and a chip that is exactly as wide as "Low"
 * is a property. `shrink-0` still turns "more fields" into "more scroll".
 *
 * The hint has nowhere to go in a chip row, so in `strip` it becomes the
 * chip's `title` — the Asana section sentence is still reachable on hover
 * without giving the field a second line and re-introducing the ragged bottom.
 */
export function Field({
  label,
  hint,
  required,
  layout,
  children,
}: {
  label: string
  hint?: string
  required?: boolean
  layout: ComposeLayout
  children: React.ReactNode
}) {
  if (layout === 'stack') {
    return (
      <div className="space-y-1.5">
        <div className="flex items-baseline gap-1.5">
          <p className="text-xs font-medium">{label}</p>
          {required && <span className="text-[10px] text-muted-foreground">required</span>}
        </div>
        {children}
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </div>
    )
  }
  return (
    <div className="shrink-0" data-compose-field={label} title={hint}>
      {children}
    </div>
  )
}

/**
 * A plain `<Select>` over id/name options, with an optional "none" row.
 *
 * The form's workhorse. `null` and the NONE sentinel are the same state to the
 * caller and different states to Radix, and translating between them in one
 * place is the entire reason this exists.
 */
export function OptionSelect({
  value,
  onChange,
  options,
  placeholder,
  noneLabel,
  loading,
  disabled,
  ariaLabel,
  layout,
  icon,
  error,
}: {
  value: string | null
  onChange: (value: string | null) => void
  options: Array<{ id: string; name: string }>
  placeholder: string
  /** Present = the field is optional and offers an explicit "unset" row. */
  noneLabel?: string
  loading?: boolean
  disabled?: boolean
  ariaLabel: string
  layout: ComposeLayout
  /** The chip's leading glyph in `strip`. Ignored in `stack`. */
  icon?: React.ReactNode
  /** Required and unanswered — the chip goes destructive, as PropertyPill does. */
  error?: boolean
}) {
  const strip = layout === 'strip'
  return (
    <div className="relative">
      <Select
        value={value ?? (noneLabel ? NONE : undefined)}
        onValueChange={(next) => onChange(next === NONE ? null : next)}
        disabled={disabled}
      >
        {/* The SAME `<Select>` as before — only its trigger's clothes changed.
            Radix keeps rendering the chosen option's text through
            `<SelectValue>`, which is what makes a chip show the CURRENT
            selection (the prefilled project's name, "Low", a teammate) and fall
            back to the placeholder — the field's name — when nothing is picked.
            `data-placeholder:` in `chipTriggerClass` mutes exactly that
            fallback, which is PropertyPill's `muted` by another route.

            `hideChevron` in `strip`: a chevron on every chip is four chevrons
            in a row of four properties, and Dial8's own property pills carry
            none. `aria-label` stays put — it is the handle every test and every
            screen reader identifies this field by. */}
        <SelectTrigger
          className={
            strip
              ? cn(chipTriggerClass, error && chipErrorClass, loading && 'pr-6')
              : 'h-8 text-xs'
          }
          hideChevron={strip}
          aria-label={ariaLabel}
        >
          {strip && icon}
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {noneLabel && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {loading && (
        <Loader2
          className={cn(
            'pointer-events-none absolute animate-spin text-muted-foreground',
            strip ? 'right-2 top-2 h-3 w-3' : 'right-7 top-2 h-4 w-4',
          )}
        />
      )}
    </div>
  )
}

/**
 * THE WIRE FORMAT, and the only safe way to cross the Date boundary.
 *
 * `due_date`/`due_on` travel as the exact bytes `YYYY-MM-DD` — a CALENDAR date,
 * with no instant and no zone attached. `Date` has no such type, so every
 * conversion between the two is a chance to silently move a deadline by a day,
 * and both directions have a trap:
 *
 *  - READING, `new Date('2026-03-14')` parses as UTC MIDNIGHT (the ISO
 *    date-only form is spec'd that way), which in any negative-offset zone is
 *    the 13th when read back with `getDate()`. So the string is split and fed
 *    to the `Date(y, m, d)` constructor, which is LOCAL by definition.
 *  - WRITING, `toISOString()` converts to UTC first, so a local midnight in
 *    New York serialises as the previous day at 05:00Z and the date part reads
 *    one day early. So the parts are read with the LOCAL getters and assembled
 *    as a string; no UTC ever enters the round trip.
 *
 * These are the same two functions the proposal card's own due-date pill uses
 * on its write path, stated once here because this field now shares its picker.
 */
export function parseWireDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const [, y, m, d] = match
  return new Date(Number(y), Number(m) - 1, Number(d))
}

export function formatWireDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * A date-only field. Every provider's date here is a calendar date.
 *
 * IN `strip` THIS IS DIAL8'S OWN PICKER — the same `DateTimePicker` the
 * proposal card's due-date pill wraps, at `granularity="day"` (which drops the
 * time row entirely) and wearing `chipTriggerClass`. A native
 * `<input type="date">` was the one control in the row that was not the app's:
 * it renders the browser's widget, in the browser's format, with a calendar
 * glyph no other chip has.
 *
 * The predecessor's reason for keeping the native input was a real hazard, not
 * a wrong one — routing this field through a `Date` risks a timezone slip on
 * the one field where that silently moves a deadline. It is SOLVED rather than
 * inherited: `parseWireDate`/`formatWireDate` above cross the boundary through
 * local date parts only, so the `YYYY-MM-DD` the strip sends is byte-identical
 * to what the input produced. `stack` keeps the plain input: the sidebar is a
 * labelled column where a native field reads correctly, and it was never the
 * surface the chip idiom was about.
 */
export function DateField({
  value,
  onChange,
  ariaLabel,
  layout,
  error,
}: {
  value: string
  onChange: (value: string) => void
  ariaLabel: string
  layout: ComposeLayout
  error?: boolean
}) {
  if (layout === 'stack') {
    return (
      <Input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 text-xs"
        aria-label={ariaLabel}
      />
    )
  }
  // THE ACCESSIBLE NAME, preserved through a wrapper. `DateTimePicker` does not
  // accept `aria-label` (its props are a closed list and nothing is spread onto
  // the trigger Button), and this field's name is the handle every test and
  // every screen reader identifies it by — the one thing a restyle must not
  // drop. A labelled group carries it without touching the shared component.
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-compose-date={ariaLabel}
      className="flex items-center gap-1"
    >
    <DateTimePicker
      value={parseWireDate(value)}
      // `DateTimePicker` only ever emits a Date (its calendar cannot clear a
      // selection), so the null branch the wire format allows is unreachable
      // from here — clearing stays the job of the X the card's own pill offers.
      onChange={(date) => onChange(date ? formatWireDate(date) : '')}
      granularity="day"
      // The chip shows a VALUE, so it reads like every other property: "Mar 14,
      // 2026" rather than a locale-dependent 03/14/2026 with empty segments.
      displayFormat={{ hour24: 'MMM d, yyyy', hour12: 'MMM d, yyyy' }}
      placeholder={ariaLabel}
      className={cn(
        chipTriggerClass,
        // The picker's trigger is a Button, which brings `w-full justify-start`
        // and the default button height; the chip sizes to its content on one
        // shared line, so both are overridden here.
        'w-auto justify-start font-medium [&>svg]:h-3 [&>svg]:w-3 [&>svg]:opacity-70',
        !value && 'text-muted-foreground',
        error && chipErrorClass,
      )}
    />
    {/* CLEARING, which the calendar itself cannot do — `DateTimePicker` has no
        way to emit "no date", and a date that can be set but never unset is a
        regression the native input did not have: an explicit null is how a
        cleared date suppresses the push's fallback. The proposal card's own
        due-date pill pairs the same picker with the same X for the same
        reason; this matches it, down to the muted-until-hover treatment. */}
    {value && (
      <button
        type="button"
        aria-label={`Clear ${ariaLabel.toLowerCase()}`}
        onClick={() => onChange('')}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    )}
    </div>
  )
}

/**
 * The banner that replaces the fields when the token is dead.
 *
 * Deliberately the same vocabulary as the settings pickers' ReconnectBanner
 * (same two codes, same conclusion) but not the same component: that one owns a
 * Reconnect BUTTON that runs the OAuth flow, and this form is sitting in a
 * capture row with no business starting one. It points at Settings instead.
 *
 * In `strip` it is COMPACT — one line that fits the row's height, because the
 * strip cannot grow vertically without every row below it jumping. The words
 * and the way out are the same; only the wrapping changes.
 *
 * IT IS NOT COMPOSE-ONLY, which is why it lives here: a lens read or write that
 * comes back `reconnect_required` has the identical diagnosis and the identical
 * way out. The one compose-shaped thing left in it is the word "compose" in the
 * reconnect headline, and it is left HARDCODED on purpose — this extraction
 * changes zero rendered bytes, so parameterising the wording is the lens
 * author's edit to make (with its own test) rather than a silent rider on a
 * pure move.
 */
export function ComposeFailure({
  failure,
  providerName,
  onOpenSettings,
  provider,
  onRetry,
  layout,
}: {
  failure: ComposeLoadFailure
  providerName: string
  provider: ComposeProvider
  onOpenSettings?: (subPath?: string) => void
  onRetry: () => void
  layout: ComposeLayout
}) {
  if (failure.kind === 'reconnect') {
    if (layout === 'strip') {
      return (
        <div className="flex min-w-0 items-center gap-2" data-compose-failure="reconnect">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <p className="truncate text-xs">Reconnect {providerName} to compose</p>
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 text-xs"
            onClick={() => onOpenSettings?.(`connectors/${provider}/tasks`)}
          >
            Open {providerName} settings
          </Button>
        </div>
      )
    }
    return (
      <div
        className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3"
        data-compose-failure="reconnect"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <div className="flex-1">
          <p className="text-sm font-medium">Reconnect {providerName} to compose</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Dial8 can no longer use your stored {providerName} authorization, so the pickers
            can&apos;t load.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2.5 h-7 text-xs"
            onClick={() => onOpenSettings?.(`connectors/${provider}/tasks`)}
          >
            Open {providerName} settings
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div
      className={cn(
        'flex items-center gap-3',
        layout === 'strip'
          ? 'min-w-0'
          : 'justify-between rounded-lg border border-border px-4 py-2.5',
      )}
      data-compose-failure="error"
    >
      <p className={cn('text-xs text-muted-foreground', layout === 'strip' && 'truncate')}>
        {failure.message}
      </p>
      <Button variant="outline" size="sm" className="h-7 shrink-0 text-xs" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}
