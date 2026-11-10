'use client'

/**
 * Settings › Connectors: every app the agent works with, in one place, laid
 * out like Claude's own Customize › Connectors (2026-10-22). It replaces the
 * Integrations grid and the outbound half of the MCP page.
 *
 *   Your connectors        what's connected, needs-you first: one row each,
 *                          its account (or host) and ONE status; the row opens
 *                          the connector's own page, an amber Reconnect /
 *                          Update access re-runs the connect right there.
 *   Discover               what could be added: search, an Integrations /
 *                          MCP servers filter, category chips, one Connect
 *                          each; unfiltered, the cards sit under category
 *                          headings (the vetted catalog: mcp-client/suggested.ts).
 *   Add custom connector   an MCP server by URL (add-custom-connector-dialog.tsx);
 *                          saved, it opens on its own page.
 *
 * Integrations and MCP servers stay apart (connector-directory.ts): Linear's
 * integration and Linear's MCP server are two rows, the MCP one labelled.
 *
 * The rows, their action words and tones, and what an action does are the
 * side panel card's (connections-section.tsx), read through useConnections.
 */
import { useCallback, useMemo, useState } from 'react'
import { AlertCircle, ChevronRight, Loader2, Plus, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type { ConnectionRow } from '@/lib/integrations/connections'
import { connectorCategoryLabel, type ConnectorCategory } from '@/lib/integrations/connector-categories'
import {
  CONNECTOR_KIND_FILTERS,
  categoriesIn,
  connectorCategory,
  connectorDescription,
  connectorKindLabel,
  connectorStatus,
  discoverConnectors,
  hasBothKinds,
  yourConnectors,
  type ConnectorKindFilter,
} from '@/lib/integrations/connector-directory'
import { useConnections } from '@/lib/integrations/use-connections'
import { useConnectProvider } from '@/lib/integrations/use-connect-provider'
import { actionWord, connectingIdOf, RowIcon, runConnectionAction, toneOf } from '../../(dashboard)/side-panels/connections-section'
import { useSettingsNavigate } from '../settings-shell'
import { AddCustomConnectorDialog } from './add-custom-connector-dialog'

export function ConnectorsView() {
  const connections = useConnections({ active: true })
  const { groups, loading, refresh } = connections
  const settingsNavigate = useSettingsNavigate()
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<ConnectorKindFilter>('all')
  const [category, setCategory] = useState<ConnectorCategory | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  // Every return (popup, system browser, EventKit) re-reads the statuses; a
  // reported failure shows under Discover.
  const { connect, connectWithUrl, connectingId } = useConnectProvider({
    origin: 'settings',
    onReturn: (result) => {
      if (!result.success && result.error) setConnectError(result.error)
      refresh()
    },
  })

  const open = useCallback((settingsPath: string) => settingsNavigate(`/account/settings/${settingsPath}`), [settingsNavigate])
  const act = useCallback(
    (row: ConnectionRow) => {
      setConnectError(null)
      runConnectionAction(row, { open, connect, connectWithUrl })
    },
    [open, connect, connectWithUrl],
  )

  const yours = useMemo(() => yourConnectors(groups), [groups])
  const showKinds = useMemo(() => hasBothKinds(groups.available), [groups.available])
  // A filter applies only while it's shown: connect the last of one kind (or
  // category) and Discover shows the rest again.
  const effectiveKind = showKinds ? kind : 'all'
  const categories = useMemo(
    () => categoriesIn(discoverConnectors(groups, { kind: effectiveKind })),
    [groups, effectiveKind],
  )
  const effectiveCategory = category && categories.includes(category) ? category : null
  const discover = useMemo(
    () => discoverConnectors(groups, { query, kind: effectiveKind, category: effectiveCategory }),
    [groups, query, effectiveKind, effectiveCategory],
  )
  // Browsing (no search, no category picked): the cards under category headings.
  const sections = useMemo(() => {
    if (query.trim() || effectiveCategory) return null
    const byCategory: { id: ConnectorCategory | null; rows: ConnectionRow[] }[] = categoriesIn(discover).map((id) => ({
      id,
      rows: discover.filter((r) => connectorCategory(r) === id),
    }))
    // Every catalog row has one today; a row without would still show, last.
    const rest = discover.filter((r) => !connectorCategory(r))
    return rest.length ? [...byCategory, { id: null, rows: rest }] : byCategory
  }, [discover, query, effectiveCategory])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Connectors</h1>
            <p className="mt-1 text-muted-foreground">
              The apps your agent works with. Integrations sync your data into Native Intelligence; MCP servers give the agent an
              app&apos;s own tools.
            </p>
          </div>
          <Button variant="outline" size="sm" className="mt-1 shrink-0" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add custom connector
          </Button>
        </div>

        {loading ? (
          <ConnectorsSkeleton />
        ) : (
          <>
            {/* Nothing connected yet: no empty section, Discover is the page. */}
            {yours.length > 0 && (
              <section aria-labelledby="your-connectors" className="mt-8">
                <h2 id="your-connectors" className={SECTION_HEADING}>
                  Your connectors
                </h2>
                <ul className="divide-y overflow-hidden rounded-xl border">
                  {yours.map((row) => (
                    <YourConnectorRow
                      key={row.key}
                      row={row}
                      busy={connectingId === connectingIdOf(row)}
                      onOpen={open}
                      onAction={act}
                    />
                  ))}
                </ul>
              </section>
            )}

            {groups.available.length > 0 && (
              <section aria-labelledby="discover-connectors" className="mt-10">
                <h2 id="discover-connectors" className={SECTION_HEADING}>
                  Discover
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative min-w-[200px] flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder="Search connectors"
                      aria-label="Search connectors"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      className="pl-9"
                    />
                  </div>
                  {showKinds && (
                    <div role="group" aria-label="Show" className="flex items-center gap-1">
                      {CONNECTOR_KIND_FILTERS.map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          aria-pressed={kind === f.id}
                          onClick={() => setKind(f.id)}
                          className={cn(
                            'h-8 rounded-full px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
                            kind === f.id
                              ? 'bg-foreground text-background'
                              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                          )}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Hidden with only one category to pick, unless one is picked (so it can be cleared). */}
                {(categories.length > 1 || effectiveCategory) && (
                  <div role="group" aria-label="Category" className="mt-3 flex flex-wrap gap-1.5">
                    {[null, ...categories].map((id) => (
                      <button
                        key={id ?? 'all'}
                        type="button"
                        aria-pressed={effectiveCategory === id}
                        onClick={() => setCategory(id)}
                        className={cn(
                          'h-7 rounded-full border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
                          effectiveCategory === id
                            ? 'border-foreground/20 bg-muted text-foreground'
                            : 'border-border text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {id ? connectorCategoryLabel(id) : 'All categories'}
                      </button>
                    ))}
                  </div>
                )}

                {connectError && (
                  <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                      <span className="select-text text-xs text-red-500">{connectError}</span>
                    </div>
                  </div>
                )}

                {discover.length > 0 && sections ? (
                  <div className="mt-5 space-y-6">
                    {sections.map((section) => (
                      <div key={section.id ?? 'more'} data-discover-category={section.id ?? 'more'}>
                        <h3 className="mb-2 text-sm font-medium">{section.id ? connectorCategoryLabel(section.id) : 'More'}</h3>
                        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          {section.rows.map((row) => (
                            <DiscoverCard key={row.key} row={row} busy={connectingId === connectingIdOf(row)} onAction={act} />
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : discover.length > 0 ? (
                  <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {discover.map((row) => (
                      <DiscoverCard key={row.key} row={row} busy={connectingId === connectingIdOf(row)} onAction={act} />
                    ))}
                  </ul>
                ) : (
                  <p className="mt-6 text-center text-sm text-muted-foreground">No connectors match your search.</p>
                )}
              </section>
            )}
          </>
        )}
      </div>

      <AddCustomConnectorDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={(server) => {
          setAddOpen(false)
          refresh()
          open(`connectors/mcp/${server.id}`)
        }}
      />
    </div>
  )
}

const SECTION_HEADING = 'mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

/** "MCP" / "Custom MCP" beside an MCP row's name (Claude's "Custom"). */
function KindLabel({ row }: { row: ConnectionRow }) {
  const label = connectorKindLabel(row)
  if (!label) return null
  return (
    <span className="shrink-0 rounded border px-1 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {label}
    </span>
  )
}

/**
 * A connected row: the whole row opens the connector's page (its name is the
 * button, stretched over the row), and when it needs a connect again
 * (Reconnect, Update access) that word is its own button on top.
 */
function YourConnectorRow({
  row,
  busy,
  onOpen,
  onAction,
}: {
  row: ConnectionRow
  busy: boolean
  onOpen: (settingsPath: string) => void
  onAction: (row: ConnectionRow) => void
}) {
  const fixHere = row.group === 'attention' && row.action !== 'manage'
  const subtitle = row.detail ?? connectorDescription(row)
  return (
    <li
      data-connector={row.key}
      data-connector-group={row.group}
      className="relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 motion-reduce:transition-none"
    >
      <RowIcon row={row} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => row.settingsPath && onOpen(row.settingsPath)}
            aria-label={`Manage ${row.name}${connectorKindLabel(row) ? ` (${connectorKindLabel(row)})` : ''}`}
            className="truncate text-left text-sm font-medium after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
          >
            {row.name}
          </button>
          <KindLabel row={row} />
        </div>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {fixHere ? (
        <button
          type="button"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={() => onAction(row)}
          className={cn(
            'relative z-10 inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 motion-reduce:transition-none',
            toneOf(row),
          )}
        >
          {busy && <Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />}
          {actionWord(row)}
        </button>
      ) : (
        <span
          className={cn(
            'shrink-0 text-xs',
            row.group === 'attention' ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-muted-foreground',
          )}
        >
          {connectorStatus(row)}
        </span>
      )}
      <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
    </li>
  )
}

/** A connector to add: its tile, name, what it does, and one Connect. */
function DiscoverCard({ row, busy, onAction }: { row: ConnectionRow; busy: boolean; onAction: (row: ConnectionRow) => void }) {
  const description = connectorDescription(row)
  return (
    <li data-connector={row.key} className="flex items-start gap-3 rounded-xl border p-4">
      <RowIcon row={row} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{row.name}</span>
          <KindLabel row={row} />
        </div>
        {description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{description}</p>}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 px-3 text-xs"
        disabled={busy}
        aria-busy={busy || undefined}
        aria-label={`${actionWord(row)} ${row.name}${connectorKindLabel(row) ? ` (${connectorKindLabel(row)})` : ''}`}
        onClick={() => onAction(row)}
      >
        {busy && <Loader2 aria-hidden className="mr-1 h-3 w-3 animate-spin motion-reduce:animate-none" />}
        {actionWord(row)}
      </Button>
    </li>
  )
}

function ConnectorsSkeleton() {
  return (
    <div className="mt-8 space-y-3" aria-hidden>
      <Skeleton className="h-3 w-28" />
      <div className="divide-y rounded-xl border">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="size-9 rounded-lg" />
            <div className="flex-1">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="mt-1.5 h-3 w-44" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
