'use client'

/**
 * The side panel's Connectors card (Liam, 10-16: "I didn't mean for the
 * connectors to be such a big panel, I was meaning for something more like
 * this"): a small floating card, like its siblings (its surface and its
 * "Connectors" row are the panel's, side-panels.tsx PanelSection; the row's
 * summary is connectionsSummary below), then, opened, plain rows, each a
 * small icon tile, the name (an MCP server's with a small "MCP" label) and ONE
 * right-aligned action word. No group headings, no subtitles, no status
 * chips: the action word carries the state.
 *
 *   Reconnect / Update access   (amber) needs attention: the same connect
 *               again, for that account. A sync or MCP error opens Settings.
 *   Connect     (warm accent) available: the same connect as Settings
 *               (useConnectProvider: a popup on the web, the system browser
 *               on the desktop, which keeps sign-in in the default browser).
 *               Started here, the desktop's return refreshes this list
 *               instead of opening Settings.
 *   Connected   (muted) connected: opens Manage, the connector's own page
 *               under Settings › Connectors (openSettings, settings-overlay.tsx).
 *
 * Every connection is listed (lib/integrations/connections.ts panelRows):
 * what needs attention, then what's connected, then everything that could be
 * added, integrations and MCP servers alike, each its own row (Liam, 10-22:
 * "show all the available connections so you can scroll and see it all").
 * Condensed by default: the first VISIBLE_ROWS, then "Show more" opens the
 * whole list in a box of EXPANDED_MAX_HEIGHT that scrolls on its own. The
 * card keeps its size and the panel's column never has to scroll it (that
 * column clips a card scrolled under its top edge flat). "Manage connectors"
 * opens Settings › Connectors (search, categories, each connector's page).
 *
 * The statuses are read by the panel (use-connections.ts): when it opens, on
 * window focus while it is open, and after a connect returns. No polling.
 */
import { createElement, memo, useCallback, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBrandIcon, getCapabilityIcon, LOCAL_EXCHANGE_ICON } from '@/lib/integrations/catalog-icons'
import { panelRows, type ConnectionRow } from '@/lib/integrations/connections'
import { connectorKindLabel } from '@/lib/integrations/connector-directory'
import type { UseConnections } from '@/lib/integrations/use-connections'
import { useConnectProvider } from '@/lib/integrations/use-connect-provider'
import { startMcpOAuth } from '@/lib/integrations/start-mcp-oauth'
import { useOptionalSettingsOverlay } from '../settings-overlay'

/** Rows shown before "Show more". */
export const VISIBLE_ROWS = 3

/** The opened list's height before it scrolls inside the card: eight 40px rows. */
const EXPANDED_MAX_HEIGHT = 'max-h-80'

const LIST_ID = 'side-panel-connections-list'

const FOOTER_BUTTON =
  'rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none'

/** The one word on a row's action: what clicking it does, or (connected) where the row stands. */
export function actionWord(row: ConnectionRow): string {
  switch (row.action) {
    case 'connect':
      return 'Connect'
    case 'update':
      return 'Update access'
    case 'reconnect':
      return 'Reconnect'
    case 'manage':
      if (row.group === 'connected') return 'Connected'
      if (row.group === 'attention') return row.cause === 'sync_error' ? 'Fix sync' : row.cause === 'mcp_error' ? 'Fix' : 'Reconnect'
      // Available but nothing to grant here (the Mac has no Exchange account): its page says how.
      return 'Set up'
  }
}

/** The id the connect hook reports while this row's connect is in flight. */
export function connectingIdOf(row: ConnectionRow): string {
  return row.kind === 'mcp' ? row.key : `${row.provider}-${row.capability}`
}

/**
 * What a row's action does, here and on Settings › Connectors: manage opens
 * the connector's page (`open`, given its settingsPath), and so does every
 * action on Native Intelligence's own Slack app (adding it takes steps there); a catalog MCP
 * app runs its OAuth start; a custom MCP server is fixed on its own page;
 * every other row runs the provider's connect (for the account that needs it).
 */
