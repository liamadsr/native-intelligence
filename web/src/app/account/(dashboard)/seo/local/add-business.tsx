'use client'

/**
 * "Add business": find a business as Google Maps lists it, by its name in a
 * town, and follow it (../start-audit.tsx's dialog look).
 *
 *   The town is a typeahead over the free places list (GET places), with a
 *   country select beside it; the first read of a big country takes a few
 *   seconds, so the field says it is looking.
 *   "Find business" is the request, and it spends (a fresh stored search
 *   answers free): no extra dialog, the spend line is on the page.
 *   Each candidate is a row with "This one", which follows it (POST
 *   businesses, free) and opens it. One already followed opens instead.
 *
 * A town the server can't place (PLACE_NOT_FOUND) is said beside the town
 * field; the spend limit or lookups being off is a neutral line in the
 * dialog; anything else is a toast, and the form keeps what was typed.
 */
import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getIsoCountryCode, LOCATION_OPTIONS } from '@/lib/seo/shared/keyword-locations'
import type { LocalBusinessListing, LocalBusinessSearchResult, LocalPlaceOption, TrackedBusinessView } from '@/lib/seo/local/view'
import { cn } from '@/lib/utils'
import { errorCode, errorMessage } from '../api'
import { DATA_OFF_CODES, searchBusinesses, searchPlaces, trackBusiness, trackedBusinessOf } from './api'
import { ratingWords } from './local-helpers'
import { count } from '../ui-helpers'

const CONTENT = 'w-[min(32rem,calc(100vw-2rem))] max-w-[32rem] gap-0 rounded-lg border-border p-4'
const TRIGGER = 'h-8 w-auto min-w-0 shrink-0 gap-1.5 rounded-md px-2.5 text-xs shadow-none'
const PLACES_DEBOUNCE_MS = 250

/** The countries search data covers, as ISO codes (the routes' `country`). */
const COUNTRIES = LOCATION_OPTIONS.map((o) => ({ iso: getIsoCountryCode(o.code), label: o.label }))

