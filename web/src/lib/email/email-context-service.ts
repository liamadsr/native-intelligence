import { getServiceClient } from '@/lib/admin'
import { filterVisibleContacts } from '@/lib/crm/contact-visibility'
import { searchEmails } from './email-search-service'
import { applyCaptureVisibility, isCaptureVisible, type CaptureRequester } from '@/lib/ai/tools/_shared'

// =====================================================================
// Types
// =====================================================================

interface EmailWithContext {
  threadId: string
  subject: string
  from: { name: string | null; email: string }
  snippet: string
  date: string
  contact?: {
    id: string
    fullName: string
    companyName?: string
    relationshipType: string
  }
  relatedCaptures?: Array<{
    id: string
    title: string
    date: string
  }>
  relatedActions?: Array<{
    id: string
    title: string
    status: string
    dueDate?: string
  }>
}

// =====================================================================
// Search emails with workspace context attached
// =====================================================================

export async function searchEmailsWithContext(
  userId: string,
  workspaceId: string,
  query: string,
  limit = 10,
  // `grants: false` on a guest's or a linked agent's turn: a contact shared with the person names no sender.
  // `requester`: whose private captures a related meeting may come from (the search
  // tool's captureRequester). Absent or null, only workspace-visible captures.
  readOpts: { grants?: boolean; requester?: CaptureRequester } = {},
): Promise<EmailWithContext[]> {
  const supabase = getServiceClient()
  const requester = readOpts.requester ?? null

  // Search the mailboxes live (no stored mail): one row per thread, newest first.
  const { results: found } = await searchEmails(userId, workspaceId, { query, limit })
  if (!found.length) return []
  const threadMap = new Map<string, { subject: string; from_name: string | null; from_email: string; snippet: string; message_date: string }>()
  for (const r of found) {
    threadMap.set(r.threadId, { subject: r.subject, from_name: r.from.name, from_email: r.from.email, snippet: r.snippet, message_date: r.date })
  }

  // Collect all unique sender emails for batch contact lookup
  const senderEmails = new Set<string>()
  for (const match of threadMap.values()) {
    if (match.from_email) senderEmails.add(match.from_email.toLowerCase())
  }

  // Batch lookup contacts by email
  const contactMap = new Map<string, { id: string; full_name: string; email: string; relationship_type: string; company: unknown }>()
  if (senderEmails.size > 0) {
    const { data: contacts } = await supabase
      .from('contact')
      .select('id, full_name, email, relationship_type, company:company_id(name)')
      .eq('workspace_id', workspaceId)
      .in('email', Array.from(senderEmails))

    // Service role: the contact table's RLS does not hide another member's
    // private/team contact, so fence each row against the caller (fails closed).
    for (const c of await filterVisibleContacts(supabase, userId, contacts || [], readOpts)) {
      if (c.email) contactMap.set(c.email.toLowerCase(), c as unknown as typeof contactMap extends Map<string, infer V> ? V : never)
    }
  }

  const results: EmailWithContext[] = []
  let count = 0

  for (const [threadId, match] of threadMap) {
    if (count >= limit) break
    count++

    const result: EmailWithContext = {
      threadId,
      subject: match.subject || '(no subject)',
      from: { name: match.from_name, email: match.from_email },
      snippet: match.snippet || '',
      date: match.message_date,
    }

    // Attach contact info if available
    const contact = match.from_email ? contactMap.get(match.from_email.toLowerCase()) : null
    if (contact) {
      const company = contact.company as Record<string, unknown> | null
      result.contact = {
        id: contact.id,
        fullName: contact.full_name,
        companyName: (company?.name as string) || undefined,
        relationshipType: contact.relationship_type,
      }

      // Find recent captures with this contact (scoped to workspace). From the
      // captures side, newest first, once each: capture_participant has no
      // created_at (it has joined_at), and ordering by it failed every read.
      // Service role bypasses RLS, so the requester's capture visibility is
      // the fence (another member's private meeting and eval captures stay out).
      const { data: captures, error: capturesError } = await applyCaptureVisibility(
        supabase
          .from('captures')
          .select('id, title, started_at, user_id, visibility, is_eval, notes_owner_out, cp:capture_participant!inner(external_email)')
          .eq('workspace_id', workspaceId)
          .eq('cp.external_email', match.from_email.toLowerCase()),
        requester,
      )
        .order('started_at', { ascending: false, nullsFirst: false })
        .limit(3)
      if (capturesError) console.warn('[email-context] related captures read failed:', capturesError.message)

      const visible = (captures || []).filter((c) => isCaptureVisible(c, requester))
      if (visible.length) {
        result.relatedCaptures = visible.map((c) => ({
          id: c.id,
          title: c.title,
          date: c.started_at,
        }))
      }

      // Find open actions related to this contact
      const { data: contactFull } = await supabase
        .from('contact')
        .select('member_id')
        .eq('id', contact.id)
        .single()

      if (contactFull?.member_id) {
        const { data: actions } = await supabase
          .from('actions')
          // `!inner` so the state filter drops the action row, not just the embed.
          .select('id, title, workflow_state:workflow_state!status_id!inner(name, category), due_at')
          .eq('workspace_id', workspaceId)
          .eq('assignee_id', contactFull.member_id)
          .not('workflow_state.category', 'in', '(completed,canceled)')
          .limit(3)

        if (actions?.length) {
          result.relatedActions = actions.map((a) => ({
            id: a.id,
            title: a.title,
            status: ((a.workflow_state as unknown as { name: string }) || {}).name || '',
            dueDate: a.due_at || undefined,
          }))
        }
      }
    }

    results.push(result)
  }

  return results
}