export function runConnectionAction(
  row: ConnectionRow,
  {
    open,
    connect,
    connectWithUrl,
  }: Pick<ReturnType<typeof useConnectProvider>, 'connect' | 'connectWithUrl'> & { open: (settingsPath: string) => void },
): void {
  if (row.action === 'manage' || row.kind === 'app') {
    if (row.settingsPath) open(row.settingsPath)
    return
  }
  if (row.kind === 'mcp') {
    const suggested = row.mcp?.suggested
    // A custom server (no curated definition) is fixed where it was added.
    if (!suggested) {
      if (row.settingsPath) open(row.settingsPath)
      return
    }
    // An added one reconnects as itself (its name, its URL), so the OAuth
    // callback renews that row in place (GEN-1171); a suggestion adds the catalog's.
    const mcp = row.mcp
    const target = mcp?.serverId ? { display_name: row.name, server_url: mcp.serverUrl, transport: mcp.transport ?? suggested.transport } : suggested
    void connectWithUrl(row.key, () => startMcpOAuth(target))
    return
  }
  void connect(row.provider, row.capability, row.loginHint ? { loginHint: row.loginHint } : undefined)
}

/**
 * The Connectors row's summary: how many need reconnecting (amber, the one hue
 * that means "needs you", as the rows' Reconnect), else how many are
 * connected (muted); nothing before the first read, or with none connected.
 * Counted over the rows the card lists (panelRows: an integration and its
 * service's MCP server are two connections, so two).
 */
export function connectionsSummary({
  groups,
  loading,
}: Pick<UseConnections, 'groups' | 'loading'>): { text: string; tone: 'muted' | 'attention' } | null {
  if (loading) return null
  const rows = panelRows(groups)
  const attention = rows.filter((r) => r.group === 'attention').length
  if (attention > 0) return { text: `${attention} to reconnect`, tone: 'attention' }
  const connected = rows.filter((r) => r.group === 'connected').length
  return connected > 0 ? { text: `${connected} connected`, tone: 'muted' } : null
}

