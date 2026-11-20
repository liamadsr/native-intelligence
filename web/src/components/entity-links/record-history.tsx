'use client'

/**
 * "History": what happened to this record (created, renamed, moved,
 * assigned, archived, @-mentioned, commented on, linked), newest first, who
 * did it and when. One compact section for every logged kind's detail
 * panel, under "Referenced in", drawn as the panels' own PropertyGroup.
 * Nothing to show (none yet, still loading, or the read failed): it renders
 * nothing.
 *
 * CLOSED, IT IS ONE ROW (docs/plans/properties-panels.md): "History", the
 * latest event and when, and a chevron; a click opens the list under it. The
 * same shape as the Attachments and Activity rows, so a panel's foot is a line,
 * not a list that grows with every edit, and the latest event is still read at
 * a glance.
 *
 * Reads the cross-kind feed for this one record (GET /api/account/feed
 * ?entity=type:id&group=none): the activity log, every row fenced for the
 * viewer (a mention from a document they can't read never arrives). It reads
 * again when a comment or an edge on this record changes, and once the
 * record itself has stopped changing for a few seconds (an autosave burst is
 * one read, not one per keystroke).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import {
  Archive,
  ArchiveRestore,
  AtSign,
  ChevronDown,
  ChevronRight,
  CircleDot,
  History,
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
export function RecordHistoryList({ events, defaultOpen = false }: { events: readonly FeedRecordEvent[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const listId = useId()
  if (events.length === 0) return null
  const latest = events[0]
  return (
    <PropertyGroup>
      <button
        type="button"
        data-record-history-toggle=""
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/50"
      >
        <History className="h-4 w-4 shrink-0" />
        <span className="shrink-0">History</span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">
            {describeFeedEvent(latest)} · {formatDistanceToNow(new Date(latest.at), { addSuffix: true })}
          </span>
        )}
        {open ? <ChevronDown className="ml-auto h-3 w-3 shrink-0" /> : <ChevronRight className="ml-auto h-3 w-3 shrink-0" />}
      </button>
      {open && (
      <ul id={listId} className="space-y-0.5 px-1" data-record-history="">
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
      )}
    </PropertyGroup>
  )
}
