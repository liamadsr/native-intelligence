'use client'

/**
 * SEO's Search performance page: what Google Search Console and Google
 * Analytics know about how people find the workspace's site. Drawn by the
 * page card (components/chat-cards/pages/seo-search-card.tsx), which keeps
 * the tab; the period, the "contains" filter and the pickers are transient.
 * Google's data is free: no spend line, no lookups, no cost dialogs. The
 * page's gate is the Google connection instead.
 *
 *   Setup      from GET …/google/status (it asks Google, up to 20 s: the
 *              loader shows meanwhile): connect Search Console, choose a
 *              site (the one matching the workspace's website preselected),
 *              or the connection it reads through needs signing in again.
 *   Ready      "<site> · chosen by <name>", then four tabs (the card's):
 *              Queries, Pages (./performance-tab.tsx), Opportunities
 *              (./opportunities-tab.tsx) and Analytics (./analytics-tab.tsx,
 *              optional, with its own small setup block).
 *   Header     the period (7 days to 12 months, default 28) and the "…" menu:
 *              change the site, change the Analytics property, stop reading
 *              this site (ConfirmDialog).
 *
 * Connecting goes through the app's one connect flow (useConnectProvider);
 * its return re-reads the status. A read that finds the choice gone
 * (NOT_CONNECTED, NO_SOURCE) re-reads it too.
 */
import * as React from 'react'
import { ArrowLeftRight, BarChart3, MoreHorizontal, Unplug } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PageTitle } from '@/components/views/page-title'
import { useConnectProvider } from '@/lib/integrations/use-connect-provider'
import type { GoogleProduct, GoogleSeoStatus } from '@/lib/seo/google/view'
import { ViewHeader } from '../../views/view-header'
import { errorMessage } from '../api'
import { CenteredError, CenteredLoader } from '../load-states'
import { FilterChips, TabPills } from '../shared/tab-pills'
import { clearSite, fetchGoogleStatus } from './api'
import { AnalyticsTab } from './analytics-tab'
import { DEFAULT_PERIOD, SEARCH_PERIODS, isMine, siteLabel, type SearchPeriod } from './helpers'
import { OpportunitiesTab } from './opportunities-tab'
import { PerformanceTab } from './performance-tab'
import { ChoosePicker, ConnectBlock, ReconnectBlock, type ConnectFn } from './setup'

export const SEARCH_TABS = ['queries', 'pages', 'opportunities', 'analytics'] as const
export type SearchTab = (typeof SEARCH_TABS)[number]

const TAB_LABEL: Record<SearchTab, string> = {
  queries: 'Queries',
  pages: 'Pages',
  opportunities: 'Opportunities',
  analytics: 'Analytics',
}

export interface SearchPerformanceViewProps {
  /** The card's tab (PAGE_KINDS.seo_search.tabs). */
  tab?: string
  onTab: (tab: string) => void
  onCount?: (count: number | null) => void
}

const MENU_ITEM =
  'flex w-full items-center gap-1.5 rounded-2xl px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent'

