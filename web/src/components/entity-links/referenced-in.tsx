'use client'

/**
 * "Referenced in": the things that link to this record (a team-chat message
 * or a document that @-mentions it, a task related to it), newest first, one
 * row each, opening the source's card. One section for every kind's detail
 * panel, drawn as the panels' own PropertyGroup. Nothing to show (none yet,
 * still loading, or the read failed): it renders nothing.
 *
 * Reads GET /api/account/entities/[type]/[id]/references (the viewer's RLS:
 * a source they can't read never arrives) and reads again when an edge to
 * this record changes anywhere (the shared entity_link event).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import {
  AudioLines,
  Building2,
  CalendarDays,
  CircleCheck,
  FileText,
  FolderKanban,
  Handshake,
  Hash,
  Link2,
  MessageSquare,
  Target,
  User,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { PropertyGroup } from '@/components/views/property-group'
import { useEntityListSync } from '@/hooks/use-entity-sync'
import { openTarget } from '@/lib/chat-cards/open-card'
import { entityOpenTarget } from '@/lib/entity-links/open-entity'
import type { EntityReference } from '@/lib/entity-links/references'
import { EntityContextMenu } from '@/components/entities/entity-actions-menu'

export const entityReferencesUrl = (type: string, id: string) =>
  `/api/account/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}/references`

const ICONS: Record<string, LucideIcon> = {
  action: CircleCheck,
  document: FileText,
  project: FolderKanban,
  initiative: Target,
  capture: AudioLines,
  contact: User,
  company: Building2,
  deal: Handshake,
  flow: Workflow,
  calendar_event: CalendarDays,
  team_chat_message: Hash,
  team_chat_channel: Hash,
  conversation: MessageSquare,
}

/** How a relation reads under a row: a mention is the common case and says so. */
const RELATION_WORDS: Record<string, string> = {
  mentions: 'Mentioned',
  related_to: 'Related',
  depends_on: 'Depends on this',
  about: 'About this',
  cites: 'Cites this',
  supersedes: 'Supersedes this',
  contradicts: 'Contradicts this',
  owns: 'Owns this',
  authored_by: 'Authored',
  committed_to: 'Committed to',
  // A relation field's value (migration 524): the record links this in one of its fields.
  field_link: 'Linked in a field',
}

/** The references to one record; null until the first answer (or when it failed). */
export function useEntityReferences(entityType: string, entityId: string | null): EntityReference[] | null {
  // Kept with the record it is for, so another record's list never shows while this one's loads.
  const key = `${entityType}:${entityId ?? ''}`
  const [state, setState] = useState<{ key: string; refs: EntityReference[] | null }>({ key, refs: null })
  const seq = useRef(0)
  const load = useCallback(async () => {
    if (!entityId) return
    const mine = ++seq.current
    const forKey = `${entityType}:${entityId}`
    try {
      const res = await fetch(entityReferencesUrl(entityType, entityId), { cache: 'no-store' })
      if (mine !== seq.current) return
      if (!res.ok) return setState({ key: forKey, refs: null })
      const data = (await res.json()) as { references?: EntityReference[] }
      if (mine === seq.current) setState({ key: forKey, refs: Array.isArray(data.references) ? data.references : [] })
    } catch {
      if (mine === seq.current) setState({ key: forKey, refs: null })
    }
  }, [entityType, entityId])
  useEffect(() => {
    void load()
  }, [load])
  // An edge into this record, added or removed anywhere (a delete carries no fields: read again).
  useEntityListSync(['entity_link'], () => void load(), {
    match: (d) => d.fields?.target_id == null || d.fields.target_id === entityId,
    enabled: !!entityId,
  })
  return state.key === key ? state.refs : null
}

export function ReferencedIn({ entityType, entityId }: { entityType: string; entityId: string }) {
  const refs = useEntityReferences(entityType, entityId)
  if (!refs || refs.length === 0) return null
  return <ReferencedInList references={refs} />
}

/** The section itself, for the references in hand (the panels, and screenshots). */
export function ReferencedInList({ references }: { references: readonly EntityReference[] }) {
  if (references.length === 0) return null
  return (
    <PropertyGroup title="Referenced in">
      <ul className="space-y-0.5 px-1" data-referenced-in="">
        {references.map((r) => {
          const Icon = ICONS[r.type] ?? Link2
          const target = entityOpenTarget(r.type, r.id, r.label)
          const how = r.relations.map((rel) => RELATION_WORDS[rel] ?? rel).join(' · ')
          const when = formatDistanceToNow(new Date(r.created_at), { addSuffix: true })
          const body = (
            <>
              <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground/90">{r.label}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {[r.context, how, when].filter(Boolean).join(' · ')}
                </span>
              </span>
            </>
          )
          // Right-click a row: the source's own actions (the one entity actions menu).
          const entity = { type: r.type, id: r.id, label: r.label }
          return (
            <li key={`${r.type}:${r.id}`}>
              {target ? (
                <EntityContextMenu entity={entity} from="referenced_in">
                  <button
                    type="button"
                    data-reference={r.type}
                    onClick={() => openTarget(target, { from: 'referenced_in' })}
                    className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/60"
                  >
                    {body}
                  </button>
                </EntityContextMenu>
              ) : (
                <EntityContextMenu entity={entity} from="referenced_in">
                  <div data-reference={r.type} className="flex items-start gap-2 px-2 py-1.5">
                    {body}
                  </div>
                </EntityContextMenu>
              )}
            </li>
          )
        })}
      </ul>
    </PropertyGroup>
  )
}
