'use client'

/**
 * Tables as a card: the real TablesView, with its own fetch. Opened on a
 * table (the agent's `show`, phase 5) it is that table, in the layout the
 * agent asked for (the card's tab); opened on a row, that table with the row
 * open: a row's record card. Opening a table, and Back to the list, move the
 * card the way they move a tab.
 *
 * The Deals page (`pipelines`, Tables phase 7) is the same card on the
 * pipelines: first opened, it shows the default pipeline's board; Back lists
 * every pipeline. A row named without its table (a mention) finds it first.
 */
import * as React from 'react'
import { TablesView, type TablesCardState } from '@/app/account/(dashboard)/views/tables-view'
import { usePagePlace, type PageCardProps } from './page-card'

export function TablesPageCard({ pipelines = false, ...props }: PageCardProps & { pipelines?: boolean }) {
  const place = usePagePlace(props)
  const at = place.at
  const openId = at?.type === 'data_table' ? at.id : at?.type === 'data_row' ? (at.in ?? null) : null
  const rowId = at?.type === 'data_row' ? at.id : null
  const { go } = place
  // Never moved yet: the Deals page opens on the default pipeline.
  const fresh = React.useRef(props.store.state(props.toolCallId).at === undefined && !at)
  const [finding, setFinding] = React.useState(() => (pipelines && fresh.current) || (at?.type === 'data_row' && !at.in))

  React.useEffect(() => {
    let live = true
    if (at?.type === 'data_row' && !at.in) {
      void fetch(`/api/account/table-rows/${at.id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { table_id?: string; title?: string } | null) => {
          if (!live) return
          setFinding(false)
          if (j?.table_id) go({ type: 'data_row', id: at.id, in: j.table_id, ...(j.title ? { label: j.title } : {}) }, place.tab)
        })
        .catch(() => live && setFinding(false))
    } else if (pipelines && fresh.current) {
      fresh.current = false
      void fetch('/api/account/pipelines')
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { default_id?: string | null; pipelines?: Array<{ id: string; name: string }> } | null) => {
          if (!live) return
          setFinding(false)
          const id = j?.default_id
          const name = j?.pipelines?.find((p) => p.id === id)?.name
          if (id) go({ type: 'data_table', id, ...(name ? { label: name } : {}) }, place.tab ?? 'board')
        })
        .catch(() => live && setFinding(false))
    }
    return () => {
      live = false
    }
  }, [at, pipelines, go, place.tab])

  const card = React.useMemo<TablesCardState>(
    () => ({
      openId,
      rowId,
      layout: place.tab,
      onOpen: (id, name) => go(id ? { type: 'data_table', id, ...(name ? { label: name } : {}) } : null),
    }),
    [openId, rowId, place.tab, go],
  )
  if (finding) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>
  return (
    <div className="h-full min-h-0">
      <TablesView onCount={props.onCount} card={card} pipelines={pipelines} />
    </div>
  )
}

export default function TablesCard(props: PageCardProps) {
  return <TablesPageCard {...props} />
}
