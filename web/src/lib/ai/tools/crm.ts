import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { captureRequester, resolveEntityWorkspace } from './_shared'
import { gatherPersonContext } from '@/lib/crm/person-context'
import { gatherCompanyContext } from '@/lib/crm/company-context'
import { recordCustomFieldsForModel } from '@/lib/crm/custom-fields'
import { isContactVisibleTo, isContactWritableTo } from '@/lib/crm/contact-visibility'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { COMPANY_WEB_FIELDS, fenceWebFields } from './web-derived'

/**
 * Outside text in the CRM overviews (always-on safety fixes): the columns web
 * enrichment fills (a company's description and industry, a person's job
 * title) go inside the WEB fence, and an email thread's subject (whoever sent
 * it wrote it) inside the EMAIL fence.
 */
function fenceThreads<T extends { subject?: string | null }>(threads: readonly T[]): T[] {
  return threads.map((t) => ({ ...t, subject: wrapUntrusted(t.subject ?? null) }))
}

export function createCrmTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  omitPrivateCaptures = false,
  // Hard-fences update_crm_contact's cross-workspace resolve to `workspaceId`
  // for unattended runs. Trailing, AFTER omitPrivateCaptures — never before,
  // since index.ts already passes omitPrivateCaptures positionally and a new
  // param inserted ahead of it would silently reinterpret that argument.
  // See resolveEntityWorkspace in ./_shared.ts.
  strictWorkspace = false,
  // EDIT GRANTS (512): whether a grant shared with the person to edit lets
  // this turn's writes through. createTools derives it once: never on a
  // guest's or linked agent's turn (omitGrants), never on an unattended one
  // (a home turn, a skill or work run, open to injected text). Off unless said.
  editGrants = false,
  // A guest's or a linked agent's turn (CreateToolsOptions.omitGrants): a
  // contact or company shared with the person (a grant, 492) is not found.
  omitGrants = false,
) {
  const grants = !omitGrants
  // get_contact_details / get_company_overview read captures (via the
  // person/company context helpers) on a service-role client (MCP /
  // unattended runs) — this requester, not RLS, is the real enforcement.
  const requester = captureRequester(userId, omitPrivateCaptures)
  return {
    get_contact_details: tool({
      description:
        "Get a contact's full CRM profile: identity/company, interaction history, recent meetings, open actions assigned to them, AI-suggested commitments not yet accepted, your open actions from meetings with them, recent email threads (your mailbox), and decisions from shared meetings. Use when the user asks about their relationship with someone or what they are waiting on from them.",
      inputSchema: z.object({
        contact_id: z.string().optional().describe('UUID of the contact'),
        email: z.string().optional().describe('Look up by email instead'),
      }),
      execute: async ({ contact_id, email }) => {
        const contactQuery = supabase.from('contact').select('id').eq('workspace_id', workspaceId)

        let found: { id: string } | null = null
        if (contact_id) {
          const { data, error } = await contactQuery.eq('id', contact_id).maybeSingle()
          if (error) return { success: false, error: error.message }
          found = data as { id: string } | null
        } else if (email) {
          // contact.email is not unique: merge tombstones keep theirs, and two
          // members can each hold a private contact with the same address. Take
          // the first live row this caller may see (maybeSingle would error).
          const { data, error } = await contactQuery
            .eq('email', email.toLowerCase())
            .is('merged_into_contact_id', null)
            .limit(10)
          if (error) return { success: false, error: error.message }
          for (const row of (data ?? []) as { id: string }[]) {
            if (await isContactVisibleTo(supabase, row.id, userId, { grants })) {
              found = row
              break
            }
          }
        } else {
          return { success: false, error: 'Provide contact_id or email' }
        }
        if (!found) return { success: false, error: 'Contact not found' }

        // The shared helper is the single fence: workspace, merge tombstones,
        // contact_visible_to (service-role safe), capture visibility, own mailbox.
        // A null here is deliberately indistinguishable from a missing row.
        const [ctx, interactions, fields] = await Promise.all([
          gatherPersonContext(supabase, {
            workspaceId,
            userId,
            contactId: found.id,
            requester,
            grants,
          }),
          supabase
            .from('contact_interaction')
            .select('interaction_type, title, occurred_at, reference_type')
            .eq('contact_id', found.id)
            .order('occurred_at', { ascending: false })
            .limit(10),
          // The workspace's own fields on contacts (migration 473), the set ones, by name.
          recordCustomFieldsForModel(supabase, workspaceId, 'contact', found.id),
        ])
        if (!ctx) return { success: false, error: 'Contact not found' }

        return {
          success: true,
          contact: {
            ...fenceWebFields(ctx.contact as unknown as Record<string, unknown>, ['job_title']),
            is_teammate: ctx.is_teammate,
            ...(ctx.canonical_of ? { canonical_of: ctx.canonical_of } : {}),
            ...fields,
            recent_interactions: interactions.data || [],
            recent_captures: ctx.recent_captures.slice(0, 10).map((c) => ({
              ...c,
              ai_summary: c.ai_summary ? c.ai_summary.slice(0, 400) : c.ai_summary,
            })),
            open_actions: ctx.open_actions,
            pending_commitments: ctx.pending_commitments,
            my_open_actions_from_their_meetings: ctx.my_open_actions_from_their_meetings,
            ...(ctx.recent_email_threads !== undefined
              ? { recent_email_threads: fenceThreads(ctx.recent_email_threads) }
              : {}),
            decisions: ctx.decisions,
          },
        }
      },
    }),

    get_company_overview: tool({
      description:
        "Get an account-level overview of a company: profile, the people on record there (and which of them you can see), open actions across the account, AI-suggested commitments not yet accepted, recent meetings with anyone at the company, recent email threads (your mailbox), and decisions from those meetings. Use when the user asks about a company, organization, or account.",
      inputSchema: z.object({
        company_id: z.string().optional(),
        domain: z.string().optional().describe('Look up by domain instead'),
      }),
      execute: async ({ company_id, domain }) => {
        let companyQuery = supabase.from('company').select('id').eq('workspace_id', workspaceId)

        if (company_id) {
          companyQuery = companyQuery.eq('id', company_id)
        } else if (domain) {
          companyQuery = companyQuery.eq('domain', domain.toLowerCase())
        } else {
          return { success: false, error: 'Provide company_id or domain' }
        }

        const { data: found, error } = await companyQuery.maybeSingle()
        if (error) return { success: false, error: error.message }
        if (!found) return { success: false, error: 'Company not found' }

        // The shared helper is the single fence: workspace, company_visible_to
        // (service-role safe), per-contact contact_visible_to, capture
        // visibility, own mailbox. A null here is deliberately
        // indistinguishable from a missing row.
        const companyId = (found as { id: string }).id
        const [ctx, fields] = await Promise.all([
          gatherCompanyContext(supabase, {
            workspaceId,
            userId,
            companyId,
            requester,
            grants,
          }),
          // The workspace's own fields on companies (migration 473), the set ones, by name.
          recordCustomFieldsForModel(supabase, workspaceId, 'company', companyId),
        ])
        if (!ctx) return { success: false, error: 'Company not found' }

        return {
          success: true,
          company: {
            ...fenceWebFields(ctx.company as unknown as Record<string, unknown>, COMPANY_WEB_FIELDS),
            ...fields,
            // Back-compat with the previous shape (callers read contacts/contact_count).
            contacts: ctx.people.map((p) => fenceWebFields(p as unknown as Record<string, unknown>, ['job_title'])),
            contact_count: ctx.people_visible,
            people_on_record: ctx.people_on_record,
            last_interaction_at: ctx.last_interaction_at,
            open_actions: ctx.open_actions,
            pending_commitments: ctx.pending_commitments,
            recent_captures: ctx.recent_captures.slice(0, 10).map((c) => ({
              ...c,
              ai_summary: c.ai_summary ? c.ai_summary.slice(0, 400) : c.ai_summary,
            })),
            ...(ctx.recent_email_threads !== undefined
              ? { recent_email_threads: fenceThreads(ctx.recent_email_threads) }
              : {}),
            decisions: ctx.decisions,
          },
        }
      },
    }),

    update_crm_contact: tool({
      description: "Update CRM information for a contact. Use when the user wants to change a contact's relationship type, add tags, set a follow-up reminder, or add notes.",
      inputSchema: z.object({
        contact_id: z.string(),
        relationship_type: z.string().optional(),
        relationship_strength: z.string().optional(),
        tags: z.array(z.string()).optional(),
        notes: z.string().optional(),
        next_followup_at: z.string().optional().describe('ISO date for follow-up reminder'),
      }),
      execute: async ({ contact_id, relationship_type, relationship_strength, tags, notes, next_followup_at }) => {
        // A contact_id copied from the UI may live in another workspace the
        // user belongs to — route there instead of scoping blind to the
        // active workspace. Mirrors update_contact (contacts.ts): a
        // foreign-and-non-member id gets the SAME not-found error as a
        // nonexistent one.
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'contact',
          contact_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) return { success: false, error: 'Contact not found' }
        // No writes to another member's private/team contact: this may run
        // service-role, where RLS does not hide it (contact-visibility.ts).
        // A per-item grant opens it to read, never to write (migration 495).
        if (!(await isContactWritableTo(supabase, contact_id, userId, { grants: editGrants }))) {
          return { success: false, error: 'Contact not found' }
        }

        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
        if (relationship_type !== undefined) updates.relationship_type = relationship_type
        if (relationship_strength !== undefined) updates.relationship_strength = relationship_strength
        if (tags !== undefined) updates.tags = tags
        if (notes !== undefined) updates.notes = notes
        if (next_followup_at !== undefined) updates.next_followup_at = next_followup_at

        const { data, error } = await supabase
          .from('contact')
          .update(updates)
          .eq('id', contact_id)
          .eq('workspace_id', resolved.workspaceId)
          .select('id, full_name, relationship_type, relationship_strength')
          .single()

        if (error) return { success: false, error: error.message }
        return { success: true, contact: data, message: `Updated ${data.full_name}` }
      },
    }),
  }
}
