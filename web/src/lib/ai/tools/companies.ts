import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { EMPLOYEE_COUNT_RANGES } from '@/lib/crm/enrichment'
import { companyWriteAccess } from '@/lib/crm/contact-visibility'
import { COMPANY_WEB_FIELDS, fenceWebFields } from './web-derived'
import {
  resolveEntityWorkspace,
  resolveCreateWorkspace,
  workspaceEcho,
  type CreateWorkspacePolicy,
} from './_shared'

/**
 * Companies — the other half of the CRM.
 *
 * Contacts have had `list_contacts` / `create_contact` / `update_contact`
 * since the beginning; companies had exactly one tool, `get_company_overview`,
 * which needs an id or a domain you already know. So "what companies are in my
 * CRM?" had no answer at all, and "tell me about Vanta" only worked if the
 * model guessed vanta.com. Every one of these mirrors a thing the Companies
 * tab does.
 *
 * DELETE is deliberately absent: deleting a company cascades to every contact
 * at it (src/lib/crm/delete-companies.ts) and is owner/admin-only in the UI.
 * That belongs behind a human's click, not a sentence.
 */
export function createCompanyTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  // Mirrors contacts.ts / claims.ts: hard-fences update_company's cross-workspace
  // resolve to `workspaceId` for unattended runs. See resolveEntityWorkspace
  // in ./_shared.ts.
  strictWorkspace = false,
  // CREATE-TIME WORKSPACE ROUTING (_shared.ts). Trailing, after strictWorkspace,
  // exactly like every other create-bearing factory — an unused default keeps
  // today's callers (index.ts) byte-identical until the bridge passes 'explicit'.
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
  // EDIT GRANTS (512): createTools's one flag (never a guest's, linked
  // agent's or unattended turn). Off unless said.
  editGrants = false,
) {
  /**
   * update_company's gate: the company's own edit rule (an owner or admin,
   * or a member who can see one of its contacts: 496's company_visible_to_
   * ungranted), the person's own creation (the activity log's 'created' row
   * names them: a company they just made has no contacts yet), or on an
   * attended turn an edit grant (512). Null: not found.
   */
  async function companyUpdateAccess(companyId: string, ws: string): Promise<'rule' | 'grant' | null> {
    const access = await companyWriteAccess(supabase, companyId, userId, { grants: editGrants })
    if (access) return access
    const { data: me } = await supabase.from('member').select('id').eq('workspace_id', ws).eq('user_id', userId).maybeSingle()
    const memberId = (me as { id?: unknown } | null)?.id
    if (typeof memberId !== 'string') return null
    const { data: created } = await supabase
      .from('entity_activity')
      .select('id')
      .eq('workspace_id', ws)
      .eq('entity_type', 'company')
      .eq('entity_id', companyId)
      .eq('action', 'created')
      .eq('actor_member_id', memberId)
      .limit(1)
    return Array.isArray(created) && created.length > 0 ? 'rule' : null
  }

  return {
    list_companies: tool({
      description:
        'List the companies in the CRM, most recently active first, each with how many contacts and meetings you have there and when you last spoke to anyone. Optionally filter by a name/domain search. Use this to answer "what accounts do we have", to find a company_id for get_company_overview, or to check whether a company already exists before creating it.',
      inputSchema: z.object({
        search: z
          .string()
          .optional()
          .describe('Match against company name or domain (case-insensitive substring).'),
        limit: z.number().int().min(1).max(200).optional().default(50).describe('Max results (default 50, max 200).'),
        offset: z.number().optional().describe('Skip this many results — for paging.'),
      }),
      execute: async ({ search, limit, offset }) => {
        /*
         * `list_companies_with_stats` is SECURITY DEFINER and revoked from the
         * `authenticated` role (migration 193), so it runs on the service
         * client — exactly as /api/account/companies does. p_user_id is what
         * fences the result: owners and admins see every company, everyone
         * else sees the ones with at least one contact they can see, and the
         * counts only ever cover contacts visible to THIS user (migration
         * 236). The RPC returns nothing at all for a non-member.
         */
        const { data, error } = await getServiceClient().rpc('list_companies_with_stats', {
          p_workspace_id: workspaceId,
          p_search: search ?? null,
          p_limit: Math.min(limit ?? 50, 200),
          p_offset: offset ?? 0,
          p_user_id: userId,
        })
        if (error) return { success: false, error: error.message }

        // Industry (and any prose column) can come from web enrichment: fenced (web-derived.ts).
        const companies = ((data ?? []) as Array<Record<string, unknown>>).map((c) => fenceWebFields(c, COMPANY_WEB_FIELDS))
        return {
          success: true,
          count: companies.length,
          companies,
        }
      },
    }),

    create_company: tool({
      description:
        'Create a company in the CRM. Check list_companies first — a company already on file should be updated, not duplicated. Contacts whose email domain matches are attached automatically.',
      inputSchema: z.object({
        name: z.string().min(1).describe('The company name.'),
        domain: z
          .string()
          .optional()
          .describe("Primary web domain, e.g. 'vanta.com' — no scheme, no path. This is what links contacts to the company."),
        website: z.string().optional(),
        industry: z.string().optional(),
        description: z.string().optional(),
        employee_count_range: z
          .enum(EMPLOYEE_COUNT_RANGES)
          .optional()
          .describe(`One of: ${EMPLOYEE_COUNT_RANGES.join(', ')}.`),
        address: z.string().optional(),
        phone: z.string().optional(),
        contact_email: z.string().optional().describe('General contact address, e.g. hello@vanta.com.'),
        city: z.string().optional(),
        state: z.string().optional(),
        country: z.string().optional(),
        tags: z.array(z.string()).optional(),
        workspace_id: z
          .string()
          .optional()
          .describe(
            'Workspace to create in. Defaults to the active workspace. Copy it from the workspace_id on rows you read, or from active_workspace.',
          ),
      }),
      execute: async (input) => {
        // CREATE-TIME WORKSPACE ROUTING (_shared.ts): an explicit workspace_id
        // wins (membership-checked), otherwise createWorkspacePolicy decides
        // whether to default to the session workspace or refuse and ask.
        const ws = await resolveCreateWorkspace(supabase, userId, workspaceId, input.workspace_id, {
          strictWorkspace,
          policy: createWorkspacePolicy,
        })
        if (!ws.ok) return ws.error
        const targetWs = ws.workspaceId

        const { data, error } = await supabase
          .from('company')
          .insert({
            workspace_id: targetWs,
            name: input.name,
            domain: input.domain?.trim().toLowerCase() || null,
            website: input.website || null,
            industry: input.industry || null,
            description: input.description || null,
            employee_count_range: input.employee_count_range || null,
            address: input.address || null,
            phone: input.phone || null,
            contact_email: input.contact_email?.trim().toLowerCase() || null,
            city: input.city || null,
            state: input.state || null,
            country: input.country || null,
            tags: input.tags || [],
          })
          .select('id, name, domain, industry')
          .single()

        if (error) return { success: false, error: error.message }
        return {
          success: true,
          company: fenceWebFields(data as Record<string, unknown>, COMPANY_WEB_FIELDS),
          message: `Created company: "${data.name}"`,
          ...workspaceEcho(targetWs, ws.workspaceName),
        }
      },
    }),

    update_company: tool({
      description:
        'Update a company on file — name, domain, industry, size, address, tags. Only the fields you pass are touched. Use list_companies or get_company_overview to find the company_id.',
      inputSchema: z.object({
        company_id: z.string().describe('UUID of the company.'),
        name: z.string().optional(),
        domain: z.string().optional(),
        website: z.string().optional(),
        industry: z.string().optional(),
        description: z.string().optional(),
        employee_count_range: z.enum(EMPLOYEE_COUNT_RANGES).optional(),
        address: z.string().optional(),
        phone: z.string().optional(),
        contact_email: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        country: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
      execute: async ({ company_id, ...input }) => {
        // A company_id copied from the UI may live in another workspace the
        // user belongs to (e.g. from a cross-workspace search result) — route
        // there instead of scoping blind to the active workspace. Same shape
        // as update_contact (contacts.ts): a foreign-and-non-member id gets
        // the SAME not-found error as a nonexistent one.
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'company',
          company_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) return { success: false, error: 'Company not found' }
        // A write gate (this runs service-role, where RLS hides nothing): the
        // company must be one the person may change.
        const access = await companyUpdateAccess(company_id, resolved.workspaceId)
        if (!access) return { success: false, error: 'Company not found' }
        // Shared to edit (512): never its domain, whose adoption trigger pulls
        // other members' contacts in and opens the company to their readers.
        if (access === 'grant' && input.domain !== undefined) {
          return { success: false, error: "This company is shared with you to edit its details; its domain stays an owner's or admin's to change." }
        }

        // Same whitelist as the PATCH route, and the same rule: a key that was
        // not passed is not written, so a partial update never blanks a field.
        const updates: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(input)) {
          if (value === undefined) continue
          if (key === 'domain' || key === 'contact_email') {
            updates[key] = typeof value === 'string' ? value.trim().toLowerCase() || null : null
            continue
          }
          updates[key] = value
        }
        if (Object.keys(updates).length === 0) {
          return { success: false, error: 'Pass at least one field to change' }
        }
        updates.updated_at = new Date().toISOString()

        const { data, error } = await supabase
          .from('company')
          .update(updates)
          .eq('id', company_id)
          .eq('workspace_id', resolved.workspaceId)
          .select('id, name, domain, industry')
          .single()

        if (error) return { success: false, error: error.message }
        if (!data) return { success: false, error: 'Company not found' }
        return {
          success: true,
          company: fenceWebFields(data as Record<string, unknown>, COMPANY_WEB_FIELDS),
          updated_fields: Object.keys(updates).filter((k) => k !== 'updated_at'),
        }
      },
    }),
  }
}
