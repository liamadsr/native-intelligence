import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/admin'
import { getCurrentWorkspaceIdOrResponse, WORKSPACE_COOKIE } from '@/lib/workspace'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { forbidden, serverError } from '@/lib/api-errors'
import { ensureMemberContact } from '@/lib/crm/contacts'
import { seedDefaultLoops } from '@/lib/flows/seed-default-loops'
import { EDITION_SOURCE_KEY, isEditionId } from '@/lib/editions'
import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceIdOrResponse()
  if (workspaceId instanceof Response) return workspaceId
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }

  const [
    { data: workspace, error: wsError },
    { data: members },
    { data: invites },
    { data: currentMember },
    { data: aiMembersRaw },
  ] = await Promise.all([
    supabase.from('workspace').select('*').eq('id', workspaceId).single(),
    supabase
      .from('member')
      .select('id, user_id, display_name, avatar_url, role, created_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: true }),
    supabase
      .from('invite')
      .select('id, email, role, expires_at, created_at, accepted_at')
      .eq('workspace_id', workspaceId)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }),
    supabase
      .from('member')
      .select('id, role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .single(),
    // AI team members are assignable to actions alongside humans. They live on
    // teams but are surfaced workspace-wide here so the shared assignee picker
    // can offer them. De-duped by id below (the same agent can sit on N teams,
    // but each ai_team_member row is its own distinct teammate).
    // System teammates (row 4) are attribution for built-in loops, not
    // assignees: they never reach the picker.
    supabase
      .from('ai_team_member')
      .select('id, name, avatar_url, team_id, created_at')
      .eq('workspace_id', workspaceId)
      .eq('is_system', false)
      // A work bot (bots-v3 Phase 3) takes no assignments: out of the assignee list.
      .eq('fronts_only', false)
      .order('created_at', { ascending: true }),
  ])

  if (wsError) {
    return NextResponse.json({ error: wsError.message }, { status: 500 })
  }

  // Fetch emails for members via service client — one getUserById per member,
  // bounded by workspace size. Deliberately NOT listAllAuthUsers: that pages
  // the ENTIRE product user base through the GoTrue admin API on every request
  // just to map a handful of member emails, and grows a sequential round trip
  // per 1,000 signups.
  // Chunked to EMAIL_LOOKUP_CONCURRENCY parallel lookups rather than one
  // unbounded Promise.all: this is the hottest route in the app, and a large
  // workspace would otherwise burst one simultaneous GoTrue admin HTTP request
  // per member from a single lambda — exactly the load shape that makes the
  // heaviest request slower and trips per-project Auth API throttling.
  // (Long-term: a SECURITY DEFINER RPC over auth.users, or denormalizing the
  // email onto the member row, removes the fan-out entirely.)
  // Each lookup fails soft so a misconfigured service-role key in preview/dev
  // environments doesn't 500 the whole route — a failed member just renders
  // without an email ('' via the fallback below) rather than failing the request.
  const service = getServiceClient()
  const memberUserIds = members?.map((m) => m.user_id) ?? []
  const emailMap: Record<string, string> = {}

  const EMAIL_LOOKUP_CONCURRENCY = 10
  for (let i = 0; i < memberUserIds.length; i += EMAIL_LOOKUP_CONCURRENCY) {
    await Promise.all(
      memberUserIds.slice(i, i + EMAIL_LOOKUP_CONCURRENCY).map(async (id) => {
        try {
          const { data, error } = await service.auth.admin.getUserById(id)
          if (!error && data?.user) {
            emailMap[id] = data.user.email ?? ''
          }
        } catch {
          // Admin user lookup failed (e.g. service role key mismatch in
          // preview env). Return this member without an email.
        }
      }),
    )
  }

  const membersWithEmail = members?.map((m) => ({
    ...m,
    email: emailMap[m.user_id] ?? '',
  }))

  // Shape AI team members as assignable options for the shared picker.
  const aiMembers = (aiMembersRaw ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    avatar_url: m.avatar_url,
    team_id: m.team_id,
  }))

  return NextResponse.json({
    workspace,
    members: membersWithEmail ?? [],
    aiMembers,
    invites: invites ?? [],
    currentRole: currentMember?.role ?? null,
    currentMemberId: currentMember?.id ?? null,
  })
}

