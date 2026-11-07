import type { SupabaseClient } from '@supabase/supabase-js'

export type CommentableType = 'action' | 'capture' | 'document' | 'project' | 'contact'

const COMMENT_SELECT = `
  id, body, author_id, author_user_id, author_name, author_avatar_url,
  parent_id, commentable_type, commentable_id, created_at, edited_at,
  anchor_text, anchor_prefix, anchor_suffix, anchor_section, anchor_occurrence, is_resolved,
  author:member!author_id(id, display_name, avatar_url)
`

interface RawComment {
  id: string
  body: string
  /** Member id when the commenter is a workspace member. */
  author_id: string | null
  /** Auth user id when the commenter is external (reached us via share link). */
  author_user_id: string | null
  /** Denormalized name for external commenters (set at insert time). */
  author_name: string | null
  /** Denormalized avatar for external commenters. */
  author_avatar_url: string | null
  parent_id: string | null
  commentable_type: string
  commentable_id: string
  created_at: string
  edited_at: string | null
  anchor_text: string | null
  anchor_prefix: string | null
  anchor_suffix: string | null
  anchor_section: string | null
  anchor_occurrence: number | null
  is_resolved: boolean
  author: unknown
}

function flattenComment(c: RawComment) {
  const memberAuthor = c.author as
    | { id: string; display_name: string; avatar_url: string | null }
    | null
  // Prefer the member's current profile, fall back to the denormalized copy
  // stored for external commenters. `is_guest` lets the UI tag them visually.
  const isGuest = !c.author_id && !!c.author_user_id
  return {
    id: c.id,
    body: c.body,
    author_id: c.author_id,
    author_user_id: c.author_user_id,
    author_name:
      memberAuthor?.display_name || c.author_name || (isGuest ? 'Guest' : null),
    author_avatar: memberAuthor?.avatar_url || c.author_avatar_url || null,
    is_guest: isGuest,
    parent_id: c.parent_id,
    created_at: c.created_at,
    edited_at: c.edited_at,
    anchor_text: c.anchor_text,
    anchor_prefix: c.anchor_prefix,
    anchor_suffix: c.anchor_suffix,
    anchor_section: c.anchor_section,
    anchor_occurrence: c.anchor_occurrence,
    is_resolved: c.is_resolved ?? false,
  }
}

export interface AnchorData {
  anchor_text: string
  anchor_prefix: string
  anchor_suffix: string
  anchor_section: string
  anchor_occurrence: number
}

/**
 * Get top-level comments for an entity, with reply counts.
 */
export async function getComments(
  supabase: SupabaseClient,
  commentableType: CommentableType,
  commentableId: string,
) {
  const { data, error } = await supabase
    .from('comment')
    .select(COMMENT_SELECT)
    .eq('commentable_type', commentableType)
    .eq('commentable_id', commentableId)
    .is('parent_id', null)
    .order('created_at', { ascending: true })

  if (error) return { error: error.message }

  // Get reply counts in one query
  const commentIds = (data || []).map((c: RawComment) => c.id)
  let replyCounts: Record<string, number> = {}

  if (commentIds.length > 0) {
    const { data: counts } = await supabase
      .rpc('count_comment_replies', { comment_ids: commentIds })

    // If RPC doesn't exist, fall back to individual counts
    if (!counts) {
      // Fallback: count replies per parent
      const { data: replies } = await supabase
        .from('comment')
        .select('parent_id')
        .in('parent_id', commentIds)

      replyCounts = (replies || []).reduce((acc: Record<string, number>, r: { parent_id: string }) => {
        acc[r.parent_id] = (acc[r.parent_id] || 0) + 1
        return acc
      }, {})
    } else {
      replyCounts = (counts as { parent_id: string; count: number }[]).reduce(
        (acc: Record<string, number>, r) => {
          acc[r.parent_id] = r.count
          return acc
        },
        {},
      )
    }
  }

  const comments = (data || []).map((c: RawComment) => ({
    ...flattenComment(c),
    reply_count: replyCounts[c.id] || 0,
  }))

  return { comments }
}

