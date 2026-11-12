'use client'

/**
 * The Competitors page's start control: the site, the market (country and,
 * where a country has more than one, language) and "Look up site". The
 * button is the request: it spends unless the site was looked up in the
 * last 12 hours, and the header's spend line is right there. A site the
 * server can't use is said beside the field, never in a toast.
 */
import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { SeoLocationOption } from '@/lib/seo/keywords/view'
import type { Market } from './api'

const TRIGGER = 'h-8 w-auto min-w-0 gap-1.5 rounded-md px-2.5 text-xs shadow-none'

export function StartControl({
  site,
  onSite,
  market,
  onMarket,
  locations,
  busy,
  blockedReason,
  error,
  onSubmit,
}: {
  site: string
  onSite: (next: string) => void
  market: Market | null
  onMarket: (next: Market) => void
  /** The countries domain data covers; empty while they load (the route's default is used). */
  locations: readonly SeoLocationOption[]
  busy: boolean
  /** Why lookups are off (the button's title), or null. */
  blockedReason: string | null
  error: string | null
  onSubmit: () => void
}) {
  const location = market ? locations.find((l) => l.code === market.location_code) : undefined
  const languages = location?.languages ?? []
  const disabled = busy || !!blockedReason || !site.trim()
  const submit = () => {
    if (!disabled) onSubmit()
  }
  return (
    <div data-seo-start-control="" className="w-full space-y-1.5">
      <label htmlFor="seo-competitors-site" className="block text-left text-xs text-muted-foreground">
        Website address
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="seo-competitors-site"
          data-seo-site=""
          value={site}
          placeholder="example.com"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onSite(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          className="h-8 min-w-48 flex-1 basis-56 text-sm"
        />
        {locations.length > 0 && market && (
          <div className="flex items-center gap-2">
            <Select
              value={String(market.location_code)}
              onValueChange={(v) => {
                const next = locations.find((l) => String(l.code) === v)
                if (next) onMarket({ location_code: next.code, language_code: next.default_language })
              }}
            >
              <SelectTrigger data-seo-country="" aria-label="Country" title="The country whose Google results to read" className={TRIGGER}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {locations.map((l) => (
                  <SelectItem key={l.code} value={String(l.code)} className="text-xs">
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {languages.length > 1 && (
              <Select value={market.language_code} onValueChange={(v) => onMarket({ location_code: market.location_code, language_code: v })}>
                <SelectTrigger data-seo-language="" aria-label="Language" className={TRIGGER}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {languages.map((l) => (
                    <SelectItem key={l.code} value={l.code} className="text-xs">
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}
        <Button
          size="sm"
          data-seo-look-up=""
          className="h-8 shrink-0"
          disabled={disabled}
          title={blockedReason ?? 'Look the site up: a small charge, unless it was looked up in the last 12 hours'}
          onClick={submit}
        >
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Look up site
        </Button>
      </div>
      {error && (
        <p data-seo-site-error="" className="text-left text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
