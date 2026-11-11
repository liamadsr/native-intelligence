import { getServiceClient } from '@/lib/admin'
import { filterVisibleContacts } from '@/lib/crm/contact-visibility'
import { searchEmails } from './email-search-service'

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
  readOpts: { grants?: boolean } = {},
): Promise<EmailWithContext[]> {
  const supabase = getServiceClient()

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

      // Find recent captures with this contact (scoped to workspace)
      const { data: captures } = await supabase
        .from('capture_participant')
        .select('capture:capture_id!inner(id, title, started_at, workspace_id)')
        .eq('external_email', match.from_email.toLowerCase())
        .eq('capture.workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .limit(3)

      if (captures?.length) {
        result.relatedCaptures = captures
          .map((cp) => cp.capture as unknown as { id: string; title: string; started_at: string })
          .filter(Boolean)
          .map((c) => ({
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
