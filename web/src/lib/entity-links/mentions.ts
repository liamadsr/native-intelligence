/**
 * MENTIONS AS GRAPH EDGES: the one server helper every surface that can
 * @-mention a record writes through (team chat now, documents' wikilinks and
 * action identifiers; the later phases' inbox and share-by-mention read the
 * same edges).
 *
 * A mention is an `entity_link` row: source = the message or document that
 * mentions, target = the record mentioned, relation 'mentions'. `syncMentions`
 * makes a source's mention edges match the records it mentions NOW: on create
 * it adds them, on edit it adds what's new and deletes what was taken out, and
 * a source mentioning nothing (a deleted message) is left with none. It never
 * touches another relation, and only the target kinds it manages (`kinds`), so
 * a `mentions` edge an agent drew with link_entities to a kind the surface
 * doesn't write survives the surface's next save.
 *
 * Every target is fenced before an edge is written, for `userId`, the person
 * who wrote the mention: it must be a mentionable kind, in the source's
 * workspace, and readable by them (a capture or document of theirs or the
 * workspace's, a contact or company they can see, a calendar event of their
 * own, a channel they're in: src/lib/knowledge/entity-fences.ts). Anything
 * else is dropped, never an error: the message still posts.
 *
 * Flat cost: one read per target kind to fence, one read of the source's
 * current edges, then at most one delete and one insert.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyCaptureVisibility, applyDocumentVisibility, documentRequesterMember } from '@/lib/ai/tools/_shared'
import { filterVisibleCompanies, filterVisibleContacts } from '@/lib/crm/contact-visibility'
import { isPrivateGraphKind, visiblePrivateKindIds } from '@/lib/knowledge/entity-fences'
import { WORKSPACE_SCOPED_TABLE, type LinkableEntityType } from '@/lib/knowledge/entity-registry'
import {
  MENTIONABLE_TYPES,
  mentionKey as key,
  tidyMentionRefs,
  type MentionRef,
  type MentionableType,
} from './mentionable'

export {
  MAX_MENTIONED_RECORDS,
  MENTIONABLE_TYPES,
  isMentionableType,
  tidyMentionRefs,
  type MentionRef,
  type MentionableType,
} from './mentionable'

export const MENTION_RELATION = 'mentions'

/**
 * The refs among `refs` that `userId` may mention from `workspaceId`: in that
 * workspace and readable by them. Fails closed per kind (a read error drops
 * that kind's refs).
 */
export async function visibleMentionTargets(
  supabase: SupabaseClient,
  scope: { workspaceId: string; userId: string | null },
  refs: readonly MentionRef[],
): Promise<MentionRef[]> {
  const byType = new Map<MentionableType, string[]>()
  for (const r of refs) (byType.get(r.type) ?? byType.set(r.type, []).get(r.type)!).push(r.id)
  const visible = new Set<string>()
  await Promise.all(
    [...byType.entries()].map(async ([type, ids]) => {
      for (const id of await visibleIdsOf(supabase, scope, type, ids)) visible.add(`${type}:${id}`)
    }),
  )
  return refs.filter((r) => visible.has(key(r)))
}

async function visibleIdsOf(
  supabase: SupabaseClient,
  { workspaceId, userId }: { workspaceId: string; userId: string | null },
  type: MentionableType,
  ids: string[],
): Promise<string[]> {
  try {
    if (isPrivateGraphKind(type)) return [...(await visiblePrivateKindIds(supabase, type, userId, ids, workspaceId))]
    const table = WORKSPACE_SCOPED_TABLE[type]
    if (!table) return []
    let query = supabase.from(table).select('id').eq('workspace_id', workspaceId).in('id', ids)
    if (type === 'capture') query = applyCaptureVisibility(query, userId)
    if (type === 'document') {
      query = applyDocumentVisibility(query, userId ? await documentRequesterMember(supabase, userId, workspaceId) : null)
    }
    const { data, error } = await query
    if (error) {
      console.warn('[mentions] fence read failed:', type, error.message)
      return []
    }
    const rows = ((data ?? []) as Array<{ id?: unknown }>).filter((r): r is { id: string } => typeof r.id === 'string')
    if (type === 'contact') return userId ? (await filterVisibleContacts(supabase, userId, rows)).map((r) => r.id) : []
    if (type === 'company') return userId ? (await filterVisibleCompanies(supabase, userId, rows)).map((r) => r.id) : []
    return rows.map((r) => r.id)
  } catch (err) {
    console.warn('[mentions] fence threw:', type, err instanceof Error ? err.message : 'unknown')
    return []
  }
}

