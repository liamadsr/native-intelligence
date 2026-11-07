import { redirect } from 'next/navigation'
import { getServiceClient } from '@/lib/admin'
import { createClient } from '@/lib/supabase/server'
import { shareTargetAllowed } from '@/lib/share-target'
import type { ProposedChange } from '@/lib/proposed-changes/types'
import { SharedViewClient, type ShareIdentity } from './shared-view-client'
import type { Metadata } from 'next'

// Shared capture/document links are per-recipient and must never be indexed.
export const metadata: Metadata = {
  title: 'Shared capture',
  robots: { index: false, follow: false },
}

interface PageProps {
  params: Promise<{ token: string }>
}

/**
 * Derive the denormalized name/avatar for a Supabase user, preferring
 * their `member` row in the share's workspace when present.
 */
function deriveAuthedIdentity(
  user: { id: string; email?: string; user_metadata?: Record<string, unknown> },
  member?: { id: string; display_name: string | null; avatar_url: string | null } | null,
): ShareIdentity {
  const meta = user.user_metadata || {}
  const name =
    member?.display_name ||
    (typeof meta.full_name === 'string' && meta.full_name) ||
    (typeof meta.name === 'string' && meta.name) ||
    user.email?.split('@')[0] ||
    'You'
  const avatar =
    member?.avatar_url ||
    (typeof meta.avatar_url === 'string' && meta.avatar_url) ||
    (typeof meta.picture === 'string' && meta.picture) ||
    null
  return {
    mode: 'authenticated',
    userId: user.id,
    memberId: member?.id ?? null,
    displayName: name,
    avatarUrl: avatar,
  }
}

export default async function SharedViewPage({ params }: PageProps) {
  const { token } = await params
  const service = getServiceClient()

  // Look up share by token
  const { data: share } = await service
    .from('share')
    .select('*')
    .eq('share_token', token)
    .eq('is_active', true)
    .single()

  if (!share) return <SharedViewError status={404} />

  // Check expiry
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return <SharedViewError status={410} />
  }

  // The item must be in the share's workspace, and a private one opens only
  // from its creator's share (src/lib/share-target.ts).
  if (!(await shareTargetAllowed(service, share))) return <SharedViewError status={404} />

  // Resolve the current viewer's identity. Three cases:
  //   1. Signed out              → guest (CTA to create an account)
  //   2. Signed in + member      → stay here, comment as that member
  //   3. Signed in + not member  → stay here, comment as external user
  // Members are not redirected into the app: the dashboard is a tab shell with
  // no /account/captures/[id] page, and a Server Component may not write the
  // workspace cookie a cross-workspace redirect would need (Next throws).
  const authedSupabase = await createClient()
  const {
    data: { user },
  } = await authedSupabase.auth.getUser()

  // An email share is for one person: they sign in, and only that address
  // may open it. Anyone else gets the same "not available" page as a revoked
  // link.
  if (share.share_type === 'email') {
    if (!user) redirect(`/login?redirect=${encodeURIComponent(`/s/${token}`)}`)
    if (!emailShareAllows(share, user)) return <SharedViewError status={404} />
  }

  let identity: ShareIdentity = { mode: 'guest' }
  if (user) {
    const { data: member } = await service
      .from('member')
      .select('id, display_name, avatar_url, workspace_id')
      .eq('user_id', user.id)
      .eq('workspace_id', share.workspace_id)
      .maybeSingle()

    identity = deriveAuthedIdentity(user, member)
  }

  if (share.shareable_type === 'capture') {
    const { data: capture } = await service
      .from('captures')
      .select(
        `id, title, content, summary, user_notes, ai_summary, transcript,
         duration_seconds, started_at, ended_at, recorded_at, created_at`,
      )
      .eq('id', share.shareable_id)
      .single()

    if (!capture) return <SharedViewError status={404} />

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

    // Proposed changes (pending + applied). Rendered inline as atom nodes,
    // only when the owner left "Decisions" on for this share.
    const { data: proposedChanges } = share.show_decisions
      ? await service
          .from('proposed_change')
          .select('*')
          .eq('capture_id', share.shareable_id)
          .neq('status', 'dismissed')
          .order('sort_order', { ascending: true })
      : { data: [] as ProposedChange[] }

    // Unified comment stream — same table the app reads.
    const { data: commentRows } = await service
      .from('comment')
      .select(
        `id, body, author_id, author_user_id, author_name, author_avatar_url,
         parent_id, commentable_type, commentable_id, created_at, edited_at,
         anchor_text, anchor_prefix, anchor_suffix, anchor_section,
         anchor_occurrence, is_resolved,
         author_member:member!author_id(display_name, avatar_url)`,
      )
      .eq('commentable_type', 'capture')
      .eq('commentable_id', share.shareable_id)
      .order('created_at', { ascending: true })

    const comments = (commentRows || []).map((c) => flattenCommentRow(c))

    // Content source matches the authenticated capture view.
    const rawSummary =
      capture.ai_summary === '{{streaming}}' ? '' : capture.ai_summary
    // "AI Summary" off for this share → the summary document is not shown.
    const mergedContent = share.show_ai_summary
      ? rawSummary || capture.summary || capture.content || null
      : null

    return (
      <SharedViewClient
        data={{
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
          comments,
        }}
        identity={identity}
        token={token}
      />
    )
  }

  if (share.shareable_type === 'document') {
    const { data: doc } = await service
      .from('document')
      .select('id, title, content, created_at, updated_at')
      .eq('id', share.shareable_id)
      .single()

    if (!doc) return <SharedViewError status={404} />

    const { data: commentRows } = await service
      .from('comment')
      .select(
        `id, body, author_id, author_user_id, author_name, author_avatar_url,
         parent_id, commentable_type, commentable_id, created_at, edited_at,
         anchor_text, anchor_prefix, anchor_suffix, anchor_section,
         anchor_occurrence, is_resolved,
         author_member:member!author_id(display_name, avatar_url)`,
      )
      .eq('commentable_type', 'document')
      .eq('commentable_id', share.shareable_id)
      .order('created_at', { ascending: true })

    const comments = (commentRows || []).map((c) => flattenCommentRow(c))

    return (
      <SharedViewClient
        data={{
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
          comments,
        }}
        identity={identity}
        token={token}
      />
    )
  }

  return <SharedViewError status={404} />
}

