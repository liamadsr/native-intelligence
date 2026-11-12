'use client'

/**
 * The Keywords page's small controls: the market picker (country, then the
 * language when the country has several; the house Select), a compact select
 * for filters and sort, and the filter field (the Files card's search look).
 */
import * as React from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { SeoMarketOptions } from '@/lib/seo/keywords/view'
import { cn } from '@/lib/utils'
import type { Market } from './keyword-helpers'

export function MarketPicker({
  options,
  value,
  onChange,
  disabled,
}: {
  options: SeoMarketOptions
  value: Market
  onChange: (next: Market) => void
  disabled?: boolean
}) {
  const location = options.locations.find((l) => l.code === value.location_code) ?? null
  const languages = location?.languages ?? []
  return (
    <>
      <Select
        value={String(value.location_code)}
        disabled={disabled}
        onValueChange={(code) => {
          const next = options.locations.find((l) => String(l.code) === code)
          if (next) onChange({ location_code: next.code, language_code: next.default_language })
        }}
      >
        <SelectTrigger data-kw-country="" aria-label="Country" title="Where the searches are made" className="h-8 w-auto max-w-44 shrink-0 gap-1.5 text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {options.locations.map((l) => (
            <SelectItem key={l.code} value={String(l.code)}>
              {l.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {languages.length > 1 && (
        <Select value={value.language_code} disabled={disabled} onValueChange={(code) => onChange({ ...value, language_code: code })}>
          <SelectTrigger data-kw-language="" aria-label="Language" title="The language the searches are in" className="h-8 w-auto max-w-36 shrink-0 gap-1.5 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {languages.map((l) => (
              <SelectItem key={l.code} value={l.code}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </>
  )
}

/** A compact select above a list (a filter, the sort). */
export function SmallSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  attr,
  className,
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (next: T) => void
  label: string
  attr: string
  className?: string
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)}>
      <SelectTrigger {...{ [attr]: value }} aria-label={label} className={cn('h-7 w-auto shrink-0 gap-1.5 rounded-lg px-2.5 text-xs shadow-none', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The filter field: a search icon and a small input. */
export function FilterField({ value, onChange, placeholder, attr, className }: { value: string; onChange: (next: string) => void; placeholder: string; attr: string; className?: string }) {
  return (
    <div className={cn('relative w-48 min-w-0', className)}>
      <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} {...{ [attr]: '' }} className="h-7 pl-7 text-xs" />
    </div>
  )
}
