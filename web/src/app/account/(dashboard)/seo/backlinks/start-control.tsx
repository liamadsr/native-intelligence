'use client'

/**
 * The Backlinks page's start control: the site or page, and "Look up links".
 * The button is the request: it spends unless the same site was looked up in
 * the last 12 hours, and the header's spend line is right there. When the
 * address names a page, a small choice says how far it reaches (that page
 * alone, or everything under it). An address that can't be used is said
 * beside the field, never in a toast.
 */
import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FilterChips } from '../shared/tab-pills'
import { PAGE_SCOPES } from './helpers'

export type PageScope = (typeof PAGE_SCOPES)[number]['value']

export function StartControl({
  site,
  onSite,
  hasPath,
  pageScope,
  onPageScope,
  busy,
  blockedReason,
  error,
  onSubmit,
}: {
  site: string
  onSite: (next: string) => void
  /** The address names a page: the scope choice shows. */
  hasPath: boolean
  pageScope: PageScope
  onPageScope: (next: PageScope) => void
  busy: boolean
  /** Why lookups are off (the button's title), or null. */
  blockedReason: string | null
  error: string | null
  onSubmit: () => void
}) {
  const disabled = busy || !!blockedReason || !site.trim()
  const submit = () => {
    if (!disabled) onSubmit()
  }
  return (
    <div data-seo-start-control="" className="w-full space-y-1.5">
      <label htmlFor="seo-backlinks-site" className="block text-left text-xs text-muted-foreground">
        Website or page address
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="seo-backlinks-site"
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
        <Button
          size="sm"
          data-seo-look-up=""
          className="h-8 shrink-0"
          disabled={disabled}
          title={blockedReason ?? 'Look up who links here: a small charge, unless it was looked up in the last 12 hours'}
          onClick={submit}
        >
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Look up links
        </Button>
      </div>
      {hasPath && (
        <div data-seo-page-scope="" className="flex flex-wrap items-center gap-2">
          <FilterChips
            label="How far the address reaches"
            options={PAGE_SCOPES.map((s) => ({ value: s.value, label: s.label }))}
            value={pageScope}
            onChange={onPageScope}
          />
        </div>
      )}
      {error && (
        <p data-seo-site-error="" className="text-left text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
