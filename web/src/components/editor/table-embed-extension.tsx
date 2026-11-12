'use client'

/**
 * A table inside a doc (Tables, phase 6): one table's saved view, drawn as a
 * read-only compact grid, with Open to the table. In the markdown it is the
 * view's link on its own line (src/lib/tables/embed.ts), so it is put in by
 * pasting that link on an empty line, or from the slash menu ("Table view",
 * which asks which table and which view).
 *
 * What it shows is read for whoever reads the doc: their rows, their
 * rollups, and for a table they can't open, a locked placeholder with no
 * name. It reads once when it is drawn: nothing polls, nothing animates.
 */
import { Node, mergeAttributes } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Lock, Table2, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CellDisplay } from '@/components/tables/cells'
import { ComputedCell, readColumn } from '@/components/tables/computed-cells'
import { EMBED_ROWS } from '@/lib/tables/embed'
import { openTable } from '@/lib/tables/open-table'
import { isComputedType, type DataColumn, type DataRow, type DataTable } from '@/lib/tables/types'

/** Columns shown past the Name: more go behind Open. */
const EMBED_COLUMNS = 6

interface EmbedData {
  table: Pick<DataTable, 'id' | 'name' | 'icon' | 'visibility'>
  view: { id: string; name: string; layout: string } | null
  columns: DataColumn[]
  rows: DataRow[]
  has_more: boolean
  labels: Record<string, string>
}

type Load = { state: 'loading' } | { state: 'locked' } | { state: 'error' } | { state: 'ready'; data: EmbedData }

function zone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  } catch {
    return ''
  }
}

function useEmbed(tableId: string | null, viewId: string | null): Load {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  useEffect(() => {
    if (!tableId) return
    let live = true
    setLoad({ state: 'loading' })
    const q = new URLSearchParams({ ...(viewId ? { view: viewId } : {}), time_zone: zone() })
    fetch(`/api/account/tables/${encodeURIComponent(tableId)}/embed?${q.toString()}`)
      .then(async (r) => {
        if (!live) return
        if (r.status === 404 || r.status === 403) return setLoad({ state: 'locked' })
        if (!r.ok) return setLoad({ state: 'error' })
        setLoad({ state: 'ready', data: (await r.json()) as EmbedData })
      })
      .catch(() => live && setLoad({ state: 'error' }))
    return () => {
      live = false
    }
  }, [tableId, viewId])
  return load
}

