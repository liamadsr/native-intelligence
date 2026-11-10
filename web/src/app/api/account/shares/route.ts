import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { generateShareToken } from '@/lib/share-token'
import { createNotification } from '@/lib/notifications'
import { findMemberByEmail } from '@/lib/workspace-member-emails'
import { NOW_KEY, NOW_PRIVATE_REFUSAL } from '@/lib/now/now-stamp'
import { NextResponse, type NextRequest } from 'next/server'
import { appUrl as appAddress } from '@/lib/app-url'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { searchParams } = request.nextUrl
  const shareableType = searchParams.get('shareable_type')
  const shareableId = searchParams.get('shareable_id')

  if (!shareableType || !shareableId) {
    return NextResponse.json({ error: 'shareable_type and shareable_id required' }, { status: 400 })
  }

  // Listing a capture's share links leaks its existence (and, for email shares,
  // the recipients) — gate it on the capture being visible to this caller. The
  // user-scoped client makes RLS the backstop; the null check turns an
  // invisible/private capture into a 404 rather than an empty list.
  if (shareableType === 'capture') {
    const { data: capture } = await supabase
      .from('captures')
      .select('id')
      .eq('id', shareableId)
      .eq('workspace_id', workspaceId)
      .or(`visibility.eq.workspace,user_id.eq.${user.id}`)
      .maybeSingle()
    if (!capture) {
      return NextResponse.json({ error: 'Capture not found' }, { status: 404 })
    }
  } else if (shareableType === 'document') {
    // The same for a document: RLS hides someone else's private one
    // (document_select, migration 369), so it 404s here.
    const { data: doc } = await supabase
      .from('document')
      .select('id')
      .eq('id', shareableId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }
  }

  const { data: shares, error } = await supabase
    .from('share')
    .select(`*, created_by_member:member!created_by(display_name)`)
    .eq('workspace_id', workspaceId)
    .eq('shareable_type', shareableType)
    .eq('shareable_id', shareableId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Comment count for this shareable. Post-migration 088, comments from
  // share-link visitors live in the unified `comment` table (not the legacy
  // `share_comment`). The count is per-commentable, not per-share — all
  // shares on the same item report the same number.
  const { count: sharedCommentCount } = await supabase
    .from('comment')
    .select('id', { count: 'exact', head: true })
    .eq('commentable_type', shareableType)
    .eq('commentable_id', shareableId)

  const appUrl = appAddress()
  const result = (shares || []).map((s) => ({
    ...s,
    share_url: `${appUrl}/s/${s.share_token}`,
    created_by_name:
      (s.created_by_member as { display_name: string } | null)?.display_name ?? null,
    comment_count: sharedCommentCount ?? 0,
    created_by_member: undefined,
  }))

  return NextResponse.json({ shares: result })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()
  if (!member) return NextResponse.json({ error: 'Not a member' }, { status: 403 })

  const body = await request.json()
  const {
    shareable_type,
    shareable_id,
    share_type,
    access_level = 'view',
    shared_with_email,
    show_transcript = false,
    show_ai_summary = true,
    show_decisions = true,
    expires_at,
  } = body

  if (!shareable_type || !shareable_id || !share_type) {
    return NextResponse.json(
      { error: 'shareable_type, shareable_id, and share_type are required' },
      { status: 400 },
    )
  }

  if (!['capture', 'document'].includes(shareable_type)) {
    return NextResponse.json({ error: 'shareable_type must be capture or document' }, { status: 400 })
  }

  if (!['link', 'email'].includes(share_type)) {
    return NextResponse.json({ error: 'share_type must be link or email' }, { status: 400 })
  }

  if (share_type === 'email' && !shared_with_email) {
    return NextResponse.json({ error: 'shared_with_email required for email shares' }, { status: 400 })
  }

  // Verify the shareable item exists and belongs to this workspace. For
  // captures we also read visibility/user_id: an invisible capture must 404
  // (never confirm it exists), and a PRIVATE one may only be shared outward by
  // its creator — publishing someone else's "Only me" capture to a public link
  // would defeat the whole scope.
  if (shareable_type === 'capture') {
    const { data: capture } = await supabase
      .from('captures')
      .select('id, user_id, visibility')
      .eq('id', shareable_id)
      .eq('workspace_id', workspaceId)
      .or(`visibility.eq.workspace,user_id.eq.${user.id}`)
      .maybeSingle()

    if (!capture) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }
    if (capture.visibility === 'private' && capture.user_id !== user.id) {
      return NextResponse.json(
        { error: 'Only the capture creator can share a private capture' },
        { status: 403 },
      )
    }
  } else {
    // RLS hides someone else's private document (migration 369), so only its
    // creator can share one: anyone else gets the 404.
    const { data: item } = await supabase
      .from('document')
      .select('id, kind')
      .eq('id', shareable_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()

    if (!item) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }
    // The person's Now file (migration 440) is theirs alone: never a share link.
    if ((item as { kind?: unknown }).kind === NOW_KEY) {
      return NextResponse.json({ error: NOW_PRIVATE_REFUSAL }, { status: 403 })
    }
  }

  // For link shares: check if one already exists and return it
  if (share_type === 'link') {
    const { data: existing } = await supabase
      .from('share')
      .select('*')
      .eq('shareable_type', shareable_type)
      .eq('shareable_id', shareable_id)
      .eq('share_type', 'link')
      .eq('is_active', true)
      .single()

    if (existing) {
      const appUrl = appAddress()
      return NextResponse.json({
        share: { ...existing, share_url: `${appUrl}/s/${existing.share_token}` },
        existing: true,
      })
    }
  }

  const share_token = generateShareToken()
  const appUrl = appAddress()

  const { data: share, error } = await supabase
    .from('share')
    .insert({
      workspace_id: workspaceId,
      shareable_type,
      shareable_id,
      share_type,
      access_level,
      shared_with_email: share_type === 'email' ? shared_with_email : null,
      share_token,
      show_transcript,
      show_ai_summary,
      show_decisions,
      expires_at: expires_at || null,
      created_by: member.id,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Notify email share recipients who are workspace members (non-blocking)
  if (share_type === 'email' && shared_with_email) {
    // Find if the email belongs to a workspace member. There is no
    // member.email column; the sign-in address is resolved through the admin
    // API (workspace-member-emails.ts).
    const recipientMember = await findMemberByEmail(workspaceId, shared_with_email)

    if (recipientMember) {
      // Get the shared item title
      let itemTitle = 'an item'
      if (shareable_type === 'capture') {
        const { data: cap } = await supabase.from('captures').select('title').eq('id', shareable_id).single()
        itemTitle = cap?.title || itemTitle
      } else if (shareable_type === 'document') {
        const { data: doc } = await supabase.from('document').select('title').eq('id', shareable_id).single()
        itemTitle = doc?.title || itemTitle
      }

      // Get actor member
      const { data: actorMember } = await supabase
        .from('member')
        .select('id, display_name')
        .eq('user_id', user.id)
        .eq('workspace_id', workspaceId)
        .single()

      if (actorMember) {
        createNotification({
          workspaceId,
          recipientId: recipientMember.id,
          type: 'capture_shared',
          title: `${actorMember.display_name || 'Someone'} shared "${itemTitle}" with you`,
          actorId: actorMember.id,
          targetType: shareable_type,
          targetId: shareable_id,
        })
      }
    }
  }

  return NextResponse.json({
    share: { ...share, share_url: `${appUrl}/s/${share.share_token}` },
  })
}