export interface SyncMentionsInput {
  workspaceId: string
  /** The message or document doing the mentioning. */
  source: { type: LinkableEntityType; id: string }
  /** What it mentions now (already tidied, or raw: it is tidied again). */
  targets: readonly MentionRef[]
  /** Who wrote the mention: every target is fenced for them (null: only what every member may read). */
  userId: string | null
  /** Their member row (entity_link.created_by), or null. */
  memberId: string | null
  /** The target kinds this surface manages (default: every mentionable kind). */
  kinds?: readonly MentionableType[]
  /** `targets` already came through visibleMentionTargets for this user and workspace: not read again. */
  fenced?: boolean
}

export interface SyncMentionsResult {
  /** The targets the source now mentions (fenced). */
  mentioned: MentionRef[]
  added: number
  removed: number
  error?: string
}

/**
 * Make `source`'s mention edges (of the kinds managed) match `targets`: insert
 * the new ones, delete the ones no longer mentioned. Never throws; a failure
 * comes back as `error` (a mention is never worth failing the save it rides).
 */
export async function syncMentions(supabase: SupabaseClient, input: SyncMentionsInput): Promise<SyncMentionsResult> {
  const kinds = new Set<string>(input.kinds ?? MENTIONABLE_TYPES)
  const wanted = tidyMentionRefs(input.targets, input.source).filter((r) => kinds.has(r.type))
  try {
    const mentioned =
      wanted.length && !input.fenced
        ? await visibleMentionTargets(supabase, { workspaceId: input.workspaceId, userId: input.userId }, wanted)
        : wanted

    const { data: existing, error: readError } = await supabase
      .from('entity_link')
      .select('id, target_type, target_id')
      .eq('workspace_id', input.workspaceId)
      .eq('source_type', input.source.type)
      .eq('source_id', input.source.id)
      .eq('relation', MENTION_RELATION)
      .in('target_type', [...kinds])
    if (readError) return { mentioned, added: 0, removed: 0, error: readError.message }

    const now = new Set(mentioned.map(key))
    const rows = (existing ?? []) as Array<{ id: string; target_type: string; target_id: string }>
    const had = new Set(rows.map((r) => `${r.target_type}:${r.target_id}`))
    const stale = rows.filter((r) => !now.has(`${r.target_type}:${r.target_id}`)).map((r) => r.id)
    const fresh = mentioned.filter((r) => !had.has(key(r)))

    if (stale.length) {
      const { error } = await supabase.from('entity_link').delete().eq('workspace_id', input.workspaceId).in('id', stale)
      if (error) return { mentioned, added: 0, removed: 0, error: error.message }
    }
    if (fresh.length) {
      const { error } = await supabase.from('entity_link').upsert(
        fresh.map((r) => ({
          workspace_id: input.workspaceId,
          source_type: input.source.type,
          source_id: input.source.id,
          target_type: r.type,
          target_id: r.id,
          relation: MENTION_RELATION,
          created_by: input.memberId,
        })),
        { onConflict: 'workspace_id,source_type,source_id,target_type,target_id,relation', ignoreDuplicates: true },
      )
      if (error) return { mentioned, added: 0, removed: stale.length, error: error.message }
    }
    return { mentioned, added: fresh.length, removed: stale.length }
  } catch (err) {
    return { mentioned: [], added: 0, removed: 0, error: err instanceof Error ? err.message : 'unknown' }
  }
}
