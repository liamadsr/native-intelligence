'use client'

/**
 * "History": what happened to this record (created, renamed, moved,
 * assigned, archived, @-mentioned, commented on, linked), newest first, who
 * did it and when. One compact section for every logged kind's detail
 * panel, under "Referenced in", drawn as the panels' own PropertyGroup.
 * Nothing to show (none yet, still loading, or the read failed): it renders
 * nothing.
 *
 * Reads the cross-kind feed for this one record (GET /api/account/feed
 * ?entity=type:id&group=none): the activity log, every row fenced for the
 * viewer (a mention from a document they can't read never arrives). It reads
 * again when a comment or an edge on this record changes, and once the
 * record itself has stopped changing for a few seconds (an autosave burst is
 * one read, not one per keystroke).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import {
  Archive,
  ArchiveRestore,
  AtSign,
  CircleDot,
  Link2,
  MessageSquare,
  PenLine,
  Plus,
  SlidersHorizontal,
  Share2,
  UserPlus,
  type LucideIcon,
} from 'lucide-react'
import { PropertyGroup } from '@/components/views/property-group'
import { useEntityListSync } from '@/hooks/use-entity-sync'
import { openTarget } from '@/lib/chat-cards/open-card'
import { entityOpenTarget } from '@/lib/entity-links/open-entity'
import type { EntityKind } from '@/lib/entity-events'
import { describeFeedEvent, feedActorLabel, feedUrl, type FeedAction, type FeedRecordEvent } from '@/lib/entities/feed-model'

/** The most events the section shows. */
export const HISTORY_LIMIT = 12
/** Quiet time after the record's own last change before the section reads again. */
const SETTLE_MS = 4000

const ICONS: Record<FeedAction, LucideIcon> = {
  created: Plus,
  renamed: PenLine,
  status_changed: CircleDot,
  assigned: UserPlus,
  archived: Archive,
  restored: ArchiveRestore,
  mentioned: AtSign,
  commented: MessageSquare,
  linked: Link2,
  updated: SlidersHorizontal,
  shared: Share2,
}

export const recordHistoryUrl = (type: string, id: string) => feedUrl({ entity: { type, id }, group: 'none', limit: HISTORY_LIMIT })

/** One record's events; null until the first answer (or when it failed). */
export function useRecordHistory(entityType: string, entityId: string | null): FeedRecordEvent[] | null {
  const key = `${entityType}:${entityId ?? ''}`
  const [state, setState] = useState<{ key: string; events: FeedRecordEvent[] | null }>({ key, events: null })
  const seq = useRef(0)
  const load = useCallback(async () => {
    if (!entityId) return
    const mine = ++seq.current
    const forKey = `${entityType}:${entityId}`
    try {
      const res = await fetch(recordHistoryUrl(entityType, entityId), { cache: 'no-store' })
      if (mine !== seq.current) return
      if (!res.ok) return setState({ key: forKey, events: null })
      const data = (await res.json()) as { events?: FeedRecordEvent[] }
      if (mine === seq.current) setState({ key: forKey, events: Array.isArray(data.events) ? data.events : [] })
    } catch {
      if (mine === seq.current) setState({ key: forKey, events: null })
    }
  }, [entityType, entityId])
  useEffect(() => {
    void load()
  }, [load])
  // A comment or an edge on this record (a delete carries no fields: read again).
  useEntityListSync(['comment', 'entity_link'], () => void load(), {
    match: (d) =>
      d.fields == null ||
      d.fields.commentable_id === entityId ||
      d.fields.target_id === entityId ||
      d.fields.source_id === entityId,
    enabled: !!entityId,
  })
  // The record itself, once it has settled.
  useEntityListSync([entityType as EntityKind], () => void load(), {
    match: (d) => d.id === entityId,
    debounceMs: SETTLE_MS,
    refetchOnRecovered: false,
    enabled: !!entityId,
  })
  return state.key === key ? state.events : null
}

export function RecordHistory({ entityType, entityId }: { entityType: string; entityId: string }) {
  const events = useRecordHistory(entityType, entityId)
  if (!events || events.length === 0) return null
  return <RecordHistoryList events={events} />
}

/** The section itself, for the events in hand (the panels, and screenshots). */
export function RecordHistoryList({ events }: { events: readonly FeedRecordEvent[] }) {
  if (events.length === 0) return null
  return (
    <PropertyGroup title="History">
      <ul className="space-y-0.5 px-1" data-record-history="">
        {events.map((e) => {
          const Icon = ICONS[e.action] ?? CircleDot
          const who = feedActorLabel(e.actor)
          const when = formatDistanceToNow(new Date(e.at), { addSuffix: true })
          const target = e.other ? entityOpenTarget(e.other.type, e.other.id, e.other.label) : null
          const line = (
            <>
              <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground/90">{describeFeedEvent(e)}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {[who, when].filter(Boolean).join(' · ')}
                </span>
              </span>
            </>
          )
          return (
            <li key={e.id} data-history-action={e.action}>
              {target ? (
                <button
                  type="button"
                  onClick={() => openTarget(target, { from: 'record_history' })}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/60"
                >
                  {line}
                </button>
              ) : (
                <div className="flex items-start gap-2 px-2 py-1.5">{line}</div>
              )}
            </li>
          )
        })}
      </ul>
    </PropertyGroup>
  )
}