/** An email share opens only for the address it was sent to (case-insensitive). */
function emailShareAllows(
  share: { shared_with_email: string | null },
  user: { email?: string },
): boolean {
  const want = share.shared_with_email?.trim().toLowerCase()
  return !!want && user.email?.trim().toLowerCase() === want
}

/**
 * Proposed changes as a share viewer may see them: the rows reach the client
 * (RSC payload), so blank what the read-only card does not need to show —
 * internal ids, email recipients and bodies, MCP call args, apply errors — and
 * the transcript quote unless the share shows the transcript.
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

/** Flatten a joined `comment` row into the shape the client/adapters expect. */
function flattenCommentRow(c: Record<string, unknown>) {
  const memberAuthor = c.author_member as
    | { display_name: string | null; avatar_url: string | null }
    | null
  return {
    id: c.id as string,
    body: c.body as string,
    content: c.body as string,
    author_id: (c.author_id as string | null) ?? null,
    author_user_id: (c.author_user_id as string | null) ?? null,
    author_name:
      memberAuthor?.display_name ||
      (c.author_name as string | null) ||
      'Anonymous',
    author_avatar:
      memberAuthor?.avatar_url ||
      (c.author_avatar_url as string | null) ||
      null,
    parent_id: (c.parent_id as string | null) ?? null,
    created_at: c.created_at as string,
    edited_at: (c.edited_at as string | null) ?? null,
    anchor_text: (c.anchor_text as string | null) ?? null,
    anchor_prefix: (c.anchor_prefix as string | null) ?? null,
    anchor_suffix: (c.anchor_suffix as string | null) ?? null,
    anchor_section: (c.anchor_section as string | null) ?? null,
    anchor_occurrence: (c.anchor_occurrence as number | null) ?? null,
    is_resolved: !!c.is_resolved,
  }
}

function SharedViewError({ status }: { status: number }) {
  const isExpired = status === 410

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {isExpired ? 'This link has expired' : 'Link not available'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isExpired
              ? 'The owner set an expiration date on this shared link.'
              : 'This shared link is no longer available or may have been revoked.'}
          </p>
        </div>
        <div className="pt-4">
          <a
            href="https://dial8.ai"
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try Dial8
          </a>
        </div>
      </div>
    </div>
  )
}

export const dynamic = 'force-dynamic'
