/**
 * Cascade-delete companies together with all their contacts.
 *
 * contact.company_id is ON DELETE SET NULL (migration 033), so a bare company
 * delete orphans its contacts. Product behavior is "delete company ⇒ delete
 * its people", which we implement in application code rather than changing
 * the FK.
 *
 * This MUST run on the service client, not the caller's RLS client: the
 * contact_delete policy (migration 058) is creator-or-admin and private
 * contacts are invisible to other members, so an RLS cascade would silently
 * skip rows and leave a half-deleted company. Because the service client
 * bypasses that authorization rule (not just a visibility filter), CALLERS
 * MUST gate this on an owner/admin role check in addition to workspace
 * membership, and every query here is scoped to the verified workspace.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Max ids per `.in()` list. PostgREST encodes `.in()` filters into the request
 * URL, and oversized id lists have blown the URL limit before (see the
 * transcript-append outage) — keep batches small.
 */
const CHUNK_SIZE = 100

/** PostgREST caps a response at 1000 rows — reads must paginate past it. */
const PAGE_SIZE = 1000

export interface DeleteCompaniesResult {
  /** Companies verified in-workspace (dry run) or actually deleted. */
  companies: number
  /**
   * People belonging to those companies. Merged tombstones are deleted with
   * the company but excluded from this count, so the number shown in the
   * delete confirmation matches what the People tab shows.
   */
  contacts: number
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export async function deleteCompaniesWithContacts(
  serviceClient: SupabaseClient,
  workspaceId: string,
  companyIds: string[],
  opts: { dryRun?: boolean } = {},
): Promise<DeleteCompaniesResult> {
  if (companyIds.length === 0) return { companies: 0, contacts: 0 }

  // 1. Verify which of the requested ids actually exist in this workspace —
  //    everything below operates only on verified ids.
  const verifiedIds: string[] = []
  for (const batch of chunk(companyIds, CHUNK_SIZE)) {
    const { data, error } = await serviceClient
      .from('company')
      .select('id')
      .in('id', batch)
      .eq('workspace_id', workspaceId)
    if (error) throw new Error(`company lookup failed: ${error.message}`)
    for (const row of (data ?? []) as { id: string }[]) verifiedIds.push(row.id)
  }
  if (verifiedIds.length === 0) return { companies: 0, contacts: 0 }

  // 2. Collect the contacts that die with these companies. Merged tombstones
  //    still carry company_id and go too, but they aren't people, so they're
  //    excluded from the reported count. Teammate self-contacts (member_id
  //    set) are NEVER deleted by a company cascade — they anchor member
  //    identity and voice enrollments (ON DELETE CASCADE would destroy
  //    those); the company_id FK's SET NULL simply detaches them when the
  //    company row goes. Paginate within each batch — a silently capped read
  //    here would both undercount the confirmation dialog and orphan
  //    contacts past the cap.
  const contactIds: string[] = []
  let peopleCount = 0
  for (const batch of chunk(verifiedIds, CHUNK_SIZE)) {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await serviceClient
        .from('contact')
        .select('id, merged_into_contact_id')
        .in('company_id', batch)
        .eq('workspace_id', workspaceId)
        .is('member_id', null)
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1)
      if (error) throw new Error(`contact lookup failed: ${error.message}`)
      const rows = (data ?? []) as { id: string; merged_into_contact_id: string | null }[]
      for (const row of rows) {
        contactIds.push(row.id)
        if (!row.merged_into_contact_id) peopleCount++
      }
      if (rows.length < PAGE_SIZE) break
    }
  }

  if (opts.dryRun) {
    return { companies: verifiedIds.length, contacts: peopleCount }
  }

  // 3. Proactively exit active sequence enrollments. Deleting the contact
  //    SET-NULLs enrollment.contact_id and the dispatcher would lazily exit
  //    it on next touch (sequence-functions.ts), but until then the
  //    enrollment shows as active in the UI — exit it now, mirroring
  //    exitEnrollment's write exactly.
  for (const batch of chunk(contactIds, CHUNK_SIZE)) {
    const { error } = await serviceClient
      .from('sequence_enrollment')
      .update({ status: 'exited', exit_reason: 'removed', next_send_at: null })
      .in('contact_id', batch)
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
    if (error) throw new Error(`enrollment exit failed: ${error.message}`)
  }

  // 4. Delete contacts, then companies.
  for (const batch of chunk(contactIds, CHUNK_SIZE)) {
    const { error } = await serviceClient
      .from('contact')
      .delete()
      .in('id', batch)
      .eq('workspace_id', workspaceId)
    if (error) throw new Error(`contact delete failed: ${error.message}`)
  }
  for (const batch of chunk(verifiedIds, CHUNK_SIZE)) {
    const { error } = await serviceClient
      .from('company')
      .delete()
      .in('id', batch)
      .eq('workspace_id', workspaceId)
    if (error) throw new Error(`company delete failed: ${error.message}`)
  }

  return { companies: verifiedIds.length, contacts: peopleCount }
}
