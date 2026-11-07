import type { SupabaseClient } from '@supabase/supabase-js'
import { tool } from 'ai'
import { z } from 'zod'
// These two tools used to carry their own, drifted copies of the vocabulary
// (7 entity types, 8 relations), so `unlink_entities` could not remove an edge
// `link_entities` had just created: a claim / email / attachment / member /
// conversation endpoint, or an `owns` / `committed_to` relation, was rejected
// by zod before the tool ran. Both now come from the one registry.
import {
  LINKABLE_ENTITY_TYPES as ENTITY_TYPES,
  RELATIONS,
  WORKSPACE_SCOPED_TABLE,
  type LinkableEntityType,
} from '@/lib/knowledge/entity-registry'
import { resolveEntityWorkspace } from './_shared'

export function createEntityLinkTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
) {
  /**
   * Route `unlink_entities` by the SOURCE entity's own workspace, not the
   * session one — the edge itself may live wherever the source resolved.
   * Some linkable types (`cycle`, `milestone`) have no direct `workspace_id`
   * column (WORKSPACE_SCOPED_TABLE has no entry), so they can't be verified
   * this way; that mirrors entityInWorkspace's can't-verify → allow and just
   * falls back to the session workspace, unchanged from before this file was
   * routed.
   */
  const resolveSourceWorkspace = async (
    sourceType: LinkableEntityType,
    sourceId: string,
  ): Promise<string | null> => {
    const table = WORKSPACE_SCOPED_TABLE[sourceType]
    if (!table) return workspaceId
    const resolved = await resolveEntityWorkspace(supabase, userId, table, sourceId, workspaceId, strictWorkspace)
    return resolved?.workspaceId ?? null
  }

  return {
    // NOTE: `link_entities` is intentionally NOT defined here. The canonical,
    // workspace-verified, claim-aware implementation lives in claims.ts (and is
    // the one referenced by the tool registry). Defining it here too would
    // shadow that version at spread time in tools/index.ts.

    unlink_entities: tool({
      description:
        'Remove a link between two entities. Deletes all links matching the given source and target (optionally filtered by relation). ' +
        'Use this to detach a document from an action or project, or to remove any entity graph edge.',
      inputSchema: z.object({
        source_type: z.enum(ENTITY_TYPES).describe('Type of the source entity'),
        source_id: z.string().describe('UUID of the source entity'),
        target_type: z.enum(ENTITY_TYPES).describe('Type of the target entity'),
        target_id: z.string().describe('UUID of the target entity'),
        relation: z
          .enum(RELATIONS)
          .optional()
          .describe(
            'If provided, only the link with this relation is removed. Omit to remove all links between the pair.',
          ),
      }),
      execute: async ({
        source_type,
        source_id,
        target_type,
        target_id,
        relation,
      }) => {
        const targetWs = await resolveSourceWorkspace(source_type, source_id)
        if (!targetWs) return { success: false, error: 'Source entity not found' }

        let query = supabase
          .from('entity_link')
          .delete({ count: 'exact' })
          .eq('workspace_id', targetWs)
          .eq('source_type', source_type)
          .eq('source_id', source_id)
          .eq('target_type', target_type)
          .eq('target_id', target_id)

        if (relation) {
          query = query.eq('relation', relation)
        }

        const { error, count } = await query

        if (error) return { success: false, error: error.message }

        return {
          success: true,
          deleted_count: count ?? 0,
          message: count
            ? `Removed ${count} link(s) between ${source_type} and ${target_type}`
            : `No links found between ${source_type} and ${target_type}`,
        }
      },
    }),

    list_entity_links: tool({
      description:
        'List all entity graph links for a given entity — both links where it is the source and links where it is the target. ' +
        'Use this to discover what documents, actions, or projects are associated with a given entity. ' +
        'Also used to verify a link was created by link_entities.',
      inputSchema: z.object({
        entity_type: z.enum(ENTITY_TYPES).describe('Type of the entity'),
        entity_id: z.string().describe('UUID of the entity'),
        direction: z
          .enum(['outbound', 'inbound', 'both'])
          .optional()
          .default('both')
          .describe(
            '"outbound": links where this entity is the source. ' +
              '"inbound": links where this entity is the target. ' +
              '"both": all links (default).',
          ),
        relation: z
          .enum(RELATIONS)
          .optional()
          .describe('Filter by relation type'),
      }),
      execute: async ({ entity_type, entity_id, direction, relation }) => {
        const dir = direction ?? 'both'

        const outboundQuery = async () => {
          let q = supabase
            .from('entity_link')
            .select('id, target_type, target_id, relation, created_at')
            .eq('workspace_id', workspaceId)
            .eq('source_type', entity_type)
            .eq('source_id', entity_id)
          if (relation) q = q.eq('relation', relation)
          return q.order('created_at', { ascending: false }).limit(100)
        }

        const inboundQuery = async () => {
          let q = supabase
            .from('entity_link')
            .select('id, source_type, source_id, relation, created_at')
            .eq('workspace_id', workspaceId)
            .eq('target_type', entity_type)
            .eq('target_id', entity_id)
          if (relation) q = q.eq('relation', relation)
          return q.order('created_at', { ascending: false }).limit(100)
        }

        const results: {
          outbound: Array<{
            id: string
            target_type: string
            target_id: string
            relation: string
            created_at: string
          }>
          inbound: Array<{
            id: string
            source_type: string
            source_id: string
            relation: string
            created_at: string
          }>
        } = { outbound: [], inbound: [] }

        if (dir === 'outbound' || dir === 'both') {
          const { data, error } = await outboundQuery()
          if (error) return { success: false, error: error.message }
          results.outbound = (data || []) as typeof results.outbound
        }

        if (dir === 'inbound' || dir === 'both') {
          const { data, error } = await inboundQuery()
          if (error) return { success: false, error: error.message }
          results.inbound = (data || []) as typeof results.inbound
        }

        return {
          success: true,
          entity_type,
          entity_id,
          outbound: results.outbound,
          inbound: results.inbound,
          total: results.outbound.length + results.inbound.length,
        }
      },
    }),
  }
}
