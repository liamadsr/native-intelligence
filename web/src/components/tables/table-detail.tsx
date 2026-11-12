'use client'

/**
 * One table open (Tables, phases 3 and 4): its header (back, name, who sees
 * it, History with Undo on each change), its saved views and the open one's
 * layout: the grid, a board, a calendar or a gallery. Every layout opens a
 * row in the row panel.
 *
 * Views are the views system's own (kind `data_row`, scoped to this table):
 * the same tabs, + view, filter chips and settings every list has, with a
 * Fields menu for the columns shown and their order. The rows are filtered
 * and sorted on the server. A change is the view's draft until Update or
 * Save as new view; drafts stay in memory, and only the last-opened view is
 * kept in this browser.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowLeft, ArrowUp, Download, History, Link2, Lock, Undo2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ViewHeader } from '@/app/account/(dashboard)/views/view-header'
import { ViewToolbar } from '@/components/views/view-toolbar'
import { useView, useViewConfig, type ViewConfig } from '@/components/views/hooks/use-view'
import { CustomFieldDefinitionsContext } from '@/components/views/hooks/use-custom-field-definitions'
import { relativeTime } from '@/lib/work/presentation'
import { canOfferUndo, describeChange } from '@/lib/tables/describe'
import { TITLE_KEY } from '@/lib/tables/grid-edits'
import { coverColumnOf, dateColumnOf, groupColumnOf, isGroupable, isTotalable, moveColumn, viewColumns } from '@/lib/tables/views'
import { customFieldKeyOf, customFieldPath } from '@/lib/views/custom-field-columns'
import { resultFieldType } from '@/lib/tables/computed'
import { isComputedType } from '@/lib/tables/types'
import type { ViewLayout, ViewScope } from '@/lib/views/types'
import { downloadFile } from '@/lib/download'
import { copyTextToClipboard } from '@/lib/clipboard'
import { tableLink } from '@/lib/tables/embed'
import { FieldsMenu } from './fields-menu'
import { ImportDialog, importedToast } from './import-dialog'
import { RowPanel } from './row-panel'
import { TableBoard } from './table-board'
import { TableCalendar } from './table-calendar'
import { TableGallery } from './table-gallery'
import { archiveRows, TableGrid, type TableSort } from './table-grid'
import { useTableData, type TableNotice } from './use-table-data'

const showNotice = (n: TableNotice) => {
  if (n.tone === 'error') toast.error(n.text)
  else toast(n.text)
}

/** A view's first sort as the grid names it: the Name column, or a column's key. */
function sortOf(config: ViewConfig): TableSort | null {
  const s = config.ordering?.[0]
  if (!s) return null
  const key = s.field === TITLE_KEY ? TITLE_KEY : customFieldKeyOf(s.field)
  return key ? { key, dir: s.direction } : null
}

const fieldOf = (key: string) => (key === TITLE_KEY ? TITLE_KEY : customFieldPath(key))

const NONE: readonly string[] = []
const NO_WIDTHS: Readonly<Record<string, number>> = {}

/** The layouts a chat card may open a table in (pages in the chat, phase 5). */
const CARD_LAYOUTS: readonly ViewLayout[] = ['grid', 'board', 'calendar', 'gallery']

