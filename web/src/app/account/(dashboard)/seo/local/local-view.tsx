'use client'

/**
 * SEO's Local page: the businesses the workspace follows on Google Maps, and
 * one business opened as a card place (./business-detail.tsx). Drawn by the
 * page card (components/chat-cards/pages/seo-local-card.tsx), which keeps
 * where the person is: moves inside the page are card places, never the
 * router.
 *
 *   First run  no business yet: what the page does, and Add business. With
 *              lookups off, the "not set up / paid plan" notice instead.
 *   Index      a row per business: its name, address, rating and reviews,
 *              its newest scan's headline as neutral chips, and a status
 *              word while a scan runs (the list is read again every 3 s
 *              then). "Add business" opens the dialog; it waits at the cap,
 *              saying why.
 *
 * Reads: GET /api/account/seo/local/businesses on mount, with a request
 * counter so a slow answer never overwrites a newer one.
 */
import * as React from 'react'
import { MapPin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageTitle } from '@/components/views/page-title'
import type { LocalRankGridDetail, TrackedBusinessView } from '@/lib/seo/local/view'
import { ViewHeader } from '../../views/view-header'
import { CenteredError, CenteredLoader } from '../load-states'
import { SeoDataNotice, SeoSpendLine, buyBlockedReason, useSeoData, type SeoDataState } from '../shared/data-status'
import { fetchBusinesses, type BusinessListPayload } from './api'
import { AddBusinessDialog } from './add-business'
import { BusinessDetail } from './business-detail'
import { businessSubline, gridsOf, latestCompletedScan, liveScanOf, scanHeadline } from './local-helpers'
import { useLocalPoll } from './use-local-poll'

export interface LocalPageProps {
  /** The business open (the card's place), or null for the index. */
  businessId: string | null
  /** Its name, while the business itself loads. */
  businessLabel?: string
  /** The business's tab (PAGE_KINDS.seo_local.tabs). */
  tab?: string
  onOpenBusiness: (business: { id: string; title: string }) => void
  onCloseBusiness: () => void
  onTab: (tab: string) => void
  /** The card header's count: the businesses there are, on the index. */
  onCount?: (count: number | null) => void
}

export function LocalPage(props: LocalPageProps) {
  const seo = useSeoData()
  if (props.businessId) {
    return (
      <BusinessDetail
        key={props.businessId}
        businessId={props.businessId}
        label={props.businessLabel}
        tab={props.tab}
        seo={seo}
        onTab={props.onTab}
        onBack={props.onCloseBusiness}
        onCount={props.onCount}
      />
    )
  }
  return <BusinessIndex seo={seo} onOpenBusiness={props.onOpenBusiness} onCount={props.onCount} />
}

const anyLive = (payload: BusinessListPayload) => !!liveScanOf(payload.grids)