export async function PATCH(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceIdOrResponse()
  if (workspaceId instanceof Response) return workspaceId
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 })
  }

  const body = await request.json()
  const updates: Record<string, unknown> = {}

  if (body.name !== undefined) updates.name = body.name
  if (body.slug !== undefined) {
    const slug = body.slug.toLowerCase().replace(/[^a-z0-9-]/g, '')
    if (!slug) {
      return NextResponse.json({ error: 'Invalid slug' }, { status: 400 })
    }
    // Check uniqueness
    const { data: existing } = await supabase
      .from('workspace')
      .select('id')
      .eq('slug', slug)
      .neq('id', workspaceId)
      .single()
    if (existing) {
      return NextResponse.json(
        { error: 'Slug already taken' },
        { status: 409 },
      )
    }
    updates.slug = slug
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('workspace')
    .update(updates)
    .eq('id', workspaceId)
    .select()
    .single()

  if (error) {
    // The pre-check above only sees workspaces the caller belongs to (RLS), so
    // a slug owned by another workspace surfaces here as the unique index.
    if (error.code === '23505' && updates.slug !== undefined) {
      return NextResponse.json({ error: 'Slug already taken' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ workspace: data })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const name = (body.name ?? '').trim()
  if (!name) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 })
  }

  // Optional persona edition. Only a REAL id is honored — an unknown value is
  // ignored rather than coerced, so the workspace falls through to the `full`
  // default instead of recording a typo as a deliberate choice.
  const edition = isEditionId(body.edition) ? body.edition : null

  // Generate slug from name
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  if (!slug) slug = 'workspace'
  slug = `${slug}-${user.id.slice(0, 8)}`

  // Use service client to bypass RLS — the SELECT after INSERT fails because
  // the user isn't a member yet (workspace SELECT policy requires membership).
  const service = getServiceClient()

  // Check slug uniqueness
  const { data: existing } = await service
    .from('workspace')
    .select('id')
    .eq('slug', slug)
    .single()
  if (existing) {
    slug = `${slug}-${Date.now().toString(36)}`
  }

  // Create workspace
  const { data: workspace, error: wsError } = await service
    .from('workspace')
    // A picked edition is a choice (edition_source 'chosen'): a business
    // profile later never replaces it (adoptBusinessEdition).
    .insert({ name, slug, ...(edition ? { settings: { edition, [EDITION_SOURCE_KEY]: 'chosen' } } : {}) })
    .select()
    .single()

  if (wsError) {
    return NextResponse.json({ error: wsError.message }, { status: 500 })
  }

  // Create owner member record
  const displayName =
    user.user_metadata?.full_name ??
    user.user_metadata?.name ??
    user.email?.split('@')[0] ??
    'User'

  // Mark onboarding as completed — this is an existing user creating an
  // additional workspace, so they should not be routed through onboarding again.
  const { data: newMember, error: memberError } = await service.from('member').insert({
    user_id: user.id,
    workspace_id: workspace.id,
    role: 'owner',
    display_name: displayName,
    onboarding_completed_at: new Date().toISOString(),
  }).select('id').single()

  if (memberError) {
    await service.from('workspace').delete().eq('id', workspace.id)
    return NextResponse.json({ error: memberError.message }, { status: 500 })
  }

  // Create CRM contact for the workspace owner
  await ensureMemberContact(workspace.id, newMember.id, user)

  // Seed the default loop, Triage (GEN-148). Best-effort: a seeding failure must
  // never fail workspace creation — the workspace + owner already committed,
  // and seeding is idempotent (re-runnable). Log and continue. created_by is
  // the creator's auth id (user.id), which is exactly the run-as identity the
  // flow dispatchers honor. See docs/loop-engine/SEED-LOOPS-DESIGN.md.
  try {
    await seedDefaultLoops(service, {
      workspaceId: workspace.id,
      createdByUserId: user.id,
    })
  } catch (err) {
    console.error('[workspace.create] seed-default-loops failed', {
      workspaceId: workspace.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // Switch to the new workspace
  const cookieStore = await cookies()
  cookieStore.set(WORKSPACE_COOKIE, workspace.id, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  })

  return NextResponse.json({ workspace }, { status: 201 })
}

/**
 * DELETE /api/account/workspace
 *
 * Permanently deletes the current workspace and all its data.
 * Only the workspace owner may call this.
 * Clears the workspace cookie so the session falls through to the next
 * available workspace (or the empty state if there are none).
 */
export async function DELETE() {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { workspaceId, member } = auth

  if (member.role !== 'owner') {
    return forbidden('Only the workspace owner can delete this workspace')
  }

  const service = getServiceClient()

  // Collect storage paths before the cascade nukes the attachments rows.
  // Paged so workspaces with many attachments don't blow past PostgREST's
  // 1000-row default cap.
  const storagePaths: string[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await service
      .from('attachments')
      .select('storage_path')
      .eq('workspace_id', workspaceId)
      .not('storage_path', 'is', null)
      .range(from, from + PAGE - 1)
    if (error) return serverError(error.message)
    if (!data || data.length === 0) break
    for (const row of data) if (row.storage_path) storagePaths.push(row.storage_path)
    if (data.length < PAGE) break
  }

  // Delete the workspace row — DB foreign keys cascade to all workspace-
  // scoped tables (captures, actions, contacts, attachments, …).
  const { error } = await service
    .from('workspace')
    .delete()
    .eq('id', workspaceId)

  if (error) return serverError(error.message)

  // Storage objects aren't cascaded by the FK delete — remove them in
  // chunks. Best-effort: log and continue on partial failures so the user
  // still sees the workspace gone. Orphans can be reaped later.
  if (storagePaths.length > 0) {
    const REMOVE_CHUNK = 500
    for (let i = 0; i < storagePaths.length; i += REMOVE_CHUNK) {
      const chunk = storagePaths.slice(i, i + REMOVE_CHUNK)
      const { error: rmErr } = await service.storage.from('attachments').remove(chunk)
      if (rmErr) {
        console.error('[workspace.delete] storage cleanup failed', {
          workspaceId,
          chunkSize: chunk.length,
          error: rmErr.message,
        })
      }
    }
  }

  // Clear the workspace cookie so the next request resolves a different
  // workspace (or the empty state if none remain).
  const cookieStore = await cookies()
  cookieStore.delete(WORKSPACE_COOKIE)

  return NextResponse.json({ ok: true })
}
