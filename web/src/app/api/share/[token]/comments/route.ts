/**
 * Share-scoped comments API.
 *
 * This endpoint is the write path for someone who reached a capture or
 * document via a public share link. Comments are written to the unified
 * `comment` table (same table the app reads), so the capture owner sees
 * them alongside their own workspace comments.
 *
 * Access model:
 *   - Unauthenticated requests are rejected (401). The UI shows a
 *     "Create an account to comment" CTA instead of the form.
 *   - Authenticated workspace members: comment posts as their member row.
 *   - Authenticated non-members (external viewers): comment posts as
 *     author_user_id = auth.uid() with denormalised name/avatar.
 *
 * RLS on the `comment` table enforces both branches — this route just
 * shapes the insert and handles rate limiting.
 */
import { getServiceClient } from '@/lib/admin'
import { createClient } from '@/lib/supabase/server'
import { shareTargetAllowed } from '@/lib/share-target'
import { NextResponse, type NextRequest } from 'next/server'

type Commentable = 'capture' | 'document'

// Simple in-memory rate limit per (user|ip, token).
// Authenticated users get a more generous bucket since the spam risk is lower
// when we have an identity on the comment.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(key: string, limit: number): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(key)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + 3600000 })
    return true
  }
  if (entry.count >= limit) return false
  entry.count++
  return true
}