function BusinessIndex({ seo, onOpenBusiness, onCount }: { seo: SeoDataState } & Pick<LocalPageProps, 'onOpenBusiness' | 'onCount'>) {
  const [payload, setPayload] = React.useState<BusinessListPayload | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const asked = React.useRef(0)

  const load = React.useCallback(async () => {
    const ask = ++asked.current
    setLoading(true)
    setError(null)
    try {
      const next = await fetchBusinesses()
      if (ask !== asked.current) return
      setPayload(next)
    } catch {
      if (ask === asked.current) setError('Could not load your businesses.')
    } finally {
      if (ask === asked.current) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const businesses = React.useMemo(() => payload?.businesses ?? [], [payload])
  React.useEffect(() => {
    onCount?.(payload ? businesses.length : null)
  }, [onCount, payload, businesses.length])

  // A scan running anywhere: the list again every 3 s, so its row's word and chips follow it.
  const live = !!payload && anyLive(payload)
  useLocalPoll('businesses', live, fetchBusinesses, anyLive, (next) => {
    asked.current++
    setPayload(next)
    if (!anyLive(next)) seo.refresh()
  })

  const closeDialog = React.useCallback(() => setDialogOpen(false), [])
  const opened = React.useCallback((b: TrackedBusinessView) => onOpenBusiness({ id: b.id, title: b.title }), [onOpenBusiness])

  if (!payload) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ViewHeader title={<PageTitle label="Local" as="h1" />} />
        {error && !loading ? <CenteredError text={error} onRetry={() => void load()} /> : <CenteredLoader />}
      </div>
    )
  }

  const view = seo.view
  const blocked = buyBlockedReason(view)
  const empty = businesses.length === 0
  const atCap = businesses.length >= payload.limits.max_businesses
  const addTitle =
    blocked ?? (atCap ? `A workspace can follow ${payload.limits.max_businesses} businesses. Remove one to add another.` : 'Find a business on Google Maps and follow it')

  return (
    <div data-seo-index="" className="flex h-full min-h-0 flex-col">
      <ViewHeader
        title={<PageTitle label="Local" as="h1" />}
        actions={
          <>
            <SeoSpendLine view={view} className="mr-2" />
            {/* With no business the first-run block carries the button. */}
            {!empty && (
              <Button size="sm" className="h-8" data-seo-add-business="" disabled={!!blocked || atCap} title={addTitle} onClick={() => setDialogOpen(true)}>
                Add business
              </Button>
            )}
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {empty ? (
          blocked && view ? (
            <SeoDataNotice view={view} what="Local search data" />
          ) : (
            <FirstRun onAdd={() => setDialogOpen(true)} />
          )
        ) : (
          <ul className="divide-y divide-border">
            {businesses.map((business) => (
              <BusinessRow key={business.id} business={business} grids={gridsOf(payload.grids, business.id)} onOpen={() => opened(business)} />
            ))}
          </ul>
        )}
      </div>
      <AddBusinessDialog open={dialogOpen} disabledReason={blocked} onClose={closeDialog} onTracked={opened} onSpent={seo.refresh} />
    </div>
  )
}

function FirstRun({ onAdd }: { onAdd: () => void }) {
  return (
    <div data-seo-first-run="" className="mx-auto flex max-w-lg flex-col items-center gap-3 px-1 py-16 text-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
        <MapPin className="h-4 w-4" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">See how you show up on Google Maps</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Find your business as Google lists it, then check where it appears on the map for the searches that matter to you, street
          by street across your town. Your reviews and your Google profile are here too. Each lookup is paid for from this
          workspace’s search data.
        </p>
      </div>
      <Button size="sm" className="h-8" data-seo-add-business="" onClick={onAdd}>
        Add business
      </Button>
    </div>
  )
}

/** One business on the index: its name and details, its newest scan's headline, or a word while a scan runs. */
function BusinessRow({ business, grids, onOpen }: { business: TrackedBusinessView; grids: LocalRankGridDetail[]; onOpen: () => void }) {
  const live = liveScanOf(grids)
  const chips = live ? [] : scanHeadline(latestCompletedScan(grids)?.summary ?? null)
  const subline = businessSubline(business)
  return (
    <li data-seo-business-row={business.id}>
      <button type="button" onClick={onOpen} title={`Open ${business.title}`} className="group flex w-full items-center gap-3 py-2 text-left">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground group-hover:underline">{business.title}</span>
          {subline && (
            <span data-seo-business-subline="" className="block truncate text-xs tabular-nums text-muted-foreground">
              {subline}
            </span>
          )}
        </span>
        {live && (
          <span data-seo-business-status="" className="shrink-0 text-xs text-muted-foreground">
            Scanning
          </span>
        )}
        {chips.length > 0 && (
          <span className="flex shrink-0 items-center gap-1">
            {chips.map((chip) => (
              <span
                key={chip}
                data-seo-scan-chip=""
                className="inline-flex items-center whitespace-nowrap rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground"
              >
                {chip}
              </span>
            ))}
          </span>
        )}
      </button>
    </li>
  )
}
