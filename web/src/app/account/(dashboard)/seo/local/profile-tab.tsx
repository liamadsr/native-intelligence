'use client'

/**
 * A business's Profile tab: the stored Google Business Profile read, as
 * Google shows it.
 *
 *   Never read     a small block and "Read profile" (it spends: the button
 *                  is the request).
 *   Read           when it was looked up, with Refresh (buys it again); the
 *                  rating (the average, the count, and stars by count as
 *                  thin bars); then what the profile says, as plain rows
 *                  (category, address, phone, website, hours, claimed,
 *                  photos) and its description as plain text.
 *   No profile     Google has none for this business: a line, and Refresh.
 *
 * Everything here is Google's text about another party's listing: plain
 * text only, the website a link out in a new tab.
 */
import * as React from 'react'
import { Loader2, Store } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { GoogleBusinessProfile, GoogleBusinessProfileResult } from '@/lib/seo/local/view'
import { cn } from '@/lib/utils'
import { count, relativeWhen } from '../ui-helpers'
import { formatAverage, httpUrl, ratingBars, starParts, weeklyHours } from './local-helpers'

export function ProfileTab({
  profile,
  blocked,
  busy,
  onRead,
}: {
  profile: GoogleBusinessProfileResult | null
  /** Why lookups are off, or null. */
  blocked: string | null
  busy: boolean
  onRead: () => void
}) {
  if (!profile) {
    return (
      <div data-seo-profile-first-run="" className="mx-auto flex max-w-lg flex-col items-center gap-3 px-1 py-12 text-center">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Store className="h-4 w-4" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Read the profile as Google shows it</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Your Google Business Profile is the panel people see beside the map: your category, hours, phone, website, photos and
            rating. Reading it is one lookup, paid for from this workspace’s search data.
          </p>
        </div>
        <Button size="sm" className="h-8" data-seo-read-profile="" disabled={!!blocked || busy} title={blocked ?? 'Read the business’s Google profile now'} onClick={onRead}>
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Read profile
        </Button>
      </div>
    )
  }

  const looked = relativeWhen(profile.fetched_at)
  const stored = (
    <div className="flex items-center justify-between gap-2">
      <span data-seo-looked-up="" className="text-[11px] text-muted-foreground" title={profile.fetched_at}>
        {looked ? `Looked up ${looked}` : 'Looked up'}
      </span>
      <Button
        variant="ghost"
        size="sm"
        data-seo-refresh-profile=""
        className="-my-1 h-7 text-xs text-muted-foreground hover:text-foreground"
        disabled={!!blocked || busy}
        title={blocked ?? 'Read it again now (a paid lookup)'}
        onClick={onRead}
      >
        {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
        Refresh
      </Button>
    </div>
  )

  const p = profile.profile
  if (!p) {
    return (
      <div data-seo-profile="none" className="space-y-3">
        {stored}
        <p className="py-8 text-center text-xs text-muted-foreground">Google has no profile for this business.</p>
      </div>
    )
  }

  return (
    <div data-seo-profile="" className="@container space-y-5">
      {stored}
      <RatingBlock profile={p} />
      <ProfileRows profile={p} />
      {p.description && (
        <div>
          <p className="text-[11px] font-medium text-foreground">About</p>
          <p data-seo-profile-description="" className="mt-1 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
            {p.description}
          </p>
        </div>
      )}
    </div>
  )
}

/** The average, the count, and the stars by count as five thin bars. */
function RatingBlock({ profile }: { profile: GoogleBusinessProfile }) {
  const bars = ratingBars(profile.rating_distribution)
  if (profile.rating === null && bars.length === 0) return null
  const stars = starParts(profile.rating)
  return (
    <div data-seo-rating="" className="flex flex-col gap-4 rounded-lg border px-4 py-3 @md:flex-row @md:items-center @md:gap-8">
      {profile.rating !== null && (
        <div className="shrink-0">
          <p className="text-2xl font-semibold tabular-nums">{formatAverage(profile.rating)}</p>
          <p className="text-sm leading-none" aria-label={`${formatAverage(profile.rating)} out of 5 stars`}>
            <span className="text-amber-500 dark:text-amber-400">{stars.filled}</span>
            <span className="text-muted-foreground/40">{stars.empty}</span>
          </p>
          {profile.review_count !== null && <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">{count(profile.review_count, 'review')}</p>}
        </div>
      )}
      {bars.length > 0 && (
        <ul data-seo-rating-bars="" className="w-full min-w-0 max-w-md flex-1 space-y-1" aria-label="Reviews by stars">
          {bars.map((bar) => (
            <li key={bar.stars} data-seo-rating-bar={bar.stars} className="flex items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
              <span className="w-6 shrink-0">{bar.stars} ★</span>
              <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-amber-500 dark:bg-amber-400" style={{ width: `${bar.share * 100}%`, minWidth: bar.count > 0 ? 2 : 0 }} />
              </span>
              <span className="w-12 shrink-0 text-right">{bar.count.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** What the profile says, as plain rows; a row with nothing to say is left out. */
function ProfileRows({ profile }: { profile: GoogleBusinessProfile }) {
  const hours = weeklyHours(profile.hours)
  const categories = [profile.category, ...profile.additional_categories].filter((c): c is string => !!c)
  const rows: Array<{ key: string; label: string; title?: string; value: React.ReactNode }> = []
  if (categories.length) rows.push({ key: 'category', label: 'Category', value: categories.join(', ') })
  if (profile.address) rows.push({ key: 'address', label: 'Address', value: profile.address })
  if (profile.phone) rows.push({ key: 'phone', label: 'Phone', value: <span className="tabular-nums">{profile.phone}</span> })
  const website = httpUrl(profile.website)
  if (profile.website)
    rows.push({
      key: 'website',
      label: 'Website',
      value: website ? (
        <a href={website} target="_blank" rel="noreferrer noopener" title={website} className="block truncate text-foreground underline-offset-2 hover:underline">
          {profile.domain ?? profile.website}
        </a>
      ) : (
        <span className="block truncate">{profile.website}</span>
      ),
    })
  if (hours.length)
    rows.push({
      key: 'hours',
      label: 'Hours',
      value: (
        <ul className="space-y-0.5">
          {hours.map((h) => (
            <li key={h.days} className="flex gap-3 tabular-nums">
              <span className="w-16 shrink-0 text-muted-foreground">{h.days}</span>
              <span>{h.hours}</span>
            </li>
          ))}
        </ul>
      ),
    })
  if (profile.is_claimed !== null)
    rows.push({
      key: 'claimed',
      label: 'Claimed',
      title: 'Whether the owner has verified this listing with Google, so they can edit it and answer reviews',
      value: profile.is_claimed ? 'Yes, by the owner' : 'Not claimed',
    })
  if (profile.total_photos !== null) rows.push({ key: 'photos', label: 'Photos', value: <span className="tabular-nums">{profile.total_photos.toLocaleString()}</span> })
  if (profile.current_status === 'temporarily_closed') rows.push({ key: 'status', label: 'Status', value: 'Temporarily closed' })
  if (rows.length === 0) return null
  return (
    <dl data-seo-profile-rows="" className="divide-y divide-border">
      {rows.map((row) => (
        <div key={row.key} data-seo-profile-row={row.key} className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-3 py-2">
          <dt className={cn('text-xs text-muted-foreground', row.title && 'cursor-help underline decoration-dotted underline-offset-2')} title={row.title}>
            {row.label}
          </dt>
          <dd className="min-w-0 text-sm text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}
