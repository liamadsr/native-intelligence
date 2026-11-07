'use client'

import * as React from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DEFAULT_RELATIVE_DATE, FilterValuePicker, isFreeTypedValue } from './filter-value-picker'
import { cn } from '@/lib/utils'
import { X } from 'lucide-react'
import {
  FILTERABLE_FIELDS, OPERATORS_BY_TYPE, operatorLabel,
  type FilterOperator, type FilterValue,
  type ViewEntityType, type ViewFilter,
} from '@/lib/views/types'

/**
 * How long a half-typed filter value is held before it becomes a query.
 *
 * The same 300 ms the free-text search box uses (unified-view-layout), because
 * it is the same gesture from the user's side and two different pauses in one
 * toolbar would read as one of them being broken.
 */
export const FILTER_COMMIT_DEBOUNCE_MS = 300

/**
 * The SHAPE an operator's value takes, so a chip can tell whether a value
 * survives an operator change. Not the same question as the field's TYPE: one
 * number field holds a scalar under `gte` and a range under `between`.
 */
type ValueShape = 'none' | 'scalar' | 'list' | 'range' | 'relative'

function valueShape(operator: FilterOperator): ValueShape {
  switch (operator) {
    case 'is_empty':
    case 'is_not_empty':
      return 'none'
    case 'between':
      return 'range'
    case 'is_relative':
      return 'relative'
    case 'is_any_of':
    case 'is_none_of':
    case 'includes':
    case 'excludes':
      return 'list'
    default:
      return 'scalar'
  }
}

interface FilterChipProps {
  filter: ViewFilter
  entityType: ViewEntityType
  onUpdate: (filter: ViewFilter) => void
  onRemove: () => void
}

/**
 * Structural equality for a filter value.
 *
 * Reference equality is not enough: consumers rebuild the filter array on every
 * change (view-toolbar's `renderFilterChips`), so the object a chip pushed up
 * can come back as a copy. Object keys are sorted so `{from,to}` and `{to,from}`
 * — the two orders `{...range, ...partial}` produces — are one value, the same
 * trick graph-map/filter-model uses for the cache key.
 */
function sameValue(a: FilterValue | undefined, b: FilterValue | undefined): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return JSON.stringify(a) === JSON.stringify(b)
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort()
  return JSON.stringify(a, keys) === JSON.stringify(b, keys)
}