/** The compact grid: the Name column, then the view's shown columns. */
export function TableEmbedGrid({ data, onOpen }: { data: EmbedData; onOpen?: () => void }) {
  const cols = data.columns.slice(0, EMBED_COLUMNS)
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background" data-table-embed-grid="">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Table2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{data.table.name}</span>
        {data.view && <span className="min-w-0 truncate text-xs text-muted-foreground">· {data.view.name}</span>}
        {data.table.visibility === 'private' && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Private" />}
        {onOpen && (
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onOpen}
            className="ml-auto flex h-6 shrink-0 items-center gap-1 rounded-md border border-border px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ArrowUpRight className="h-3 w-3" />
            Open
          </button>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="h-7 border-b border-border px-3 font-medium">Name</th>
              {cols.map((c) => (
                <th key={c.key} className="h-7 border-b border-l border-border px-2 font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id} className="h-8 border-b border-border last:border-b-0">
                <td className="max-w-[220px] truncate px-3 font-medium text-foreground">{r.title || <span className="text-muted-foreground">Untitled</span>}</td>
                {cols.map((c) => (
                  <td key={c.key} className="h-8 max-w-[200px] border-l border-border p-0">
                    <span className="flex h-8 min-w-0 items-center">
                      {isComputedType(c.field_type) ? <ComputedCell column={c} row={r} labels={data.labels} /> : <CellDisplay column={readColumn(c)} value={r.custom_fields?.[c.key] ?? null} labels={data.labels} />}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
            {!data.rows.length && (
              <tr>
                <td colSpan={cols.length + 1} className="px-3 py-3 text-xs text-muted-foreground">
                  No rows in this view.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {(data.has_more || data.columns.length > cols.length) && (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          {data.has_more ? `The first ${EMBED_ROWS} rows` : 'Every row'}
          {data.columns.length > cols.length ? `, ${cols.length} of ${data.columns.length} columns` : ''}. Open the table for the rest.
        </p>
      )}
    </div>
  )
}

/** The placeholder a reader who can't open the table sees: no name, nothing of it. */
export function LockedEmbed() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted-foreground" data-table-embed-locked="">
      <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
      A table you can’t open is here.
    </div>
  )
}

/** Picking what to embed: a table, then one of its views. */
function EmbedPicker({ onPick }: { onPick: (tableId: string, viewId: string | null) => void }) {
  const [tables, setTables] = useState<DataTable[] | null>(null)
  const [table, setTable] = useState<DataTable | null>(null)
  const [views, setViews] = useState<Array<{ id: string; name: string }> | null>(null)
  const pick = useRef(onPick)
  pick.current = onPick
  useEffect(() => {
    let live = true
    fetch('/api/account/tables')
      .then((r) => (r.ok ? r.json() : { tables: [] }))
      .then((j: { tables?: DataTable[] }) => live && setTables(j.tables ?? []))
      .catch(() => live && setTables([]))
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    if (!table) return
    let live = true
    setViews(null)
    const q = new URLSearchParams({ entity_type: 'data_row', scope_type: 'data_table', scope_id: table.id })
    fetch(`/api/account/views?${q.toString()}`)
      .then((r) => (r.ok ? r.json() : { views: [] }))
      .then((j: { views?: Array<{ id: string; name: string }> }) => {
        if (!live) return
        const list = j.views ?? []
        // A table with no saved views embeds as it is.
        if (!list.length) pick.current(table.id, null)
        else setViews(list)
      })
      .catch(() => live && pick.current(table.id, null))
    return () => {
      live = false
    }
  }, [table])
  const item = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60'
  return (
    <div className="rounded-lg border border-border bg-background p-2" data-table-embed-picker="">
      <p className="px-2 pb-1 text-xs text-muted-foreground">{table ? `Which view of ${table.name}?` : 'Which table?'}</p>
      {!table &&
        (tables === null ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</p>
        ) : tables.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">No tables yet. Make one on the Tables page.</p>
        ) : (
          <div className="max-h-56 overflow-y-auto">
            {tables.map((t) => (
              <button key={t.id} type="button" className={item} onMouseDown={(e) => e.preventDefault()} onClick={() => setTable(t)}>
                <Table2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{t.name}</span>
              </button>
            ))}
          </div>
        ))}
      {table && views && (
        <div className="max-h-56 overflow-y-auto">
          {views.map((v) => (
            <button key={v.id} type="button" className={item} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(table.id, v.id)}>
              <span className="truncate">{v.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function TableEmbedView(props: ReactNodeViewProps) {
  const { node, editor, getPos, updateAttributes } = props
  const tableId = (node.attrs.tableId as string | null) ?? null
  const viewId = (node.attrs.viewId as string | null) ?? null
  const load = useEmbed(tableId, viewId)
  const editable = editor.isEditable

  const remove = () => {
    const pos = typeof getPos === 'function' ? getPos() : null
    if (pos == null) return
    const tr = editor.state.tr.delete(pos, pos + node.nodeSize)
    if (tr.doc.content.size === 0) tr.insert(0, editor.state.schema.nodes.paragraph.create())
    editor.view.dispatch(tr)
  }

  return (
    <NodeViewWrapper className="group/embed relative my-2 not-prose" data-table-embed="" contentEditable={false}>
      {!tableId ? (
        editable ? <EmbedPicker onPick={(t, v) => updateAttributes({ tableId: t, viewId: v })} /> : null
      ) : load.state === 'locked' ? (
        <LockedEmbed />
      ) : load.state === 'error' ? (
        <div className="rounded-lg border border-border px-3 py-3 text-sm text-muted-foreground">The table couldn’t be read.</div>
      ) : load.state === 'loading' ? (
        <div className="rounded-lg border border-border px-3 py-3 text-sm text-muted-foreground">Reading the table…</div>
      ) : (
        <TableEmbedGrid data={load.data} onOpen={() => openTable(load.data.table.id, load.data.table.name)} />
      )}
      {editable && (
        <button
          type="button"
          aria-label="Remove the table from the doc"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={remove}
          className={cn('absolute -right-8 top-1 hidden rounded p-1 text-muted-foreground/60 hover:bg-muted hover:text-destructive group-hover/embed:block')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </NodeViewWrapper>
  )
}

// Typing on a selected embed starts a line under it instead of replacing it.
const tableEmbedGuard = new Plugin({
  key: new PluginKey('tableEmbedGuard'),
  props: {
    handleTextInput(view, _from, _to, text) {
      const { selection } = view.state
      if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'tableEmbed') return false
      const pos = selection.from + selection.node.nodeSize
      const tr = view.state.tr.insert(pos, view.state.schema.nodes.paragraph.create(null, view.state.schema.text(text)))
      tr.setSelection(TextSelection.create(tr.doc, pos + text.length + 1))
      view.dispatch(tr)
      return true
    },
  },
})

export const TableEmbedNode = Node.create({
  name: 'tableEmbed',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      tableId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-table-id'),
        renderHTML: (attrs) => (attrs.tableId ? { 'data-table-id': attrs.tableId } : {}),
      },
      viewId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-view-id'),
        renderHTML: (attrs) => (attrs.viewId ? { 'data-view-id': attrs.viewId } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-table-embed]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-table-embed': '' })]
  },

  addNodeView() {
    return ReactNodeViewRenderer(TableEmbedView)
  },

  addProseMirrorPlugins() {
    return [tableEmbedGuard]
  },
})
