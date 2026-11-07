import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'
import { buildContactProfile, type EnrollmentRow } from '@/lib/voice-prototypes'
import { l2Normalize } from '@/lib/voice-id-matching'

/** Fetch page size — PostgREST silently caps unbounded selects at 1000 rows. */
const PAGE_SIZE = 1000

/** Defensive server-side cap on enrollment rows per contact per request. */
const MAX_ENROLLMENTS_PER_CONTACT_PER_REQUEST = 10

/**
 * GET /api/account/voice-enrollments
 *
 * Returns all voice enrollments for the workspace, aggregated per contact
 * into per-session PROTOTYPE embeddings (see src/lib/voice-prototypes.ts)
 * plus trust data. `embedding` (the mean of the kept prototypes) is kept
 * for backward compatibility with clients that predate prototypes.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  // Fetch ALL enrollment rows, paginated — an unbounded select silently
  // truncates at 1000 rows, which would drop whole contacts from matching.
  type DbRow = {
    contact_id: string
    embedding: string | number[]
    session_id: string | null
    created_at: string | null
    contact: { full_name: string } | null
  }
  const rows: DbRow[] = []
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from('voice_enrollment')
      .select('contact_id, embedding, session_id, created_at, contact:contact_id(id, full_name)')
      .eq('workspace_id', workspaceId)
      // id as tiebreaker: rows from one batch insert share a created_at, and
      // offset pagination over tied keys drops/duplicates rows across pages.
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    rows.push(...((data as unknown as DbRow[]) || []))
    if (!data || data.length < PAGE_SIZE) break
  }

  // Fetch trust data for all contacts in this workspace
  const { data: trustRows } = await supabase
    .from('voice_contact_trust')
    .select('contact_id, confirmation_count, total_enrollment_count, correction_count')
    .eq('workspace_id', workspaceId)

  const trustMap = new Map<string, { confirmationCount: number; totalEnrollmentCount: number; correctionCount: number }>()
  for (const row of trustRows || []) {
    trustMap.set(row.contact_id, {
      confirmationCount: row.confirmation_count,
      totalEnrollmentCount: row.total_enrollment_count,
      correctionCount: row.correction_count ?? 0,
    })
  }

  // Group rows per contact
  const contactMap = new Map<string, { contactName: string; rows: EnrollmentRow[] }>()
  for (const row of rows) {
    const embedding = typeof row.embedding === 'string'
      ? JSON.parse(row.embedding)
      : row.embedding
    const entry = contactMap.get(row.contact_id)
    const enrollmentRow: EnrollmentRow = {
      embedding,
      session_id: row.session_id,
      created_at: row.created_at,
    }
    if (entry) {
      entry.rows.push(enrollmentRow)
    } else {
      contactMap.set(row.contact_id, {
        contactName: row.contact?.full_name || 'Unknown',
        rows: [enrollmentRow],
      })
    }
  }

  const result: unknown[] = []
  for (const [contactId, entry] of contactMap) {
    const profile = buildContactProfile(entry.rows)
    if (!profile) continue

    const trust = trustMap.get(contactId)
    result.push({
      contactId,
      contactName: entry.contactName,
      prototypes: profile.prototypes,
      /** @deprecated legacy single-centroid field — prefer `prototypes` */
      embedding: profile.centroid,
      enrollmentCount: profile.enrollmentCount,
      sessionCount: profile.sessionCount,
      droppedSessionCount: profile.droppedSessionCount,
      confirmationCount: trust?.confirmationCount ?? 0,
      totalEnrollmentCount: trust?.totalEnrollmentCount ?? profile.enrollmentCount,
      correctionCount: trust?.correctionCount ?? 0,
    })
  }

  return NextResponse.json({ enrollments: result })
}

