/**
 * "REFERENCED IN": the things that link TO an entity (a team-chat message or a
 * document that @-mentions it, a task related to it, …), read through the
 * viewer's own RLS. The one reader behind every kind's panel
 * (GET /api/account/entities/[type]/[id]/references) and the documents
 * backlinks route.
 *
 * SESSION CLIENT ONLY. Each source's label is resolved with the knowledge
 * map's resolveEntityLabels on the viewer's client, so a source the viewer
 * can't read (someone else's private document or capture, a DM they're not
 * in, another member's calendar event) is absent from the answer, not a
 * placeholder. Mail is never a source (migration 341). Claims are left out
 * unless asked for: a record's claims have their own panel.
 *
 * Flat cost: one read of the edges, one label read per source kind, and two
 * small reads for a team-chat message's channel.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isMailSourceType } from '@/lib/knowledge/claim-visibility'
import { resolveEntityLabels } from '@/lib/knowledge/graph-map/source'

/** The most edges one answer reads (newest first). */
export const REFERENCES_LIMIT = 200

/** One edge into the entity, its source labelled. */
export interface ReferenceEdge {
  id: string
  source_type: string
  source_id: string
  relation: string
  created_at: string
  label: string
}

/** One source that references the entity, however many relations it has to it. */
export interface EntityReference {
  type: string
  id: string
  label: string
  /** Every relation from it to the entity ('mentions', 'related_to', …). */
  relations: string[]
  /** Its newest edge's time. */
  created_at: string
  /** Where it sits, when that helps: a message's channel ("#launch", "Direct message"). */
  context: string | null
}

export type ReferencesResult = { edges: ReferenceEdge[]; contexts: Map<string, string> } | { error: string }

/** The edges into (`type`, `id`) the viewer may see the source of, newest first. */
export async function loadReferenceEdges(
  supabase: SupabaseClient,
  scope: { workspaceId: string; type: string; id: string; includeClaims?: boolean; limit?: number },
): Promise<ReferencesResult> {
  const { data, error } = await supabase
    .from('entity_link')
    .select('id, source_type, source_id, relation, created_at')
    .eq('workspace_id', scope.workspaceId)
    .eq('target_type', scope.type)
    .eq('target_id', scope.id)
    .order('created_at', { ascending: false })
    .limit(scope.limit ?? REFERENCES_LIMIT)
  if (error) return { error: error.message }

  type Row = { id: string; source_type: string; source_id: string; relation: string; created_at: string }
  const rows = ((data ?? []) as Row[]).filter(
    (r) => !isMailSourceType(r.source_type) && (scope.includeClaims || r.source_type !== 'claim'),
  )
  if (rows.length === 0) return { edges: [], contexts: new Map() }

  const byType = new Map<string, Set<string>>()
  for (const r of rows) (byType.get(r.source_type) ?? byType.set(r.source_type, new Set()).get(r.source_type)!).add(r.source_id)
  let labels: Map<string, string>
  try {
    labels = await resolveEntityLabels(supabase, scope.workspaceId, byType)
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'label read failed' }
  }

  const edges: ReferenceEdge[] = []
  for (const r of rows) {
    const label = labels.get(`${r.source_type}:${r.source_id}`)
    if (label === undefined) continue // not readable by the viewer (or gone)
    edges.push({ ...r, label })
  }
  const contexts = await messageChannels(
    supabase,
    edges.filter((e) => e.source_type === 'team_chat_message').map((e) => e.source_id),
  )
  // The person's chat with their agent (only they read it, so only they see it here).
  for (const e of edges) if (e.source_type === 'conversation') contexts.set(e.source_id, 'Your chat')
  return { edges, contexts }
}

/** A team-chat message's channel as a short place name: "#launch", or "Direct message". */
export async function messageChannels(supabase: SupabaseClient, messageIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (messageIds.length === 0) return out
  const { data: messages } = await supabase.from('team_chat_message').select('id, channel_id').in('id', [...new Set(messageIds)])
  const channelOf = new Map(((messages ?? []) as Array<{ id: string; channel_id: string }>).map((m) => [m.id, m.channel_id]))
  const channelIds = [...new Set(channelOf.values())]
  if (channelIds.length === 0) return out
  const { data: channels } = await supabase.from('team_chat_channel').select('id, kind, name').in('id', channelIds)
  const place = new Map(
    ((channels ?? []) as Array<{ id: string; kind: string; name: string | null }>).map((c) => [
      c.id,
      c.kind === 'dm' ? 'Direct message' : `#${c.name ?? 'channel'}`,
    ]),
  )
  for (const [messageId, channelId] of channelOf) {
    const p = place.get(channelId)
    if (p) out.set(messageId, p)
  }
  return out
}

/** One row per source, newest first, its relations gathered. */
export function groupReferences(edges: readonly ReferenceEdge[], contexts: ReadonlyMap<string, string> = new Map()): EntityReference[] {
  const out = new Map<string, EntityReference>()
  for (const e of edges) {
    const key = `${e.source_type}:${e.source_id}`
    const seen = out.get(key)
    if (seen) {
      if (!seen.relations.includes(e.relation)) seen.relations.push(e.relation)
      if (e.created_at > seen.created_at) seen.created_at = e.created_at
      continue
    }
    out.set(key, {
      type: e.source_type,
      id: e.source_id,
      label: e.label,
      relations: [e.relation],
      created_at: e.created_at,
      context: e.source_type === 'team_chat_message' || e.source_type === 'conversation' ? (contexts.get(e.source_id) ?? null) : null,
    })
  }
  return [...out.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
}
