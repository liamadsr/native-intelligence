'use client'

/**
 * A business's Reviews tab: its Google reviews, read on request.
 *
 *   Not read yet  a small block and "Read reviews" (it spends: the button is
 *                 the request). Google gathers them in the background, so a
 *                 read can take up to about 45 s: the button says "Reading
 *                 reviews…" meanwhile.
 *   Collecting    Google is still gathering them: a neutral line and Check
 *                 again (asking again costs nothing more).
 *   Read          "20 newest of 128 reviews · 12 without a reply", when it
 *                 was looked up with Refresh, a filter applied here (All /
 *                 Without a reply / 1 to 3 stars), and the reviews as rows:
 *                 stars, who, when, the text (a few lines, Show more), and
 *                 the owner's reply indented under it.
 *
 * Review text and replies are other people's writing: plain text only.
 */
import * as React from 'react'
import { Loader2, MessageSquareText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { GoogleBusinessReview, GoogleBusinessReviewsResult } from '@/lib/seo/local/view'
import { cn } from '@/lib/utils'
import { relativeWhen } from '../ui-helpers'
import { FilterChips } from '../shared/tab-pills'
import { REVIEW_FILTERS, filterReviews, reviewsLine, starParts, type ReviewFilter } from './local-helpers'

/** Where the clamp can't be measured, reviews longer than this get "Show more". */
const LONG_REVIEW = 280

export function ReviewsTab({
  result,
  blocked,
  busy,
  onRead,
}: {
  result: GoogleBusinessReviewsResult | null
  /** Why lookups are off, or null. */
  blocked: string | null
  busy: boolean
  /** Read them (again with `refresh`, which buys a new read). */
  onRead: (refresh: boolean) => void
}) {
  const [filter, setFilter] = React.useState<ReviewFilter>('all')

  if (!result || (!result.data && result.status !== 'collecting')) {
    return (
      <div data-seo-reviews-first-run="" className="mx-auto flex max-w-lg flex-col items-center gap-3 px-1 py-12 text-center">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
          <MessageSquareText className="h-4 w-4" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">See what customers say on Google</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Reads the newest reviews on your Google profile, with your replies, so you can see which still need an answer. Google gathers
            them while you wait, which can take up to a minute. Each read is paid for from this workspace’s search data.
          </p>
        </div>
        <Button size="sm" className="h-8" data-seo-read-reviews="" disabled={!!blocked || busy} title={blocked ?? 'Read the newest Google reviews now'} onClick={() => onRead(false)}>
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {busy ? 'Reading reviews…' : 'Read reviews'}
        </Button>
      </div>
    )
  }

  if (result.status === 'collecting' || !result.data) {
    return (
      <div data-seo-reviews-collecting="" className="flex items-center gap-3 rounded-md border border-border bg-muted/20 px-3 py-2">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">{busy ? 'Reading reviews…' : 'Still collecting. Check again in a moment.'}</p>
        <Button variant="ghost" size="sm" data-seo-check-again="" className="-my-1 h-7 shrink-0 text-xs" disabled={busy} onClick={() => onRead(false)}>
          {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
          Check again
        </Button>
      </div>
    )
  }

  const data = result.data
  const shown = filterReviews(data.reviews, filter)
  const looked = relativeWhen(result.fetched_at)
  return (
    <div data-seo-reviews="">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p data-seo-reviews-line="" className="text-xs tabular-nums text-muted-foreground">
          {reviewsLine(data.reviews.length, data.total_reviews, data.unreplied)}
        </p>
        <div className="flex items-center gap-1">
          <span data-seo-looked-up="" className="text-[11px] text-muted-foreground" title={result.fetched_at}>
            {looked ? `Looked up ${looked}` : 'Looked up'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            data-seo-refresh-reviews=""
            className="h-7 text-xs text-muted-foreground hover:text-foreground"
            disabled={!!blocked || busy}
            title={blocked ?? 'Read them again now (a paid lookup)'}
            onClick={() => onRead(true)}
          >
            {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Refresh
          </Button>
        </div>
      </div>

      {data.reviews.length === 0 ? (
        <p className="py-10 text-center text-xs text-muted-foreground">No reviews on Google yet.</p>
      ) : (
        <>
          <FilterChips className="mt-2" label="Show" options={REVIEW_FILTERS} value={filter} onChange={setFilter} />
          {shown.length === 0 ? (
            <p data-seo-reviews-none="" className="py-10 text-center text-xs text-muted-foreground">
              {filter === 'unreplied' ? 'Every review read has a reply.' : 'No review read has 1 to 3 stars.'}
            </p>
          ) : (
            <ul data-seo-review-list="" className="mt-1 divide-y divide-border">
              {shown.map((review, index) => (
                <ReviewRow key={review.review_id ?? `${review.author}-${index}`} review={review} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

function ReviewRow({ review }: { review: GoogleBusinessReview }) {
  const [open, setOpen] = React.useState(false)
  const stars = starParts(review.rating)
  const when = review.time_ago ?? relativeWhen(review.timestamp)
  const textRef = React.useRef<HTMLParagraphElement>(null)
  // "Show more" only when the clamp cuts the text off; where nothing can be measured, by its length.
  const [long, setLong] = React.useState((review.text?.length ?? 0) > LONG_REVIEW)
  React.useLayoutEffect(() => {
    const el = textRef.current
    if (!el || open) return
    const measure = () => {
      if (el.clientHeight > 0) setLong(el.scrollHeight > el.clientHeight + 1)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, review.text])
  return (
    <li data-seo-review={review.review_id ?? ''} className="py-3">
      <div className="flex min-w-0 items-baseline gap-2">
        {review.rating !== null && (
          <span className="shrink-0 text-xs leading-none" aria-label={`${review.rating} out of 5 stars`} title={`${review.rating} out of 5 stars`}>
            <span className="text-amber-500 dark:text-amber-400">{stars.filled}</span>
            <span className="text-muted-foreground/40">{stars.empty}</span>
          </span>
        )}
        <span className="min-w-0 truncate text-sm font-medium text-foreground" title={review.author ?? undefined}>
          {review.author ?? 'A Google user'}
        </span>
        {when && <span className="shrink-0 text-[11px] text-muted-foreground">{when}</span>}
      </div>
      {review.text && (
        <>
          <p ref={textRef} data-seo-review-text="" className={cn('mt-1 whitespace-pre-line text-sm leading-relaxed text-foreground/90', !open && 'line-clamp-3')}>
            {review.text}
          </p>
          {long && (
            <button
              type="button"
              data-seo-review-more=""
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="-ml-2 mt-0.5 h-6 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            >
              {open ? 'Show less' : 'Show more'}
            </button>
          )}
        </>
      )}
      {review.owner_reply && (
        <div data-seo-owner-reply="" className="ml-4 mt-2 border-l-2 border-border pl-3">
          <p className="text-[11px] font-medium text-muted-foreground">
            Owner’s reply{review.owner_reply_time_ago ? ` · ${review.owner_reply_time_ago}` : ''}
          </p>
          <p className="mt-0.5 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">{review.owner_reply}</p>
        </div>
      )}
    </li>
  )
}