/**
 * Get replies for a specific comment.
 */
export async function getCommentReplies(
  supabase: SupabaseClient,
  commentId: string,
) {
  const { data, error } = await supabase
    .from('comment')
    .select(COMMENT_SELECT)
    .eq('parent_id', commentId)
    .order('created_at', { ascending: true })

  if (error) return { error: error.message }

  const replies = (data || []).map((c: RawComment) => flattenComment(c))
  return { replies }
}

/**
 * Create a comment on an entity.
 */
export async function createComment(
  supabase: SupabaseClient,
  commentableType: CommentableType,
  commentableId: string,
  authorId: string,
  body: string,
  parentId?: string,
  anchor?: AnchorData,
) {
  // If replying, verify parent belongs to the same entity
  if (parentId) {
    const { data: parent, error: parentError } = await supabase
      .from('comment')
      .select('id, commentable_type, commentable_id')
      .eq('id', parentId)
      .single()

    if (parentError || !parent) {
      return { error: 'Parent comment not found' }
    }
    if (parent.commentable_type !== commentableType || parent.commentable_id !== commentableId) {
      return { error: 'Parent comment belongs to a different entity' }
    }
  }

  const { data, error } = await supabase
    .from('comment')
    .insert({
      body,
      author_id: authorId,
      parent_id: parentId || null,
      commentable_type: commentableType,
      commentable_id: commentableId,
      ...(anchor || {}),
    })
    .select(COMMENT_SELECT)
    .single()

  if (error) return { error: error.message }
  return { comment: flattenComment(data as unknown as RawComment) }
}

/**
 * Resolve or reopen an inline comment.
 */
export async function resolveComment(
  supabase: SupabaseClient,
  commentId: string,
  isResolved: boolean,
) {
  const { data, error } = await supabase
    .from('comment')
    .update({ is_resolved: isResolved })
    .eq('id', commentId)
    .select('id, is_resolved')
    .single()

  if (error) return { error: error.message }
  return { comment: data }
}

const VALID_ANCHOR_SECTIONS = ['capture', 'notes', 'enhanced', 'summary', 'transcript', 'decisions', 'document']

/**
 * Parse and validate anchor fields from a request body.
 * Returns anchor data if present, undefined otherwise.
 */
export function parseAnchorFields(body: Record<string, unknown>): AnchorData | undefined {
  const { anchor_text, anchor_prefix, anchor_suffix, anchor_section, anchor_occurrence } = body

  if (anchor_text === undefined || anchor_text === null) return undefined

  if (typeof anchor_text !== 'string' || anchor_text.length === 0) return undefined
  if (anchor_text.length > 1000) return undefined
  if (!anchor_section || !VALID_ANCHOR_SECTIONS.includes(anchor_section as string)) return undefined

  return {
    anchor_text: anchor_text,
    anchor_prefix: typeof anchor_prefix === 'string' ? anchor_prefix : '',
    anchor_suffix: typeof anchor_suffix === 'string' ? anchor_suffix : '',
    anchor_section: anchor_section as string,
    anchor_occurrence: typeof anchor_occurrence === 'number' ? anchor_occurrence : 0,
  }
}

/**
 * Get all comments (top-level + replies) for an entity, for inline commenting.
 * Returns flat array with anchor fields — the frontend groups them.
 */
export async function getAllComments(
  supabase: SupabaseClient,
  commentableType: CommentableType,
  commentableId: string,
) {
  const { data, error } = await supabase
    .from('comment')
    .select(COMMENT_SELECT)
    .eq('commentable_type', commentableType)
    .eq('commentable_id', commentableId)
    .order('created_at', { ascending: true })

  if (error) return { error: error.message }

  const comments = (data || []).map((c: RawComment) => flattenComment(c))
  return { comments }
}
