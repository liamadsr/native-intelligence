'use client'

/**
 * One filtered postgres_changes binding with the codebase's recovery discipline
 * (docs/plans/agent-orchestration-product.md §1.2 — the run views stop polling):
 *
 *   useRowChanges({
 *     table: 'agent_run',
 *     filter: runId ? `id=eq.${runId}` : null,   // null = not subscribed
 *     onRow: (row) => patch(row),                // INSERT / UPDATE payload row
 *     onResync: () => void load(),               // a gap may have dropped events
 *   })
 *
 * - The filter is a single-column `eq` (the only kind this codebase binds, see
 *   plan 1.3), so the channel carries exactly the rows the surface shows and
 *   RLS decides whether the caller may see them — which also makes it work for a
 *   row in ANOTHER workspace (a cross-workspace deep link), where the
 *   workspace-scoped entity bridge would be silent.
 * - The channel name carries a per-mount id: supabase-js hands back the same
 *   channel object for a repeated topic, so two mounts of one surface (a panel
 *   and a page on the same run) must not tear down each other's binding.
 * - `onResync` runs after a re-SUBSCRIBE that followed a failure and on the
 *   app-wide `ni:realtime-recovered` event, deduped against each other the
 *   way use-agent-work.ts does (markSelfRefetched / wasSelfRefetchedRecently).
 * - The latest callbacks live in refs, so inline closures don't re-subscribe.
 */
import { useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  markSelfRefetched,
  repairIdFromRecoveredEvent,
  wasSelfRefetchedRecently,
} from '@/lib/supabase/realtime-recovery'

export type RowChangeEvent = 'INSERT' | 'UPDATE' | 'DELETE'

export interface RowChangesOptions<Row> {
  table: string
  /** `column=eq.value`, or null to hold no subscription. */
  filter: string | null
  onRow: (row: Row, event: RowChangeEvent) => void
  onResync?: () => void
  /** Default INSERT + UPDATE. A DELETE payload carries the primary key only. */
  events?: readonly RowChangeEvent[]
}

let mountSeq = 0

export function useRowChanges<Row = Record<string, unknown>>(opts: RowChangesOptions<Row>): void {
  const onRowRef = useRef(opts.onRow)
  onRowRef.current = opts.onRow
  const onResyncRef = useRef(opts.onResync)
  onResyncRef.current = opts.onResync
  const instance = useRef<number | null>(null)
  if (instance.current === null) instance.current = ++mountSeq

  const { table, filter } = opts
  const eventsKey = (opts.events ?? ['INSERT', 'UPDATE']).join(',')

  useEffect(() => {
    if (!filter) return
    const channelName = `row:${table}:${filter}:${instance.current}`
    let hadFailure = false
    const supabase = createClient()
    let channel = supabase.channel(channelName)
    for (const event of eventsKey.split(',') as RowChangeEvent[]) {
      channel = channel.on(
        'postgres_changes',
        { event, schema: 'public', table, filter },
        (payload: { new?: unknown; old?: unknown }) => {
          const row = (event === 'DELETE' ? payload.old : payload.new) as Row | undefined
          if (row) onRowRef.current(row, event)
        },
      )
    }
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED' && hadFailure) {
        hadFailure = false
        markSelfRefetched(channelName)
        onResyncRef.current?.()
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        hadFailure = true
      }
    })

    const onRecovered = (event: Event) => {
      if (wasSelfRefetchedRecently(channelName, repairIdFromRecoveredEvent(event))) return
      onResyncRef.current?.()
    }
    window.addEventListener('ni:realtime-recovered', onRecovered)

    return () => {
      window.removeEventListener('ni:realtime-recovered', onRecovered)
      supabase.removeChannel(channel)
    }
  }, [table, filter, eventsKey])
}