export function ConnectionsSection({ connections }: { connections: UseConnections }) {
  const settings = useOptionalSettingsOverlay()
  const { refresh, groups } = connections
  const [expanded, setExpanded] = useState(false)
  // A connect started here: its return (popup, deep link, EventKit) re-reads the statuses.
  const { connect, connectWithUrl, connectingId } = useConnectProvider({ origin: 'panel', onReturn: () => refresh() })

  const act = useCallback(
    (row: ConnectionRow) =>
      runConnectionAction(row, { open: (path) => settings?.openSettings(path), connect, connectWithUrl }),
    [settings, connect, connectWithUrl],
  )

  const rows = useMemo(() => panelRows(groups), [groups])
  const more = rows.length > VISIBLE_ROWS
  const shown = more && !expanded ? rows.slice(0, VISIBLE_ROWS) : rows

  return (
    // The card, its row and its body's box are the panel's (side-panels.tsx PanelSection).
    <div data-connections-section="">
      {/* Before the first read every catalog row would say Connect: a quiet line instead. */}
      {connections.loading ? (
        <p className="px-3 pb-1.5 pt-1 text-xs text-muted-foreground">Checking your connections…</p>
      ) : (
        <>
          {/* Opened, every connection, scrolling here (not the panel). */}
          <ul id={LIST_ID} className={cn(expanded && more && [EXPANDED_MAX_HEIGHT, 'overflow-y-auto overscroll-contain'])}>
            {shown.map((row) => (
              <ConnectionItem key={row.key} row={row} busy={connectingId === connectingIdOf(row)} onAction={act} />
            ))}
          </ul>
          <div className="mx-1.5 mt-0.5 flex items-center justify-between">
            {more && (
              <button
                type="button"
                data-connections-more=""
                aria-expanded={expanded}
                aria-controls={LIST_ID}
                onClick={() => setExpanded((v) => !v)}
                className={FOOTER_BUTTON}
              >
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}
            {settings && (
              <button
                type="button"
                data-connections-manage=""
                onClick={() => settings.openSettings('connectors')}
                className={cn(FOOTER_BUTTON, 'ml-auto')}
              >
                Manage connectors
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * A connection's icon tile (also the chat's Connect card's: connect-card.tsx,
 * and Settings › Connectors', at size 'md').
 */
export function RowIcon({
  row,
  size = 'sm',
}: {
  row: Pick<ConnectionRow, 'kind' | 'provider' | 'capability' | 'mcp'>
  size?: 'sm' | 'md'
}) {
  const tile = cn('flex shrink-0 items-center justify-center', size === 'md' ? 'size-9 rounded-lg' : 'size-6 rounded-md')
  const glyph = size === 'md' ? 'size-[18px]' : 'size-3.5'
  const plainTile = cn(tile, 'bg-background text-muted-foreground ring-1 ring-inset ring-border/70 dark:bg-zinc-800')
  const suggested = row.mcp?.suggested
  if (row.kind === 'mcp') {
    if (suggested?.iconSvg) {
      return (
        <span className={cn(tile, 'bg-white ring-1 ring-inset ring-border/70 dark:bg-zinc-800')}>
          <svg
            className={glyph}
            viewBox={suggested.iconViewBox ?? '0 0 24 24'}
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
            // The curated catalog's own markup (lib/mcp-client/suggested.ts), as Settings draws it.
            dangerouslySetInnerHTML={{ __html: suggested.iconSvg }}
          />
        </span>
      )
    }
    if (suggested?.iconPath) {
      return (
        <span className={cn(tile, suggested.accent)}>
          <svg className={glyph} viewBox={suggested.iconViewBox ?? '0 0 24 24'} fill="currentColor" aria-hidden="true">
            <path d={suggested.iconPath} />
          </svg>
        </span>
      )
    }
    // A catalog app with no brand mark yet: its initial, so a list of them isn't a column of identical plugs.
    if (suggested) {
      return (
        <span aria-hidden className={cn(plainTile, 'font-semibold text-foreground', size === 'md' ? 'text-sm' : 'text-[11px]')}>
          {suggested.display_name.charAt(0).toUpperCase()}
        </span>
      )
    }
    return <span className={plainTile}>{createElement(getCapabilityIcon('mcp'), { className: glyph })}</span>
  }
  // The catalog's own icons (static components it holds), looked up per row.
  const brand = row.kind === 'oauth' || row.kind === 'app' ? getBrandIcon(row.provider, row.capability) : undefined
  const plain = row.kind === 'local' ? LOCAL_EXCHANGE_ICON : getCapabilityIcon(row.capability)
  return <span className={plainTile}>{createElement(brand ?? plain, { className: glyph })}</span>
}

/** The action word's colour: amber needs attention, the warm accent invites a connect, muted is settled. */
export function toneOf(row: Pick<ConnectionRow, 'group'>): string {
  if (row.group === 'attention') return 'font-medium text-amber-700 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300'
  // Plain foreground, not a second warm colour: amber stays the one hue that
  // means "needs you", so Connect never reads as a lighter Reconnect.
  if (row.group === 'available') return 'font-medium text-foreground hover:underline underline-offset-2'
  return 'text-muted-foreground hover:text-foreground'
}

const ConnectionItem = memo(function ConnectionItem({
  row,
  busy,
  onAction,
}: {
  row: ConnectionRow
  busy: boolean
  onAction: (row: ConnectionRow) => void
}) {
  const word = actionWord(row)
  // "MCP" / "Custom MCP": tells Linear's MCP server from the Linear integration.
  const kind = connectorKindLabel(row)
  // Connected reads as a state; what clicking it does is Manage.
  const verb = row.group === 'connected' ? 'Manage' : word
  // The dropped subtitle (status, account), kept for the pointer.
  const hint = row.group === 'connected' ? row.detail : [row.statusText, row.detail].filter(Boolean).join(' · ')
  return (
    <li
      data-connection={row.key}
      data-connection-group={row.group}
      data-connection-cause={row.cause ?? undefined}
      className="flex h-10 items-center gap-2.5 px-3"
    >
      <RowIcon row={row} />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span data-connection-name="" className="truncate text-[13px] text-foreground">{row.name}</span>
        {kind && (
          <span data-connection-kind="" className="shrink-0 rounded border px-1 text-[9px] font-medium uppercase leading-[14px] tracking-wide text-muted-foreground">
            {kind}
          </span>
        )}
      </span>
      <button
        type="button"
        data-connection-action={row.action}
        disabled={busy}
        aria-busy={busy || undefined}
        aria-label={`${verb} ${row.name}${kind ? ` (${kind})` : ''}`}
        title={hint || undefined}
        onClick={() => onAction(row)}
        className={cn(
          '-mr-1.5 inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 motion-reduce:transition-none',
          toneOf(row),
        )}
      >
        {busy && <Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />}
        {word}
      </button>
    </li>
  )
})
