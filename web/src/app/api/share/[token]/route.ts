import { getServiceClient } from '@/lib/admin'
import { createClient } from '@/lib/supabase/server'
import { shareTargetAllowed } from '@/lib/share-target'
import { NextResponse, type NextRequest } from 'next/server'
import type { ProposedChange } from '@/lib/proposed-changes/types'
import { isNowDocument } from '@/lib/now/now-stamp'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const service = getServiceClient()

  // Look up share by token
  const { data: share } = await service
    .from('share')
    .select('*')
    .eq('share_token', token)
    .eq('is_active', true)
    .single()

  // Return same error for not-found, expired, and revoked (no enumeration)
  if (!share) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // Check expiry
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return NextResponse.json({ error: 'expired' }, { status: 410 })
  }

  // An email share opens only for the signed-in address it was sent to.
  if (share.share_type === 'email') {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    const want = share.shared_with_email?.trim().toLowerCase()
    if (!want || user?.email?.trim().toLowerCase() !== want) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
  }

  // The item must be in the share's workspace, and a private one opens only
  // from its creator's share: a forged row reads nothing.
  if (!(await shareTargetAllowed(service, share))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // Fetch the shared item
  if (share.shareable_type === 'capture') {
    const { data: capture } = await service
      .from('captures')
      .select(
        `id, title, content, summary, user_notes, ai_summary, transcript,
         duration_seconds, started_at, ended_at, recorded_at, created_at`,
      )
      .eq('id', share.shareable_id)
      .single()

    if (!capture) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }

    // Fetch participants (names only, no emails or member IDs)
    const { data: participants } = await service
      .from('capture_participant')
      .select('external_name, role, member:member!member_id(display_name)')
      .eq('capture_id', share.shareable_id)

    const safeParticipants = (participants || []).map((p) => ({
      name:
        (p.member as unknown as { display_name: string } | null)?.display_name ||
        p.external_name ||
        'Unknown',
      role: p.role || 'attendee',
    }))

    // Fetch proposed changes (pending + applied). These render inline in the
    // merged capture document; dismissed ones are filtered out. Only when the
    // owner left "Decisions" on for this share.
    const { data: proposedChanges } = share.show_decisions
      ? await service
          .from('proposed_change')
          .select('*')
          .eq('capture_id', share.shareable_id)
          .neq('status', 'dismissed')
          .order('sort_order', { ascending: true })
      : { data: [] as ProposedChange[] }

    // Unified comment stream (post-migration 088). Both workspace-member and
    // external-commenter comments live on the same `comment` table; the share
    // page and the dashboard both read from here.
    const { data: comments } = await service
      .from('comment')
      .select(
        `id, body, author_id, author_user_id, author_name, author_avatar_url,
         parent_id, created_at, edited_at, anchor_text, anchor_prefix,
         anchor_suffix, anchor_section, anchor_occurrence, is_resolved`,
      )
      .eq('commentable_type', share.shareable_type)
      .eq('commentable_id', share.shareable_id)
      .order('created_at', { ascending: true })

    // Match the merged-editor content source used by the authenticated view.
    const rawSummary =
      capture.ai_summary === '{{streaming}}' ? '' : capture.ai_summary
    // "AI Summary" off for this share → the summary document is not returned.
    const mergedContent = share.show_ai_summary
      ? rawSummary || capture.summary || capture.content || null
      : null

    return NextResponse.json({
      type: 'capture',
      share: {
        access_level: share.access_level,
        created_at: share.created_at,
        expires_at: share.expires_at,
      },
      capture: {
        title: capture.title,
        content: mergedContent,
        transcript: share.show_transcript ? capture.transcript : undefined,
        participants: safeParticipants,
        started_at: capture.started_at,
        ended_at: capture.ended_at,
        duration_seconds: capture.duration_seconds,
        created_at: capture.created_at,
      },
      proposedChanges: publicProposals(proposedChanges, share.show_transcript),
      comments: comments || [],
    })
  }

  if (share.shareable_type === 'document') {
    const { data: doc } = await service
      .from('document')
      .select('id, title, content, created_at, updated_at, frontmatter')
      .eq('id', share.shareable_id)
      .single()

    // The person's Now file (migration 440) never opens from a link, whatever
    // share row names it: the shares route refuses to make one, but a row
    // written another way still reads here on the service client.
    if (!doc || isNowDocument(doc.frontmatter)) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }

    // Unified comment stream (post-migration 088). Both workspace-member and
    // external-commenter comments live on the same `comment` table; the share
    // page and the dashboard both read from here.
    const { data: comments } = await service
      .from('comment')
      .select(
        `id, body, author_id, author_user_id, author_name, author_avatar_url,
         parent_id, created_at, edited_at, anchor_text, anchor_prefix,
         anchor_suffix, anchor_section, anchor_occurrence, is_resolved`,
      )
      .eq('commentable_type', share.shareable_type)
      .eq('commentable_id', share.shareable_id)
      .order('created_at', { ascending: true })

    return NextResponse.json({
      type: 'document',
      share: {
        access_level: share.access_level,
        created_at: share.created_at,
        expires_at: share.expires_at,
      },
      document: {
        title: doc.title,
        content: doc.content,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
      },
      comments: comments || [],
    })
  }

  return NextResponse.json({ error: 'not_found' }, { status: 404 })
}

/**
 * Proposed changes as a public share viewer may see them: blank what the
 * read-only card does not need — internal ids, email recipients and bodies,
 * MCP call args, apply errors — and the transcript quote unless the share
 * shows the transcript. Mirrors publicProposals in src/app/s/[token]/page.tsx.
 */
function publicProposals(
  rows: ProposedChange[] | null,
  showTranscript: boolean,
): ProposedChange[] {
  return (rows || []).map((c) => ({
    ...c,
    trigger_quote: showTranscript ? c.trigger_quote : null,
    assignee_member_id: null,
    assignee_contact_id: null,
    email_to_address: null,
    email_context: null,
    extra: null,
    applied_by: null,
    error_message: null,
  }))
}