export function FilterChip({ filter, entityType, onUpdate, onRemove }: FilterChipProps) {
  const fieldDef = FILTERABLE_FIELDS[entityType].find(f => f.field === filter.field)

  // ─── Buffered commits ───────────────────────────────────────────────────
  //
  // Every committed filter is a QUERY. On a list that is one wasted round trip
  // per keystroke; on the knowledge map it is far worse, because each distinct
  // filter identity is a new server-side cache key and therefore a re-tile of
  // the WHOLE map — typing one word unbuffered is about one whole-map pass per
  // character, each of them blocking the Node event loop. So a free-typed value
  // is held here and pushed up on a trailing timer.
  //
  // The buffer holds the whole VALUE and is fed back INTO the picker, rather
  // than just wrapping the callback. That is load-bearing for the range
  // editors: they build the next value by merging into the one they were handed
  // (`{...range, ...partial}`), so with an uncommitted first field still
  // upstream, editing the second would spread a stale range and wipe the first.
  const [draft, setDraft] = React.useState<{ value: FilterValue } | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingRef = React.useRef<{ value: FilterValue } | null>(null)
  // The value this chip is in step with: the last one it pushed up, or the last
  // one it adopted from outside. The effect below compares against it to tell
  // "the user is mid-edit" from "someone swapped the view under us".
  const syncedRef = React.useRef<FilterValue>(filter.value)
  // Read through refs so the timer callback never fires with a stale filter or
  // a stale handler — it runs 300 ms after the render that scheduled it.
  const onUpdateRef = React.useRef(onUpdate)
  onUpdateRef.current = onUpdate
  const filterRef = React.useRef(filter)
  filterRef.current = filter

  const cancel = React.useCallback(() => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current)
    timerRef.current = undefined
    pendingRef.current = null
  }, [])

  const commit = React.useCallback((value: FilterValue) => {
    cancel()
    syncedRef.current = value
    setDraft(null)
    onUpdateRef.current({ ...filterRef.current, value })
  }, [cancel])

  /** Push whatever is buffered up NOW. Blur and Enter are a user saying the
   *  edit is over, and making them wait out the rest of the timer after that
   *  reads as a dropped keystroke. */
  const flush = React.useCallback(() => {
    const pending = pendingRef.current
    if (pending) commit(pending.value)
  }, [commit])

  const handleChange = React.useCallback((value: FilterValue, debounce: boolean) => {
    if (!debounce) {
      // A click in a checkbox, an entity list or a calendar is already a
      // deliberate commit. Delaying it would only make the surface feel broken.
      commit(value)
      return
    }
    setDraft({ value })
    pendingRef.current = { value }
    if (timerRef.current !== undefined) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined
      flush()
    }, FILTER_COMMIT_DEBOUNCE_MS)
  }, [commit, flush])

  /**
   * The operator dropdown, which carries the pending value with it.
   *
   * Not "flush, then update the operator": the second call would be built from
   * this render's `filter` prop, which still holds the pre-flush value, and
   * would undo the flush. One update carries both halves instead.
   */
  const commitOperator = React.useCallback((operator: FilterOperator) => {
    const pending = pendingRef.current
    cancel()
    setDraft(null)
    const current = filterRef.current
    // CARRY THE VALUE ONLY IF THE NEW OPERATOR TAKES THE SAME SHAPE.
    //
    // `between` holds a `{from, to}` object, `is_relative` a `{unit,
    // direction}` one, the multi-select operators an array, the rest a scalar.
    // Carrying a value across a shape change hands the query engine something
    // it cannot use — `query.gte(field, {from, to})` serialises the object into
    // the URL and Postgres answers 22P02, which surfaces as a 500 rather than
    // as the validation error it is. Resetting to empty instead puts the chip
    // back in its "not filled in yet" state, which both engines already agree
    // means "not applied".
    const keep = valueShape(operator) === valueShape(current.operator)
    const carried = pending ? pending.value : current.value
    // "is relative" shows a window ("Last 7 days") from the start, so it holds
    // one too: an empty value would read as active while filtering nothing.
    const fresh = operator === 'is_relative' ? DEFAULT_RELATIVE_DATE : ''
    const next: ViewFilter = { ...current, operator, value: keep ? carried : fresh }
    syncedRef.current = next.value
    onUpdateRef.current(next)
  }, [cancel])

  React.useEffect(() => {
    if (sameValue(filter.value, syncedRef.current)) return
    // The value moved from OUTSIDE this chip — a saved view was switched, a
    // draft discarded. Drop the buffer and its timer: left alone it would land
    // a half-typed word from the previous view onto the new one 300 ms later,
    // which looks like the new view filtering itself.
    syncedRef.current = filter.value
    cancel()
    setDraft(null)
  }, [filter.value, cancel])

  // A pending value must never outlive the chip. Cancelled rather than flushed:
  // the chip is gone because the filter was removed or the view replaced, and
  // in both cases committing would resurrect something the user just discarded.
  React.useEffect(() => cancel, [cancel])

  if (!fieldDef) return null

  const operators = OPERATORS_BY_TYPE[fieldDef.type] || ['is']
  const noValue = ['is_empty', 'is_not_empty'].includes(filter.operator)
  const debounce = isFreeTypedValue(fieldDef, filter.operator)
  const value = draft ? draft.value : filter.value

  return (
    <div className="inline-flex items-stretch h-7 rounded-md border bg-background text-xs">
      {/* Field label */}
      <span className="flex items-center px-2 text-muted-foreground font-medium shrink-0">
        {fieldDef.label}
      </span>

      {/* Operator dropdown */}
      <Popover modal={false}>
        <PopoverTrigger asChild>
          <button className="flex items-center px-2 border-l text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0">
            {operatorLabel(filter.operator, fieldDef.type)}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-44 p-1" align="start" onOpenAutoFocus={e => e.preventDefault()}>
          {operators.map(op => (
            <button
              key={op}
              onClick={() => commitOperator(op)}
              className={cn(
                'w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-muted transition-colors',
                filter.operator === op && 'bg-muted font-medium',
              )}
            >
              {operatorLabel(op, fieldDef.type)}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {/* Value picker. The flush handlers sit on the wrapper rather than on the
          inputs because the editors are several layers down and vary by type —
          React's onBlur is focusout, which bubbles, so one handler catches
          every one of them. Enter is only intercepted when there IS something
          buffered: inside the enum and entity pickers Enter belongs to the
          command list, which selects with it. */}
      {!noValue && (
        <div
          className="flex items-center border-l hover:bg-muted/50 transition-colors"
          onBlur={flush}
          onKeyDown={e => {
            if (e.key === 'Enter' && pendingRef.current) {
              e.preventDefault()
              flush()
            }
          }}
        >
          <FilterValuePicker
            fieldDef={fieldDef}
            operator={filter.operator}
            value={value}
            onChange={next => handleChange(next, debounce)}
            entityType={entityType}
          />
        </div>
      )}

      {/* Remove */}
      <button
        onClick={onRemove}
        className="flex items-center px-1.5 border-l text-muted-foreground hover:text-destructive hover:bg-muted/50 transition-colors rounded-r-md"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