export function AddBusinessDialog({
  open,
  disabledReason,
  onClose,
  onTracked,
  onSpent,
}: {
  open: boolean
  /** Lookups are off: why Find business can't be pressed. */
  disabledReason?: string | null
  onClose: () => void
  /** Followed (or already followed): open it. */
  onTracked: (business: TrackedBusinessView) => void
  /** A search was made: the spend line reads again. */
  onSpent?: () => void
}) {
  const [name, setName] = React.useState('')
  const [town, setTown] = React.useState('')
  const [place, setPlace] = React.useState<LocalPlaceOption | null>(null)
  const [country, setCountry] = React.useState('us')
  const [busy, setBusy] = React.useState(false)
  const [adding, setAdding] = React.useState<string | null>(null)
  const [townError, setTownError] = React.useState<string | null>(null)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<{ found: LocalBusinessSearchResult; town: string } | null>(null)

  React.useEffect(() => {
    if (!open) return
    setName('')
    setTown('')
    setPlace(null)
    setTownError(null)
    setFormError(null)
    setNotice(null)
    setResult(null)
  }, [open])

  const canFind = !busy && !disabledReason && !!name.trim() && !!town.trim()

  const find = async () => {
    if (!canFind) return
    setBusy(true)
    setTownError(null)
    setFormError(null)
    setNotice(null)
    try {
      const found = await searchBusinesses({ query: name.trim(), place: place?.location_name ?? town.trim(), country })
      setResult({ found, town: place?.label ?? town.trim() })
      if (!found.from_cache) onSpent?.()
    } catch (err) {
      const code = errorCode(err)
      if (code === 'PLACE_NOT_FOUND') setTownError(errorMessage(err))
      else if (code === 'INVALID') setFormError(errorMessage(err))
      else if (code === 'SPEND_LIMIT_REACHED') setNotice(errorMessage(err))
      else if (code && DATA_OFF_CODES.has(code)) {
        setNotice(errorMessage(err))
        onSpent?.()
      } else toast.error('Could not search Google Maps', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setBusy(false)
    }
  }

  const choose = async (listing: LocalBusinessListing) => {
    const key = listing.cid ?? listing.place_id ?? listing.title
    setAdding(key)
    setFormError(null)
    try {
      const business = await trackBusiness(listing, result?.found.country ?? country)
      onClose()
      toast(`Added ${business.title}.`)
      onTracked(business)
    } catch (err) {
      const existing = trackedBusinessOf(err)
      if (existing) {
        onClose()
        toast(errorMessage(err))
        onTracked(existing)
      } else if (errorCode(err) === 'LIMIT_REACHED' || errorCode(err) === 'INVALID') setFormError(errorMessage(err))
      else toast.error('Could not add the business', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setAdding(null)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy && !adding) onClose()
      }}
    >
      <DialogContent aria-label="Add business" data-seo-add-dialog="" className={CONTENT}>
        <DialogHeader className="space-y-0">
          <DialogTitle className="text-sm font-semibold">Add business</DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-relaxed">
            Find the business as Google Maps lists it: its name and the town it is in. Each search is paid for from this workspace’s search data.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="seo-local-name" className="block text-xs text-muted-foreground">
              Business name
            </label>
            <Input
              id="seo-local-name"
              data-seo-local-name=""
              autoFocus
              value={name}
              placeholder="Fernhill Rug Cleaning"
              spellCheck={false}
              onChange={(e) => {
                setName(e.target.value)
                if (formError) setFormError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void find()
                }
              }}
              className="h-8 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="seo-local-town" className="block text-xs text-muted-foreground">
              Town
            </label>
            <div className="flex items-center gap-2">
              <PlacePicker
                id="seo-local-town"
                country={country}
                value={town}
                invalid={!!townError}
                onChange={(next) => {
                  setTown(next)
                  setPlace(null)
                  if (townError) setTownError(null)
                }}
                onPick={(option) => {
                  setPlace(option)
                  setTown(option.label)
                  if (townError) setTownError(null)
                }}
                onEnter={() => void find()}
              />
              <Select
                value={country}
                onValueChange={(v) => {
                  setCountry(v)
                  setPlace(null)
                }}
              >
                <SelectTrigger data-seo-local-country="" aria-label="Country" title="The country the town is in" className={TRIGGER}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {COUNTRIES.map((c) => (
                    <SelectItem key={c.iso} value={c.iso} className="text-xs">
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {townError && (
              <p data-seo-field-error="town" className="text-xs text-destructive">
                {townError}
              </p>
            )}
          </div>
        </div>

        {formError && (
          <p data-seo-field-error="form" className="mt-3 text-xs text-destructive">
            {formError}
          </p>
        )}
        {notice && (
          <p data-seo-banner="notice" className="mt-3 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            {notice}
          </p>
        )}

        {result && <SearchResults result={result.found} town={result.town} adding={adding} onChoose={(l) => void choose(l)} />}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy || !!adding}>
            Cancel
          </Button>
          <Button
            size="sm"
            data-seo-find-business=""
            disabled={!canFind}
            title={disabledReason ?? 'Search Google Maps for this business'}
            onClick={() => void find()}
          >
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Find business
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The candidates a search found, each with "This one"; or the line that says none was. */
function SearchResults({
  result,
  town,
  adding,
  onChoose,
}: {
  result: LocalBusinessSearchResult
  town: string
  adding: string | null
  onChoose: (listing: LocalBusinessListing) => void
}) {
  if (result.rows.length === 0) {
    return (
      <div data-seo-no-results="" className="mt-4 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        <p className="font-medium text-foreground">No business found by that name in {town}</p>
        <p className="mt-0.5">Try the name exactly as Google Maps shows it, or the town it is listed in.</p>
      </div>
    )
  }
  return (
    <div className="mt-4">
      <p className="text-[11px] text-muted-foreground">{count(result.rows.length, 'business', 'businesses')} found</p>
      <ul data-seo-results="" className="mt-1 max-h-72 divide-y divide-border overflow-y-auto">
        {result.rows.map((row, index) => {
          const key = row.cid ?? row.place_id ?? row.title
          const meta = [ratingWords(row.rating), row.review_count ? count(row.review_count, 'review') : null, row.category].filter(Boolean).join(' · ')
          return (
            <li key={`${key}-${index}`} data-seo-result={key} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground" title={row.title}>
                  {row.title}
                </span>
                {row.address && (
                  <span className="block truncate text-xs text-muted-foreground" title={row.address}>
                    {row.address}
                  </span>
                )}
                {meta && <span className="block truncate text-[11px] tabular-nums text-muted-foreground">{meta}</span>}
              </span>
              <Button
                variant="outline"
                size="sm"
                data-seo-choose=""
                className="h-7 shrink-0 text-xs"
                disabled={adding !== null}
                title={`Follow ${row.title}`}
                onClick={() => onChoose(row)}
              >
                {adding === key && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                This one
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** The town field: what is typed, with the matching places of the country listed under it (free). */
function PlacePicker({
  id,
  country,
  value,
  invalid,
  onChange,
  onPick,
  onEnter,
}: {
  id: string
  country: string
  value: string
  invalid: boolean
  onChange: (next: string) => void
  onPick: (option: LocalPlaceOption) => void
  onEnter: () => void
}) {
  const [options, setOptions] = React.useState<LocalPlaceOption[]>([])
  const [loading, setLoading] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(-1)
  const [query, setQuery] = React.useState('')
  const asked = React.useRef(0)
  const listId = `${id}-places`

  // What was typed, read after a pause; a pick (or nothing typed) reads nothing.
  React.useEffect(() => {
    const q = query.trim()
    const ask = ++asked.current
    if (!q) {
      setOptions([])
      setLoading(false)
      return
    }
    const t = setTimeout(() => {
      setLoading(true)
      searchPlaces(country, q)
        .then((next) => {
          if (ask !== asked.current) return
          setOptions(next)
          setActive(next.length > 0 ? 0 : -1)
        })
        .catch(() => {
          if (ask === asked.current) setOptions([])
        })
        .finally(() => {
          if (ask === asked.current) setLoading(false)
        })
    }, PLACES_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query, country])

  const pick = (option: LocalPlaceOption) => {
    asked.current++
    setOptions([])
    setOpen(false)
    setQuery('')
    onPick(option)
  }

  const shown = open && options.length > 0
  return (
    <div className="relative min-w-0 flex-1">
      <Input
        id={id}
        data-seo-local-town=""
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
        aria-invalid={invalid ? true : undefined}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder="Portland, Oregon"
        onChange={(e) => {
          onChange(e.target.value)
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && options.length > 0) {
            e.preventDefault()
            setOpen(true)
            setActive((a) => Math.min(options.length - 1, a + 1))
          } else if (e.key === 'ArrowUp' && options.length > 0) {
            e.preventDefault()
            setActive((a) => Math.max(0, a - 1))
          } else if (e.key === 'Escape' && shown) {
            e.preventDefault()
            e.stopPropagation()
            setOpen(false)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (shown && active >= 0 && options[active]) pick(options[active])
            else onEnter()
          }
        }}
        className="h-8 pr-7 text-sm"
      />
      {loading && <Loader2 className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" aria-label="Looking up towns" />}
      {shown && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Towns"
          data-seo-places=""
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {options.map((option, index) => (
            <li
              key={`${option.location_code}-${index}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              data-seo-place={option.location_code}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(option)
              }}
              onMouseEnter={() => setActive(index)}
              className={cn('cursor-default truncate rounded-sm px-2 py-1.5 text-xs', index === active ? 'bg-muted text-foreground' : 'text-muted-foreground')}
              title={option.label}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
