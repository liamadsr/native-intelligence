'use client'

/**
 * One tracked business (the Local card's `seo_local_business` place): the
 * crumb back to the businesses and its name, a quiet line of where it is and
 * how it is rated, then three tabs, the card's tabs:
 *
 *   Map rankings  its rank grids: where it shows on Google Maps across the
 *                 town, point by point (./grid-tab.tsx)
 *   Profile       the stored Google Business Profile read (./profile-tab.tsx)
 *   Reviews       its Google reviews, read on request (./reviews-tab.tsx);
 *                 what was read stays while the tabs change
 *
 * The "…" menu removes the business (ConfirmDialog, never window.confirm).
 * A spend limit or lookups turning out to be off is a neutral banner under
 * the header: the page stays usable.
 */
import * as React from 'react'
import { MoreHorizontal, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PageTitle } from '@/components/views/page-title'
import type { GoogleBusinessReviewsResult } from '@/lib/seo/local/view'
import { cn } from '@/lib/utils'
import { ViewHeader } from '../../views/view-header'
import { SeoRequestError, errorCode, errorMessage } from '../api'
import { CenteredError, CenteredLoader } from '../load-states'
import { SeoSpendLine, buyBlockedReason, type SeoDataState } from '../shared/data-status'
import { TabPills } from '../shared/tab-pills'
import { DATA_OFF_CODES, fetchBusiness, readReviews, refreshProfile, removeBusiness, type BusinessDetailPayload } from './api'
import { GridTab } from './grid-tab'
import { businessLine } from './local-helpers'
import { MENU_ITEM, NoticeBanner } from './parts'
import { ProfileTab } from './profile-tab'
import { ReviewsTab } from './reviews-tab'

export const BUSINESS_TABS = ['grid', 'profile', 'reviews'] as const
type BusinessTab = (typeof BUSINESS_TABS)[number]

