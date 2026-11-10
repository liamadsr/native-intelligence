import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  captureReadAccess,
  captureRequester,
  captureVisibleToRequester,
  documentReadAccess,
  documentVisibleToRequester,
  resolveEntityWorkspace,
  workspaceEcho,
} from './_shared'
import type { CreateWorkspacePolicy } from './_shared'

const COMMENT_SELECT = `
  id, body, author_id, author_name, parent_id, commentable_type, commentable_id, created_at, edited_at,
  author:member!author_id(id, display_name)
`

// commentable_type → the table that holds it. Every one of these scopes on a
// `workspace_id` column, which is what lets resolveEntityWorkspace (whose
// predicate is that column by name) do the routing for all three.
const TABLE_MAP: Record<string, string> = {
  action: 'actions',
  capture: 'captures',
  document: 'document',
}

/**
 * @param createWorkspacePolicy accepted so ./index.ts threads every create-bearing
 *   factory identically, and INERT here: `add_comment` is PARENT-anchored on the
 *   commentable, which names the workspace outright, so no fallback needs
 *   arbitrating. See {@link resolveCommentableWorkspace}.
 */
export function createCommentTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  omitPrivateCaptures = false,
  strictWorkspace = false,
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
) {
  // Comments on a capture or a document are derived content: they are hidden
  // with it (a private capture, 223; a private document, 369).
  // These tools run on service-role clients (MCP / unattended), so this app-layer
  // gate — not the comment RLS policy — is the real enforcement.
  const requester = captureRequester(userId, omitPrivateCaptures)

  /**
   * WHICH workspace holds this commentable — or null when the caller may not
   * reach it (no such row, a workspace they don't belong to, a fenced run, or a
   * private capture they may not see).
   *
   * This is the routing anchor for every comment tool. A `comment` row carries
   * no workspace_id: it inherits the tenant of the thing it is attached to, so
   * the commentable IS the workspace — and that is why `add_comment` takes no
   * `workspace_id` param. Reads route the same way, because being able to write
   * a comment you cannot read would be the stranger of the two asymmetries.
   *
   * Null on EVERY failure, so callers emit one indistinguishable not-found and
   * an id in a workspace the caller can't reach never announces itself.
   *
   * `access`: 'read' for the tools that only read comments, where a private
   * capture or document SHARED with the person (a grant, 492) counts, as the
   * comment view policy's grant arm (493) has it; 'write' (add_comment, the
   * default) asks the ungranted rule, a grant being view-only.
   */
  const resolveCommentableWorkspace = async (
    type: string,
    id: string,
    access: 'read' | 'write' = 'write',
  ): Promise<string | null> => {
    const table = TABLE_MAP[type]
    // An unmapped commentable_type is only reachable through
    // get_comment_replies, which reads the type off the stored comment. There is
    // no table to check, so keep today's pass-through and treat it as
    // session-scoped rather than inventing a fence for a type we can't resolve.
    if (!table) return workspaceId

    const routed = await resolveEntityWorkspace(supabase, userId, table, id, workspaceId, strictWorkspace)
    if (!routed) return null
    // A private document is its creator's alone, and so are its comments (369).
    if (type === 'document') {
      const visible =
        access === 'read'
          ? !!(await documentReadAccess(supabase, id, routed.workspaceId, userId, omitPrivateCaptures))
          : await documentVisibleToRequester(supabase, id, routed.workspaceId, userId, omitPrivateCaptures)
      return visible ? routed.workspaceId : null
    }
    if (type !== 'capture') return routed.workspaceId
    // Visibility is re-checked IN the resolved workspace — the capture's own —
    // not in the session's.
    const visible =
      access === 'read'
        ? !!(await captureReadAccess(supabase, id, routed.workspaceId, requester))
        : await captureVisibleToRequester(supabase, id, routed.workspaceId, requester)
    return visible ? routed.workspaceId : null
  }

  return {
    list_comments: tool({
      description: 'List top-level comments on an action, capture, or document.',
      inputSchema: z.object({
        commentable_type: z.enum(['action', 'capture', 'document']).describe('Type of entity'),
        commentable_id: z.string().describe('UUID of the entity'),
      }),
      execute: async ({ commentable_type, commentable_id }) => {
        // Verify the entity is reachable — membership in whichever workspace
        // holds it, plus (for captures) visibility to the requester.
        if (!(await resolveCommentableWorkspace(commentable_type, commentable_id, 'read'))) {
          return { success: false, error: `${commentable_type} not found` }
        }

        const { data, error } = await supabase
          .from('comment')
          .select(COMMENT_SELECT)
          .eq('commentable_type', commentable_type)
          .eq('commentable_id', commentable_id)
          .is('parent_id', null)
          .order('created_at', { ascending: true })

        if (error) return { success: false, error: error.message }

        const comments = (data || []).map((c) => {
          const author = c.author as unknown as { id: string; display_name: string } | null
          return {
            id: c.id,
            body: c.body,
            // A former member's comment, or a guest's via a share link, carries its own name.
            author_name: author?.display_name || c.author_name || null,
            created_at: c.created_at,
            edited_at: c.edited_at,
          }
        })

        return { success: true, comments, count: comments.length }
      },
    }),

    add_comment: tool({
      description: 'Add a comment on an action, capture, or document. Can also reply to an existing comment.',
      inputSchema: z.object({
        commentable_type: z.enum(['action', 'capture', 'document']).describe('Type of entity'),
        commentable_id: z.string().describe('UUID of the entity'),
        body: z.string().describe('Comment text'),
        parent_id: z.string().optional().describe('UUID of parent comment if replying'),
      }),
      execute: async ({ commentable_type, commentable_id, body, parent_id }) => {
        // PARENT-ANCHORED CREATE: the commentable names the tenant, so this tool
        // takes no `workspace_id` — it acts wherever the target lives, once that
        // target is proven reachable (mirrors list_comments / get_comment_replies).
        const targetWs = await resolveCommentableWorkspace(commentable_type, commentable_id)
        if (!targetWs) {
          return { success: false, error: `${commentable_type} not found` }
        }

        // Resolve current member IN THE TARGET'S WORKSPACE. `member.id` is
        // workspace-scoped, and it becomes this comment's author_id — the
        // session workspace's row would author a comment in another tenant
        // under an id that does not exist there.
        const { data: member } = await supabase
          .from('member')
          .select('id')
          .eq('user_id', userId)
          .eq('workspace_id', targetWs)
          .single()

        if (!member) return { success: false, error: 'Not a workspace member' }

        const insert: Record<string, unknown> = {
          body,
          author_id: member.id,
          commentable_type,
          commentable_id,
        }
        if (parent_id) insert.parent_id = parent_id

        const { data, error } = await supabase
          .from('comment')
          .insert(insert)
          .select('id, body, created_at')
          .single()

        if (error) return { success: false, error: error.message }
        return {
          success: true,
          comment: data,
          message: `Comment added: "${body.substring(0, 60)}${body.length > 60 ? '...' : ''}"`,
          // A comment row names no workspace, so the echo is the only in-band
          // proof of which tenant this write landed in.
          ...workspaceEcho(targetWs),
        }
      },
    }),

    get_comment_replies: tool({
      description: 'Get threaded replies for a specific comment.',
      inputSchema: z.object({
        comment_id: z.string().describe('UUID of the parent comment'),
      }),
      execute: async ({ comment_id }) => {
        // Verify parent comment's entity belongs to this workspace
        const { data: parentComment } = await supabase
          .from('comment')
          .select('commentable_type, commentable_id')
          .eq('id', comment_id)
          .single()
        if (!parentComment) return { success: false, error: 'Comment not found' }

        if (
          !(await resolveCommentableWorkspace(
            parentComment.commentable_type,
            parentComment.commentable_id,
            'read',
          ))
        ) {
          return { success: false, error: 'Comment not found' }
        }

        const { data, error } = await supabase
          .from('comment')
          .select(COMMENT_SELECT)
          .eq('parent_id', comment_id)
          .order('created_at', { ascending: true })

        if (error) return { success: false, error: error.message }

        const replies = (data || []).map((c) => {
          const author = c.author as unknown as { id: string; display_name: string } | null
          return {
            id: c.id,
            body: c.body,
            // A former member's comment, or a guest's via a share link, carries its own name.
            author_name: author?.display_name || c.author_name || null,
            created_at: c.created_at,
            edited_at: c.edited_at,
          }
        })

        return { success: true, replies, count: replies.length }
      },
    }),
  }
}