setInterval(
  () => {
    const now = Date.now()
    for (const [key, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(key)
    }
  },
  10 * 60 * 1000,
)

function sanitize(str: string): string {
  return str.replace(/<[^>]*>/g, '').trim()
}

// Fields returned to the client. Keep in sync with the unified comment
// shape used by the app (see `lib/comments.ts`).
const COMMENT_SELECT = `
  id, body, author_id, author_user_id, author_name, author_avatar_url,
  parent_id, commentable_type, commentable_id, created_at, edited_at,
  anchor_text, anchor_prefix, anchor_suffix, anchor_section,
  anchor_occurrence, is_resolved
`

interface RawComment {
  id: string
  body: string
  author_id: string | null
  author_user_id: string | null
  author_name: string | null
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
}

/**
 * Flatten a raw `comment` row into the shape the UI expects. For internal
 * commenters we still read author info from the `member` row via the
 * shared helper; for external commenters we use the denormalised columns.
 */
function flattenComment(c: RawComment & {
  author_member?: { display_name: string; avatar_url: string | null } | null
}) {
  const memberAuthor = c.author_member
  return {
    id: c.id,
    body: c.body,
    content: c.body, // alias used by some adapters
    author_id: c.author_id,
    author_user_id: c.author_user_id,
    author_name: memberAuthor?.display_name || c.author_name || 'Anonymous',
    author_avatar:
      memberAuthor?.avatar_url || c.author_avatar_url || null,
    parent_id: c.parent_id,
    created_at: c.created_at,
    edited_at: c.edited_at,
    anchor_text: c.anchor_text,
    anchor_prefix: c.anchor_prefix,
    anchor_suffix: c.anchor_suffix,
    anchor_section: c.anchor_section,
    anchor_occurrence: c.anchor_occurrence,
    is_resolved: !!c.is_resolved,
  }
}

/**
 * Resolve an active share. An email share resolves only for the signed-in
 * address it was sent to; anyone else gets the same 404 as a bad token.
 */
async function resolveShare(token: string) {
  const service = getServiceClient()
  const { data: share } = await service
    .from('share')
    .select(
      'id, is_active, expires_at, access_level, share_type, shared_with_email, workspace_id, created_by, shareable_type, shareable_id',
    )
    .eq('share_token', token)
    .eq('is_active', true)
    .single()

  if (!share) return { error: 'not_found' as const, status: 404 }
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return { error: 'expired' as const, status: 410 }
  }
  if (share.shareable_type !== 'capture' && share.shareable_type !== 'document') {
    return { error: 'not_found' as const, status: 404 }
  }
  if (share.share_type === 'email') {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    const want = share.shared_with_email?.trim().toLowerCase()
    if (!want || user?.email?.trim().toLowerCase() !== want) {
      return { error: 'not_found' as const, status: 404 }
    }
  }
  if (!(await shareTargetAllowed(service, share))) {
    return { error: 'not_found' as const, status: 404 }
  }
  return { share }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const resolved = await resolveShare(token)
  if ('error' in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status })
  }
  const { share } = resolved
  const service = getServiceClient()

  // Service-role read so an unauthenticated reader can see existing
  // discussion on the shared capture. Members and their external guests
  // see the same visible comment stream on the shared page.
  const { data: comments, error } = await service
    .from('comment')
    .select(
      COMMENT_SELECT + `, author_member:member!author_id(display_name, avatar_url)`,
    )
    .eq('commentable_type', share.shareable_type)
    .eq('commentable_id', share.shareable_id)
    .order('created_at', { ascending: true })

  if (error) {
    console.error('[share/comments GET]', error.message)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  return NextResponse.json({
    comments: (comments || []).map((c) =>
      flattenComment(c as unknown as RawComment & { author_member?: { display_name: string; avatar_url: string | null } | null }),
    ),
  })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const resolved = await resolveShare(token)
  if ('error' in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status })
  }
  const { share } = resolved

  // The share must explicitly grant commenting. A view-only share link is
  // read-only — reject writes even though the reader is authenticated.
  if (share.access_level !== 'comment') {
    return NextResponse.json({ error: 'This share is view-only' }, { status: 403 })
  }

  // Require auth. Unauthenticated viewers are funneled through the sign-in
  // CTA in the UI instead of posting directly.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Sign in to comment' }, { status: 401 })
  }

  // Rate limit per (user, token). 30/hour is generous for legitimate use
  // while bounded enough to deter spam.
  if (!checkRateLimit(`${user.id}:${token}`, 30)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  const body = await request.json()
  let content: string = body.content ?? body.body
  const { parent_id } = body
  const { anchor_text, anchor_prefix, anchor_suffix, anchor_section, anchor_occurrence } = body

  if (!content || typeof content !== 'string') {
    return NextResponse.json({ error: 'content is required' }, { status: 400 })
  }
  content = sanitize(content)
  if (content.length === 0) {
    return NextResponse.json({ error: 'content cannot be empty' }, { status: 400 })
  }
  if (content.length > 5000) {
    return NextResponse.json({ error: 'content too long (max 5000 chars)' }, { status: 400 })
  }

  // Anchor validation (identical shape to the authenticated capture/document
  // comments endpoints).
  let anchorData: Record<string, unknown> = {}
  if (anchor_text !== undefined && anchor_text !== null) {
    if (typeof anchor_text !== 'string' || anchor_text.length === 0) {
      return NextResponse.json({ error: 'anchor_text must be a non-empty string' }, { status: 400 })
    }
    if (anchor_text.length > 1000) {
      return NextResponse.json({ error: 'anchor_text too long (max 1000 chars)' }, { status: 400 })
    }
    const validSections = ['capture', 'notes', 'summary', 'transcript', 'decisions', 'document']
    if (!anchor_section || !validSections.includes(anchor_section)) {
      return NextResponse.json(
        { error: 'anchor_section is required and must be one of: ' + validSections.join(', ') },
        { status: 400 },
      )
    }
    anchorData = {
      anchor_text: sanitize(anchor_text),
      anchor_prefix: typeof anchor_prefix === 'string' ? sanitize(anchor_prefix) : '',
      anchor_suffix: typeof anchor_suffix === 'string' ? sanitize(anchor_suffix) : '',
      anchor_section,
      anchor_occurrence: typeof anchor_occurrence === 'number' ? anchor_occurrence : 0,
    }
  }

  // Is this user a member of the share's workspace? If so, write as their
  // member row (they show up in the app as a normal collaborator). Otherwise
  // write as an external commenter tied to their auth user id.
  const service = getServiceClient()
  const { data: member } = await service
    .from('member')
    .select('id, display_name, avatar_url')
    .eq('user_id', user.id)
    .eq('workspace_id', share.workspace_id)
    .maybeSingle()

  // Validate parent_id (must be a comment on the same commentable).
  if (parent_id) {
    const { data: parent } = await service
      .from('comment')
      .select('id, commentable_type, commentable_id')
      .eq('id', parent_id)
      .single()
    if (
      !parent ||
      parent.commentable_type !== share.shareable_type ||
      parent.commentable_id !== share.shareable_id
    ) {
      return NextResponse.json({ error: 'Invalid parent comment' }, { status: 400 })
    }
  }

  const insertPayload: Record<string, unknown> = {
    body: content,
    parent_id: parent_id || null,
    commentable_type: share.shareable_type as Commentable,
    commentable_id: share.shareable_id,
    ...anchorData,
  }

  if (member) {
    insertPayload.author_id = member.id
    insertPayload.author_user_id = null
  } else {
    // External commenter — denormalise name/avatar so we don't have to
    // reach across schemas to render.
    const meta = (user.user_metadata as Record<string, unknown>) || {}
    const externalName =
      (typeof meta.full_name === 'string' && meta.full_name) ||
      (typeof meta.name === 'string' && meta.name) ||
      user.email?.split('@')[0] ||
      'Guest'
    const externalAvatar =
      (typeof meta.avatar_url === 'string' && meta.avatar_url) ||
      (typeof meta.picture === 'string' && meta.picture) ||
      null
    insertPayload.author_id = null
    insertPayload.author_user_id = user.id
    insertPayload.author_name = externalName
    insertPayload.author_avatar_url = externalAvatar
  }

  // Use the service client for insert — RLS is enforced via DB check
  // constraints + we've already verified the share is active above. The
  // reason we use service here (instead of the user's supabase client with
  // RLS) is that the member's user session may not be trusted to match the
  // workspace, but we *have* checked via the share token, which is the
  // access grant for this endpoint.
  const { data: comment, error } = await service
    .from('comment')
    .insert(insertPayload)
    .select(COMMENT_SELECT + `, author_member:member!author_id(display_name, avatar_url)`)
    .single()

  if (error || !comment) {
    console.error('[share/comments POST]', error?.message)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  return NextResponse.json({
    comment: flattenComment(comment as unknown as RawComment & { author_member?: { display_name: string; avatar_url: string | null } | null }),
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const resolved = await resolveShare(token)
  if ('error' in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status })
  }
  const { share } = resolved

  // Auth required — only the author (or a workspace member) can resolve.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Sign in to update comments' }, { status: 401 })
  }

  const body = await request.json()
  const { comment_id, is_resolved } = body

  if (!comment_id || typeof comment_id !== 'string') {
    return NextResponse.json({ error: 'comment_id is required' }, { status: 400 })
  }
  if (typeof is_resolved !== 'boolean') {
    return NextResponse.json({ error: 'is_resolved must be a boolean' }, { status: 400 })
  }

  const service = getServiceClient()

  // Verify this comment belongs to the shared commentable — stops a user
  // from resolving arbitrary comments by probing this endpoint.
  const { data: target } = await service
    .from('comment')
    .select('id, author_id, author_user_id, commentable_type, commentable_id')
    .eq('id', comment_id)
    .single()

  if (
    !target ||
    target.commentable_type !== share.shareable_type ||
    target.commentable_id !== share.shareable_id
  ) {
    return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
  }

  // Permission: author OR workspace member of the share
  const isAuthor = target.author_user_id === user.id
  let isMember = false
  if (!isAuthor) {
    const { data: member } = await service
      .from('member')
      .select('id')
      .eq('user_id', user.id)
      .eq('workspace_id', share.workspace_id)
      .maybeSingle()
    isMember = !!member
  }
  if (!isAuthor && !isMember) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: comment, error } = await service
    .from('comment')
    .update({ is_resolved })
    .eq('id', comment_id)
    .select('id, is_resolved')
    .single()

  if (error || !comment) {
    console.error('[share/comments PATCH]', error?.message)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  return NextResponse.json({ comment })
}