export function BusinessDetail({
  businessId,
  label,
  tab,
  seo,
  onTab,
  onBack,
  onCount,
}: {
  businessId: string
  label?: string
  tab?: string
  seo: SeoDataState
  onTab: (tab: string) => void
  onBack: () => void
  onCount?: (count: number | null) => void
}) {
  const [detail, setDetail] = React.useState<BusinessDetailPayload | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const [reviews, setReviews] = React.useState<GoogleBusinessReviewsResult | null>(null)
  const [reading, setReading] = React.useState(false)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [confirmRemove, setConfirmRemove] = React.useState(false)
  const [removing, setRemoving] = React.useState(false)
  const asked = React.useRef(0)

  React.useEffect(() => {
    onCount?.(null)
  }, [onCount])

  const load = React.useCallback(async () => {
    const ask = ++asked.current
    setLoading(true)
    setError(null)
    try {
      const next = await fetchBusiness(businessId)
      if (ask !== asked.current) return
      setDetail(next)
    } catch (err) {
      if (ask === asked.current) setError(err instanceof SeoRequestError && err.apiError.status === 404 ? 'This business is no longer here.' : 'Could not load the business.')
    } finally {
      if (ask === asked.current) setLoading(false)
    }
  }, [businessId])

  React.useEffect(() => {
    void load()
  }, [load])

  const blocked = buyBlockedReason(seo.view)

  /** A refusal that is not an error, said in the banner; true when it was one. */
  const refused = React.useCallback(
    (err: unknown): boolean => {
      const code = errorCode(err)
      if (code === 'SPEND_LIMIT_REACHED') {
        setNotice(errorMessage(err))
        return true
      }
      if (code && DATA_OFF_CODES.has(code)) {
        setNotice(errorMessage(err))
        seo.refresh()
        return true
      }
      return false
    },
    [seo],
  )

  const readProfile = async () => {
    if (blocked || refreshing) return
    setRefreshing(true)
    setNotice(null)
    try {
      const next = await refreshProfile(businessId)
      asked.current++
      setDetail(next)
      seo.refresh()
    } catch (err) {
      if (!refused(err)) toast.error('Could not read the profile', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setRefreshing(false)
    }
  }

  const loadReviews = async (refresh: boolean) => {
    if (reading) return
    setReading(true)
    setNotice(null)
    try {
      const next = await readReviews(businessId, { refresh })
      setReviews(next)
      if (!next.from_cache) seo.refresh()
    } catch (err) {
      if (!refused(err)) toast.error('Could not read the reviews', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setReading(false)
    }
  }

  const remove = async () => {
    setRemoving(true)
    try {
      await removeBusiness(businessId)
      setConfirmRemove(false)
      toast(`Removed ${detail?.business.title ?? 'the business'}.`)
      onBack()
    } catch (err) {
      setConfirmRemove(false)
      toast.error('Could not remove the business', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setRemoving(false)
    }
  }

  const business = detail?.business ?? null
  const name = business?.title ?? label ?? 'Business'
  const activeTab: BusinessTab = tab && (BUSINESS_TABS as readonly string[]).includes(tab) ? (tab as BusinessTab) : BUSINESS_TABS[0]

  const header = (
    <ViewHeader
      className="gap-3"
      title={
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <PageTitle label="Local" onClick={onBack} />
          <h1 className="min-w-0 truncate text-sm font-semibold" title={name}>
            {name}
          </h1>
        </div>
      }
      actions={
        business ? (
          <>
            <SeoSpendLine view={seo.view} className="mr-1 hidden @lg/local:inline" />
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" data-seo-business-menu="" className="h-8 w-8 text-muted-foreground hover:text-foreground" title="More" aria-label="More">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-52 p-1.5">
                <button
                  type="button"
                  data-seo-remove-business=""
                  className={cn(MENU_ITEM, 'text-destructive')}
                  onClick={() => {
                    setMenuOpen(false)
                    setConfirmRemove(true)
                  }}
                >
                  <Trash2 className="h-3 w-3 shrink-0" />
                  Remove business
                </button>
              </PopoverContent>
            </Popover>
          </>
        ) : null
      }
    />
  )

  if (!detail || !business) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        {error && !loading ? <CenteredError text={error} onRetry={() => void load()} /> : <CenteredLoader />}
      </div>
    )
  }

  const line = businessLine(business)
  return (
    <div data-seo-business={business.id} className="@container/local flex h-full min-h-0 flex-col">
      {header}
      {line && (
        <p data-seo-business-line="" className="-mt-1 truncate px-5 pb-2 text-xs tabular-nums text-muted-foreground" title={line}>
          {line}
        </p>
      )}
      {notice && <NoticeBanner text={notice} className="mx-5 mb-2" />}

      <div className="@container min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <TabPills
          className="mt-1"
          label="Business"
          tabs={[
            { id: 'grid', label: 'Map rankings', count: detail.grids.length > 1 ? detail.grids.length : undefined },
            { id: 'profile', label: 'Profile' },
            { id: 'reviews', label: 'Reviews', count: reviews?.data?.reviews.length },
          ]}
          value={activeTab}
          onChange={onTab}
        />
        <div className="mt-4">
          {activeTab === 'profile' ? (
            <ProfileTab profile={detail.profile} blocked={blocked} busy={refreshing} onRead={() => void readProfile()} />
          ) : activeTab === 'reviews' ? (
            <ReviewsTab result={reviews} blocked={blocked} busy={reading} onRead={(refresh) => void loadReviews(refresh)} />
          ) : (
            <GridTab business={business} grids={detail.grids} seo={seo} blocked={blocked} onGridsChanged={() => void load()} />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={(next) => {
          if (!removing) setConfirmRemove(next)
        }}
        title={`Remove ${business.title}?`}
        description="Its rank grids and scans are removed. This cannot be undone."
        confirmLabel="Remove"
        busy={removing}
        onConfirm={() => void remove()}
      />
    </div>
  )
}