export function SearchPerformancePage({ tab, onTab, onCount }: SearchPerformanceViewProps) {
  const [status, setStatus] = React.useState<GoogleSeoStatus | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [period, setPeriod] = React.useState<SearchPeriod>(DEFAULT_PERIOD)
  const [picking, setPicking] = React.useState<GoogleProduct | null>(null)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false)
  const [disconnecting, setDisconnecting] = React.useState(false)
  const asked = React.useRef(0)

  React.useEffect(() => {
    onCount?.(null)
  }, [onCount])

  const load = React.useCallback(async () => {
    const ask = ++asked.current
    setLoading(true)
    setError(null)
    try {
      const next = await fetchGoogleStatus()
      if (ask !== asked.current) return
      setStatus(next)
    } catch {
      if (ask === asked.current) setError('Could not load your Google connections.')
    } finally {
      if (ask === asked.current) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const { connect: startConnect, connectingId } = useConnectProvider({ origin: 'panel', onReturn: () => void load() })
  const connect: ConnectFn = React.useCallback(
    (product, loginHint) => void startConnect('google', product, loginHint ? { loginHint } : undefined),
    [startConnect],
  )
  const connecting = connectingId !== null
  const chooseSite = React.useCallback(() => setPicking('search_console'), [])
  const chooseProperty = React.useCallback(() => setPicking('analytics'), [])
  const reread = React.useCallback(() => void load(), [load])
  const chosen = React.useCallback(() => {
    setPicking(null)
    void load()
  }, [load])

  const sc = status?.search_console ?? null
  const ready = sc?.state === 'ready' && !!sc.source
  const activeTab: SearchTab = tab && (SEARCH_TABS as readonly string[]).includes(tab) ? (tab as SearchTab) : 'queries'

  const disconnect = async () => {
    const site = sc?.source ? siteLabel(sc.source.site_url) : 'this site'
    setDisconnecting(true)
    try {
      await clearSite()
      setConfirmDisconnect(false)
      toast(`Stopped reading ${site} here.`)
      void load()
    } catch (err) {
      toast.error('Could not disconnect the site', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setDisconnecting(false)
    }
  }

  const header = (
    <ViewHeader
      title={<PageTitle label="Search performance" as="h1" />}
      actions={
        ready && status && !picking ? (
          <>
            <FilterChips options={SEARCH_PERIODS} value={period} onChange={setPeriod} label="Period" className="flex-nowrap" />
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-seo-search-menu=""
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  title="More"
                  aria-label="More"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-56 p-1.5">
                <button
                  type="button"
                  data-seo-search-change-site=""
                  onClick={() => {
                    setMenuOpen(false)
                    setPicking('search_console')
                  }}
                  className={`${MENU_ITEM} text-foreground`}
                >
                  <ArrowLeftRight className="h-3 w-3 shrink-0" />
                  Change site
                </button>
                <button
                  type="button"
                  data-seo-search-change-property=""
                  onClick={() => {
                    setMenuOpen(false)
                    setPicking('analytics')
                  }}
                  className={`${MENU_ITEM} text-foreground`}
                >
                  <BarChart3 className="h-3 w-3 shrink-0" />
                  {status.analytics.source ? 'Change Analytics property' : 'Choose Analytics property'}
                </button>
                <button
                  type="button"
                  data-seo-search-disconnect=""
                  onClick={() => {
                    setMenuOpen(false)
                    setConfirmDisconnect(true)
                  }}
                  className={`${MENU_ITEM} text-destructive`}
                >
                  <Unplug className="h-3 w-3 shrink-0" />
                  Disconnect this site
                </button>
              </PopoverContent>
            </Popover>
          </>
        ) : null
      }
    />
  )

  if (!status || !sc) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        {error && !loading ? <CenteredError text={error} onRetry={() => void load()} /> : <CenteredLoader />}
      </div>
    )
  }

  let body: React.ReactNode
  if (picking) {
    body =
      picking === 'search_console' ? (
        <ChoosePicker data={{ product: 'search_console', status: sc }} connecting={connecting} onConnect={connect} onChosen={chosen} onCancel={() => setPicking(null)} />
      ) : (
        <ChoosePicker data={{ product: 'analytics', status: status.analytics }} connecting={connecting} onConnect={connect} onChosen={chosen} onCancel={() => setPicking(null)} />
      )
  } else if (sc.state === 'not_connected') {
    body = <ConnectBlock product="search_console" busy={connecting} onConnect={connect} />
  } else if (sc.state === 'choose' || !sc.source) {
    body = <ChoosePicker data={{ product: 'search_console', status: sc }} connecting={connecting} onConnect={connect} onChosen={chosen} />
  } else if (sc.state === 'needs_reconnect') {
    body = (
      <ReconnectBlock
        product="search_console"
        name={sc.source.chosen_by_name}
        isYou={isMine(sc.source.account_id, sc.my_accounts)}
        email={sc.source.account_email}
        connecting={connecting}
        onConnect={connect}
        onChoose={chooseSite}
      />
    )
  } else {
    const mine = isMine(sc.source.account_id, sc.my_accounts)
    const by = mine ? 'you' : sc.source.chosen_by_name
    body = (
      <>
        <p data-seo-search-site="" className="truncate text-xs text-muted-foreground" title={`${sc.source.site_url}${sc.source.account_email ? ` · read through ${sc.source.account_email}` : ''}`}>
          <span className="text-foreground">{siteLabel(sc.source.site_url)}</span>
          {by ? ` · chosen by ${by}` : ''}
        </p>
        <TabPills
          className="mt-3"
          label="Search performance"
          tabs={SEARCH_TABS.map((id) => ({ id, label: TAB_LABEL[id] }))}
          value={activeTab}
          onChange={onTab}
        />
        <div className="mt-4">
          {activeTab === 'opportunities' ? (
            <OpportunitiesTab
              period={period}
              connecting={connecting}
              onConnect={connect}
              onChooseSite={chooseSite}
              onSetupGone={reread}
              onOpenAnalytics={() => onTab('analytics')}
            />
          ) : activeTab === 'analytics' ? (
            <AnalyticsTab status={status.analytics} period={period} connecting={connecting} onConnect={connect} onChooseProperty={chooseProperty} onStatusChanged={reread} />
          ) : (
            <PerformanceTab
              key={activeTab}
              dimension={activeTab === 'pages' ? 'page' : 'query'}
              period={period}
              connecting={connecting}
              onConnect={connect}
              onChooseSite={chooseSite}
              onSetupGone={reread}
            />
          )}
        </div>
      </>
    )
  }

  return (
    <div data-seo-search-page="" data-seo-search-state={picking ? `pick-${picking}` : sc.state} className="flex h-full min-h-0 flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">{body}</div>
      {sc.source && (
        <ConfirmDialog
          open={confirmDisconnect}
          onOpenChange={(next) => {
            if (!disconnecting) setConfirmDisconnect(next)
          }}
          title={`Stop reading ${siteLabel(sc.source.site_url)} here?`}
          description="This page stops showing its searches for everyone in this workspace. Nothing changes in Google Search Console, and you can choose it again any time."
          confirmLabel="Disconnect"
          busy={disconnecting}
          onConfirm={() => void disconnect()}
        />
      )}
    </div>
  )
}
