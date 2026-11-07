import type { UnifiedComment, CommentAPI, CommentIdentity } from './types'

/**
 * Flatten the authenticated-API comment shape (member-join response) into
 * the unified client shape.
 *
 * The viewer's own identity fills gaps only in the reply to their own post
 * (`justPosted`). A loaded comment with no member author is a guest's or a
 * former member's (migration 320): never the viewer's, so it never gets their
 * name, avatar, or Edit and Delete.
 */
function mapAuthComment(
  apiComment: Record<string, unknown>,
  identity: Extract<CommentIdentity, { mode: 'authenticated' }>,
  justPosted = false,
): UnifiedComment {
  const apiAuthorId = apiComment.author_id as string | null | undefined
  const apiAuthorUserId = apiComment.author_user_id as string | null | undefined
  // External commenter: no member row, but has an auth user id.
  const isGuest =
    apiComment.is_guest === true ||
    (!apiAuthorId && !!apiAuthorUserId)
  return {
    id: apiComment.id as string,
    content: (apiComment.body as string) || (apiComment.content as string),
    author_name:
      (apiComment.author_name as string) || (justPosted ? identity.displayName : isGuest ? 'Guest' : 'Unknown'),
    author_avatar:
      (apiComment.author_avatar as string | null) || (justPosted ? identity.avatarUrl : null),
    author_id: apiAuthorId ?? (justPosted ? identity.memberId : null),
    author_email: null,
    is_guest: isGuest,
    parent_id: (apiComment.parent_id as string | null) || null,
    created_at: apiComment.created_at as string,
    edited_at: (apiComment.edited_at as string | null) || null,
    anchor_text: (apiComment.anchor_text as string | null) || null,
    anchor_prefix: (apiComment.anchor_prefix as string | null) || null,
    anchor_suffix: (apiComment.anchor_suffix as string | null) || null,
    anchor_section: (apiComment.anchor_section as string | null) || null,
    anchor_occurrence:
      apiComment.anchor_occurrence != null
        ? (apiComment.anchor_occurrence as number)
        : null,
    is_resolved: !!apiComment.is_resolved,
  }
}

/**
 * Flatten a comment row as returned by the share page's initial data load.
 * The server-side loader denormalises author info (either from the joined
 * member or from the denormalised columns for external commenters) into
 * `author_name` / `author_avatar` before sending.
 */
function mapShareComment(apiComment: Record<string, unknown>): UnifiedComment {
  const apiAuthorId = apiComment.author_id as string | null | undefined
  const apiAuthorUserId = apiComment.author_user_id as string | null | undefined
  const isGuest =
    apiComment.is_guest === true || (!apiAuthorId && !!apiAuthorUserId)
  return {
    id: apiComment.id as string,
    content:
      (apiComment.content as string) || (apiComment.body as string) || '',
    author_name: (apiComment.author_name as string) || 'Guest',
    author_avatar: (apiComment.author_avatar as string | null) || null,
    author_id: apiAuthorId ?? null,
    author_email: (apiComment.author_email as string | null) || null,
    is_guest: isGuest,
    parent_id: (apiComment.parent_id as string | null) || null,
    created_at: apiComment.created_at as string,
    edited_at: (apiComment.edited_at as string | null) || null,
    anchor_text: (apiComment.anchor_text as string | null) || null,
    anchor_prefix: (apiComment.anchor_prefix as string | null) || null,
    anchor_suffix: (apiComment.anchor_suffix as string | null) || null,
    anchor_section: (apiComment.anchor_section as string | null) || null,
    anchor_occurrence:
      apiComment.anchor_occurrence != null
        ? (apiComment.anchor_occurrence as number)
        : null,
    is_resolved: !!apiComment.is_resolved,
  }
}

/**
 * Adapter for the authenticated workspace comments endpoint
 * (`/api/account/{captures|documents}/[id]/comments`). Members use this
 * inside the dashboard.
 */
export function createAuthenticatedAPI(
  commentableType: 'capture' | 'document',
  commentableId: string,
  identity: Extract<CommentIdentity, { mode: 'authenticated' }>,
): CommentAPI {
  const routeBase = commentableType === 'capture' ? 'captures' : 'documents'

  return {
    async postComment(body) {
      const res = await fetch(
        `/api/account/${routeBase}/${commentableId}/comments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: body.content,
            parent_id: body.parent_id || undefined,
            anchor_text: body.anchor_text,
            anchor_prefix: body.anchor_prefix,
            anchor_suffix: body.anchor_suffix,
            anchor_section: body.anchor_section,
            anchor_occurrence: body.anchor_occurrence,
          }),
        },
      )
      if (!res.ok) return null
      const data = await res.json()
      return mapAuthComment(data.comment, identity, true)
    },
    async resolveComment(commentId, resolved) {
      const res = await fetch(
        `/api/account/${routeBase}/${commentableId}/comments`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comment_id: commentId, is_resolved: resolved }),
        },
      )
      return res.ok
    },
  }
}

/**
 * Adapter for the share-scoped comments endpoint (`/api/share/[token]/comments`).
 * Used when the viewer is signed-in but NOT a workspace member — they reach
 * the capture via the share token, so their writes are authorised via that.
 */
export function createShareAPI(
  token: string,
  identity: Extract<CommentIdentity, { mode: 'authenticated' }>,
): CommentAPI {
  return {
    async postComment(body) {
      const res = await fetch(`/api/share/${token}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) return null
      const data = await res.json()
      return mapAuthComment(data.comment, identity, true)
    },
    async resolveComment(commentId, resolved) {
      const res = await fetch(`/api/share/${token}/comments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment_id: commentId, is_resolved: resolved }),
      })
      return res.ok
    },
  }
}

/**
 * No-op API used as a placeholder when the viewer is an unauthenticated
 * guest. Guests never call the API — the UI shows a sign-in CTA instead —
 * but the context still requires a CommentAPI so we pass this stub.
 */
export const GUEST_NOOP_API: CommentAPI = {
  async postComment() {
    return null
  },
  async resolveComment() {
    return false
  },
}

/** Batch variants used by initial-state loaders. */
export function mapAuthComments(
  comments: Record<string, unknown>[],
  identity: Extract<CommentIdentity, { mode: 'authenticated' }>,
): UnifiedComment[] {
  return comments.map((c) => mapAuthComment(c, identity))
}

export function mapShareComments(
  comments: Record<string, unknown>[],
): UnifiedComment[] {
  return comments.map((c) => mapShareComment(c))
}