/**
 * POST /api/account/voice-enrollments
 *
 * Save one or more voice enrollment records and optionally increment
 * confirmation counts. Called when a recording stops for HUMAN-CONFIRMED
 * speaker assignments (manual or accepted suggestion), and when the user
 * confirms an auto-assignment in post-session review. Auto-matches must
 * NOT be posted here without a human in the loop — self-confirmation is
 * how one wrong match trains the system on the wrong voice.
 *
 * Body: {
 *   enrollments: [{ contact_id, embedding: number[], session_id? }],
 *   confirmations?: [{ contact_id }]  // contacts to increment confirmation_count for
 * }
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const body = await request.json()
  const { enrollments, confirmations } = body as {
    enrollments: { contact_id: string; embedding: number[]; session_id?: string }[]
    confirmations?: { contact_id: string }[]
  }

  const hasEnrollments = Array.isArray(enrollments) && enrollments.length > 0
  const hasConfirmations = Array.isArray(confirmations) && confirmations.length > 0
  if (!hasEnrollments && !hasConfirmations) {
    return NextResponse.json({ error: 'No enrollments or confirmations provided' }, { status: 400 })
  }

  // Cap rows per contact — one long meeting must not flood a contact's
  // profile with hundreds of same-channel embeddings.
  const perContactSeen = new Map<string, number>()
  const capped = (enrollments || []).filter((e) => {
    if (!Array.isArray(e.embedding) || e.embedding.length === 0) return false
    const seen = perContactSeen.get(e.contact_id) || 0
    if (seen >= MAX_ENROLLMENTS_PER_CONTACT_PER_REQUEST) return false
    perContactSeen.set(e.contact_id, seen + 1)
    return true
  })

  // Validate every posted contact_id belongs to THIS workspace before writing.
  // Without this, a member could enroll a voiceprint onto a contact_id from
  // another workspace (the documented poisoning gap — voice_enrollment RLS is
  // workspace-wide FOR ALL, so the insert itself wouldn't stop it).
  //
  // Filter PER ROW rather than 403-ing the whole batch: at stop we enroll every
  // human-confirmed speaker at once, and a single stale contact_id (e.g. a
  // contact deleted mid-meeting) must not drop ALL the other, valid enrollments
  // and confirmations. Foreign rows are skipped (logged + reported); the rest
  // are written. The cross-workspace-write property holds row-wise.
  const referencedContactIds = new Set<string>([
    ...capped.map((e) => e.contact_id),
    ...(confirmations || []).map((c) => c.contact_id),
  ])
  let ownedIds = new Set<string>()
  if (referencedContactIds.size > 0) {
    const [{ data: ownedContacts, error: contactError }, { data: me }] = await Promise.all([
      supabase
        .from('contact')
        .select('id, member_id')
        .eq('workspace_id', workspaceId)
        .in('id', Array.from(referencedContactIds)),
      supabase.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle(),
    ])
    if (contactError) return NextResponse.json({ error: contactError.message }, { status: 500 })
    // The caller's OWN member-linked contact never gets a voice_enrollment
    // voiceprint: this table is workspace-readable, and the user's voice lives
    // in their owner-only user_voice_profile (followups issue 11 — linking your
    // own voice goes through /captures/[id]/self-confirm).
    const myMemberId = (me as { id: string } | null)?.id ?? null
    ownedIds = new Set(
      ((ownedContacts || []) as Array<{ id: string; member_id: string | null }>)
        .filter((c) => !myMemberId || c.member_id !== myMemberId)
        .map((c) => c.id),
    )
  }

  const skippedContactIds = new Set<string>()
  for (const contactId of referencedContactIds) {
    if (!ownedIds.has(contactId)) skippedContactIds.add(contactId)
  }
  if (skippedContactIds.size > 0) {
    console.warn(
      `[voice-enrollments] Skipped row(s) referencing contact_id(s) not in workspace ${workspaceId} or the caller's own contact:`,
      Array.from(skippedContactIds),
    )
  }

  // Keep only rows whose contact_id belongs to this workspace.
  const acceptedEnrollments = capped.filter((e) => ownedIds.has(e.contact_id))
  const acceptedConfirmations = (confirmations || []).filter((c) => ownedIds.has(c.contact_id))

  if (acceptedEnrollments.length > 0) {
    // Insert enrollment rows (unit-norm so future aggregation/pgvector ops
    // never mix magnitudes; legacy rows are re-normalized at read time).
    const rows = acceptedEnrollments.map((e) => ({
      workspace_id: workspaceId,
      contact_id: e.contact_id,
      embedding: JSON.stringify(l2Normalize(e.embedding)),
      session_id: e.session_id || null,
    }))

    const { error } = await supabase.from('voice_enrollment').insert(rows)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Count new enrollments per contact for trust update
  const enrollmentCounts = new Map<string, number>()
  for (const e of acceptedEnrollments) {
    enrollmentCounts.set(e.contact_id, (enrollmentCounts.get(e.contact_id) || 0) + 1)
  }

  // Confirmations: at most ONE per contact per request. A session is a single
  // observation of a person — duplicate entries (e.g. two speaker labels
  // merged onto one contact) must not double-increment trust.
  const confirmationCounts = new Map<string, number>()
  for (const c of acceptedConfirmations) {
    confirmationCounts.set(c.contact_id, 1)
  }

  // Upsert trust rows — increment counters
  const allContactIds = new Set([...enrollmentCounts.keys(), ...confirmationCounts.keys()])
  for (const contactId of allContactIds) {
    const newEnrollments = enrollmentCounts.get(contactId) || 0
    const newConfirmations = confirmationCounts.get(contactId) || 0

    // Try to fetch existing trust row
    const { data: existing } = await supabase
      .from('voice_contact_trust')
      .select('id, confirmation_count, total_enrollment_count')
      .eq('workspace_id', workspaceId)
      .eq('contact_id', contactId)
      .single()

    if (existing) {
      await supabase
        .from('voice_contact_trust')
        .update({
          confirmation_count: existing.confirmation_count + newConfirmations,
          total_enrollment_count: existing.total_enrollment_count + newEnrollments,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
    } else {
      await supabase
        .from('voice_contact_trust')
        .insert({
          workspace_id: workspaceId,
          contact_id: contactId,
          confirmation_count: newConfirmations,
          total_enrollment_count: newEnrollments,
        })
    }
  }

  return NextResponse.json({
    created: acceptedEnrollments.length,
    confirmed: confirmationCounts.size,
    skippedCount: skippedContactIds.size,
    skippedContactIds: Array.from(skippedContactIds),
  })
}