export function TableDetail({
  tableId,
  onBack,
  initialLayout,
  initialRowId = null,
}: {
  tableId: string
  onBack: () => void
  /** A chat card's layout, set once as a draft of the open view. */
  initialLayout?: string
  /** A chat card's row (a row's record card), open from the start. */
  initialRowId?: string | null
}) {
  const scope = useMemo<ViewScope>(() => ({ type: 'data_table', id: tableId }), [tableId])
  const { views, activeView, activeViewId, setActiveViewId, createView, updateView, deleteView, duplicateView, loading: viewsLoading } = useView('data_row', undefined, scope)
  const viewConfig = useViewConfig(activeView, 'data_row', (id, updates) => updateView(id, updates), true, undefined, 'workspace', undefined, 'memory')
  const { config, isDirty, overrides, updateConfig, saveOverrides, discardOverrides } = viewConfig
  const query = useMemo(() => ({ filters: config.filters, ordering: config.ordering }), [config.filters, config.ordering])
  // The last-opened view is still being read: its rows wait for it, not the default's.
  const viewPending = viewsLoading && !!activeViewId && !activeView
  const data = useTableData(tableId, { onNotice: showNotice, query: viewPending ? null : query })
  const { table, columns, error } = data
  const [historyOpen, setHistoryOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [openRowId, setOpenRowId] = useState<string | null>(initialRowId)

  // The table's columns, for the filter picker, the chips and the settings.
  const definitions = useMemo(
    () => ({
      entityType: 'data_row' as const,
      // A formula or a rollup filters as its result's type.
      defs: columns.map((c) => (isComputedType(c.field_type) ? { key: c.key, label: c.label, field_type: resultFieldType(c.computed?.result), options: [], config: {} } : { key: c.key, label: c.label, field_type: c.field_type, options: c.options ?? [], config: c.config ?? {} })),
    }),
    [columns],
  )

  const settings = config.table ?? {}
  const order = config.display_properties ?? NONE
  const hidden = settings.hidden ?? NONE
  const shown = useMemo(() => viewColumns(columns, order, hidden), [columns, order, hidden])
  const sort = sortOf(config)
  const sortLabel = sort ? (sort.key === TITLE_KEY ? 'Name' : columns.find((c) => c.key === sort.key)?.label) : null
  const layout = config.layout === 'board' || config.layout === 'calendar' || config.layout === 'gallery' ? config.layout : 'grid'
  const boardColumn = groupColumnOf(columns, config.grouping) ?? columns.find(isGroupable) ?? null
  // A pipeline's board totals its Value unless the view says otherwise (Tables, phase 7).
  const totalColumn =
    columns.find((c) => c.key === settings.total_key && isTotalable(c)) ??
    (table?.kind === 'pipeline' && settings.total_key === undefined ? columns.find((c) => c.system && c.key === 'value') : undefined) ??
    null

  // A board needs a column to group by: entering one picks the first that can.
  const onConfigChange = useCallback(
    (updates: Partial<ViewConfig>) => {
      if (updates.layout === 'board' && !updates.grouping && !groupColumnOf(columns, config.grouping)) {
        const first = columns.find(isGroupable)
        if (first) updates = { ...updates, grouping: { field: customFieldPath(first.key), direction: 'asc' } }
      }
      updateConfig(updates)
    },
    [columns, config.grouping, updateConfig],
  )
  const setTable = (next: Partial<NonNullable<ViewConfig['table']>>) => updateConfig({ table: { ...settings, ...next } })

  // The layout a chat card asked for, once the views are read: a draft of the
  // open view, so nothing saved changes.
  const [layoutAsked, setLayoutAsked] = useState<ViewLayout | null>(() => CARD_LAYOUTS.find((l) => l === initialLayout) ?? null)
  useEffect(() => {
    if (!layoutAsked || viewsLoading || !table) return
    setLayoutAsked(null)
    if (layout !== layoutAsked) onConfigChange({ layout: layoutAsked })
  }, [layoutAsked, viewsLoading, table, layout, onConfigChange])

  const openRow = openRowId ? data.rows.find((r) => r.id === openRowId) ?? null : null

  // The view as CSV: its filters, sorts and shown columns, read on the server.
  const exportView = async () => {
    try {
      await downloadFile(`/api/account/tables/${encodeURIComponent(tableId)}/export`, `${table?.name ?? 'Table'}.csv`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filters: config.filters ?? [],
          ordering: config.ordering ?? [],
          order,
          hidden,
          view_name: activeView?.name ?? null,
          time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      }, (headers) => {
        if (headers.get('X-Computed-Skipped')) toast('Filters and sorts on a formula or a rollup work on tables of up to 2,000 rows. The file has the rest of the view’s filters and sorts.')
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not export the view')
    }
  }

  return (
    <CustomFieldDefinitionsContext.Provider value={definitions}>
      <div className="flex h-full flex-col">
        <ViewHeader
          title={
            <span className="flex min-w-0 items-center gap-2">
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onBack} aria-label={table?.kind === 'pipeline' ? 'All pipelines' : 'All tables'}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <span className="truncate">{table?.name ?? 'Table'}</span>
              {table?.visibility === 'private' && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Private" />}
              {table && !data.canEdit && <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">View only</span>}
            </span>
          }
          actions={
            table && (
              <span className="flex items-center gap-1">
                {data.canEdit && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setImporting(true)}>
                    <Upload className="h-3.5 w-3.5" />
                    Import
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  title="Paste it in a doc to show this view there"
                  onClick={() => {
                    void copyTextToClipboard(tableLink({ tableId, viewId: activeView?.id ?? null }, /^https?:/.test(window.location.origin) ? window.location.origin : undefined))
                    toast('Copied the link to this view')
                  }}
                >
                  <Link2 className="h-3.5 w-3.5" />
                  Copy link
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void exportView()}>
                  <Download className="h-3.5 w-3.5" />
                  Export
                </Button>
                {data.changes.length > 0 && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setHistoryOpen(true)}>
                    <History className="h-3.5 w-3.5" />
                    History
                  </Button>
                )}
              </span>
            )
          }
        />
        {table && (
          <ViewToolbar
            entityType="data_row"
            views={views}
            activeViewId={activeViewId}
            onViewChange={(id) => setActiveViewId(id)}
            onCreateView={createView}
            onUpdateView={(id, updates) => void updateView(id, updates)}
            onDuplicateView={(id) => void duplicateView(id)}
            onDeleteView={(id) => void deleteView(id)}
            onSetViewVisibility={(id, visibility) => void updateView(id, { visibility })}
            config={config}
            onConfigChange={onConfigChange}
            isDirty={isDirty}
            overrides={overrides}
            onSaveDraft={saveOverrides}
            onDiscardDraft={discardOverrides}
            actions={
              <>
                {sort && sortLabel && (
                  <span className="flex h-7 items-center gap-1 rounded-full border border-border pl-2.5 pr-1 text-xs text-muted-foreground">
                    {sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                    {sortLabel}
                    <button type="button" aria-label="Stop sorting" className="rounded-full p-0.5 hover:text-foreground" onClick={() => updateConfig({ ordering: [] })}>
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )}
                <FieldsMenu
                  columns={columns}
                  order={order}
                  hidden={hidden}
                  cards={layout !== 'grid'}
                  onChange={(next) => {
                    if (next.order) updateConfig({ display_properties: next.order })
                    if (next.hidden) setTable({ hidden: next.hidden })
                  }}
                />
              </>
            }
          />
        )}
        {error && <p className="px-5 py-4 text-sm text-destructive">{error}</p>}
        {!table && !error && <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>}
        {table && data.computedSkipped && (
          <p className="border-t border-border px-5 py-1.5 text-xs text-muted-foreground" data-computed-skipped="">
            Filters and sorts on a formula or a rollup work on tables of up to 2,000 rows. This view shows the rest of its filters and sorts.
          </p>
        )}
        {table && layout !== 'grid' && data.rowsCapped && (
          <p className="border-t border-border px-5 py-1.5 text-xs text-muted-foreground" data-rows-capped="">
            Showing the first {data.rows.length.toLocaleString()} rows. Filter the view to narrow it.
          </p>
        )}
        {table && (
          <div className={data.rowsLoading ? 'flex min-h-0 flex-1 flex-col opacity-60 transition-opacity' : 'flex min-h-0 flex-1 flex-col'}>
            {layout === 'grid' && (
              <TableGrid
                data={data}
                shown={shown}
                widths={settings.widths ?? NO_WIDTHS}
                onWidth={(key, width) => setTable({ widths: { ...(settings.widths ?? {}), [key]: Math.round(width) } })}
                onHide={(key) => setTable({ hidden: [...hidden, key] })}
                onMoveColumn={(key, toIndex) => updateConfig({ display_properties: moveColumn(columns, order, hidden, key, toIndex) })}
                sort={sort}
                onSort={(next) => updateConfig({ ordering: next ? [{ field: fieldOf(next.key), direction: next.dir }] : [] })}
                onOpenRow={setOpenRowId}
              />
            )}
            {layout === 'board' &&
              (boardColumn ? (
                <TableBoard data={data} column={boardColumn} shown={shown} totalColumn={totalColumn} onOpenRow={setOpenRowId} />
              ) : (
                <Hint>A board groups rows by a select or person column. Add one to this table to see it as a board.</Hint>
              ))}
            {layout === 'calendar' &&
              (dateColumnOf(columns, settings.date_key) ? (
                <TableCalendar data={data} column={dateColumnOf(columns, settings.date_key)!} shown={shown} onOpenRow={setOpenRowId} />
              ) : (
                <Hint>A calendar lays rows out by a date column. Add one to this table to see it as a calendar.</Hint>
              ))}
            {layout === 'gallery' && <TableGallery data={data} shown={shown} cover={coverColumnOf(columns, settings.cover_key)} onOpenRow={setOpenRowId} />}
          </div>
        )}
        {openRow && (
          <RowPanel
            row={openRow}
            columns={columns}
            labels={data.labels}
            members={data.members}
            changes={data.changes}
            canEdit={data.canEdit}
            cellErrors={data.cellErrors}
            onEdit={(key, raw, names) => data.edit([{ rowId: openRow.id, key, value: raw }], [], names)}
            onArchive={() => void archiveRows(data, [openRow.id])}
            onUndo={(id) => void data.undo(id)}
            onClose={() => setOpenRowId(null)}
          />
        )}
        {importing && table && (
          <ImportDialog
            tableId={table.id}
            columns={columns}
            onClose={() => setImporting(false)}
            onImported={(changeId, rows) => {
              void data.reload()
              importedToast(rows, changeId ? () => void data.undo(changeId) : undefined)
            }}
          />
        )}
        {historyOpen && table && (
          <Sheet open onOpenChange={setHistoryOpen}>
            <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
              <SheetHeader className="text-left">
                <SheetTitle>History</SheetTitle>
                <SheetDescription>Every change to {table.name}, newest first.</SheetDescription>
              </SheetHeader>
              <ul className="mt-3 divide-y divide-border">
                {data.changes.map((ch) => (
                  <li key={ch.id} className="flex items-center gap-3 py-2">
                    <span className="min-w-0 flex-1">
                      <span className={ch.undone_at ? 'block truncate text-sm text-muted-foreground line-through' : 'block truncate text-sm text-foreground'}>{describeChange(ch, table.columns)}</span>
                      {ch.reason && <span className="block truncate text-xs text-muted-foreground">{ch.reason}</span>}
                    </span>
                    {ch.source !== 'person' && <span className="shrink-0 text-xs text-muted-foreground">{ch.source === 'agent' ? 'Agent' : ch.source}</span>}
                    <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(ch.created_at)}</span>
                    {data.canEdit && canOfferUndo(ch) && (
                      <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2" onClick={() => void data.undo(ch.id)}>
                        <Undo2 className="h-3.5 w-3.5" />
                        Undo
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </SheetContent>
          </Sheet>
        )}
      </div>
    </CustomFieldDefinitionsContext.Provider>
  )
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="border-t border-border px-5 py-10 text-center text-sm text-muted-foreground">{children}</p>
}
