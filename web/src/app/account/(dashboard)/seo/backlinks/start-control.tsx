'use client'

/**
 * The Backlinks page's start control: the site or page, and "Look up links".
 * The button is the request: it spends unless the same site was looked up in
 * the last 12 hours, and the header's spend line is right there. When the
 * address names a page, a small choice says how far it reaches (that page
 * alone, or everything under it). An address that can't be used is said
 * beside the field, never in a toast.
 *
 * In a card (`header`) the field and the press are the card header's (Liam,
 * 11-23: "all the SEO pages"): a 24px field named for the old label and
 * "Look up". The page keeps the reach choice and the field's error at its
 * top (PageScopeChoice): they come and go with what is typed.
 */
import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { SEO_HEADER_FIELD, SeoHeaderForm, SeoHeaderSubmit } from '../shared/header-controls'
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
  header,
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
  /** Drawn in the card's header: the field and the press alone. */
  header?: boolean
}) {
  const disabled = busy || !!blockedReason || !site.trim()
  const submit = () => {
    if (!disabled) onSubmit()
  }
  if (header) {
    return (
      <SeoHeaderForm label="Look up links" onSubmit={submit} data-seo-start-control="header">
        <input
          data-seo-site=""
          value={site}
          placeholder="example.com"
          aria-label="Website or page address"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onSite(e.target.value)}
          className={SEO_HEADER_FIELD}
        />
        <SeoHeaderSubmit
          data-seo-look-up=""
          busy={busy}
          disabled={disabled}
          title={blockedReason ?? 'Look up who links here: a small charge, unless it was looked up in the last 12 hours'}
        >
          Look up
        </SeoHeaderSubmit>
      </SeoHeaderForm>
    )
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
      <PageScopeChoice hasPath={hasPath} pageScope={pageScope} onPageScope={onPageScope} error={error} />
    </div>
  )
}

/** Under the field: how far a page's address reaches (when it names a page), and the field's error. */
export function PageScopeChoice({
  hasPath,
  pageScope,
  onPageScope,
  error,
  className,
}: {
  hasPath: boolean
  pageScope: PageScope
  onPageScope: (next: PageScope) => void
  error: string | null
  className?: string
}) {
  if (!hasPath && !error) return null
  return (
    <div className={cn('space-y-1.5', className)}>
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
