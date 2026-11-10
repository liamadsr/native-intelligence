import { tool } from 'ai'
import { HUBSPOT_PUSH_HOLD_KEY, hubspotPushHold } from '@/lib/crm/hubspot-push-hold'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveEntityWorkspace,
  resolveCreateWorkspace,
  workspaceEcho,
  type CreateWorkspacePolicy,
} from './_shared'
import { inngest } from '@/lib/inngest/client'
import { filterVisibleContacts, isContactWritableTo } from '@/lib/crm/contact-visibility'
import { CONTACT_WEB_FIELDS, fenceContactForModel, fenceWebFields } from './web-derived'

/**
 * The full `contact.relationship_type` vocabulary, matching
 * `contact_relationship_type_check` (migration 266). This list had drifted —
 * `internal` was missing, so `list_contacts` could never filter for teammates.
 */
const RELATIONSHIP_TYPES = [
  'contact',
  'lead',
  'customer',
  'partner',
  'vendor',
  'internal',
  'candidate',
] as const

export function createContactTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
  // CREATE-TIME WORKSPACE ROUTING (_shared.ts). Trailing, after strictWorkspace,
  // exactly like every other create-bearing factory — an unused default keeps
  // today's callers (index.ts) byte-identical until the bridge passes 'explicit'.
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
  // UNATTENDED runs (work-run, skill-run): create_contact stamps the HubSpot
  // push HOLD (metadata.hubspot_push_hold) and sends no push event — the
  // writeback is an external side effect no one has reviewed; the push function
  // and the sweep skip a held row until a person edits the contact (Sequence
  // step 2, plan A.1). See CreateToolsOptions.unattended in ./index.ts.
  unattended = false,
) {
  return {
    list_contacts: tool({
      description:
        'List CRM contacts in the active workspace. Optionally filter by name/email search, relationship type, or company. Use this for general lookups; for full interaction history use get_contact_details.',
      inputSchema: z.object({
        search: z
          .string()
          .optional()
          .describe('Match against full_name or email (case-insensitive substring)'),
        relationship_type: z
          .enum(RELATIONSHIP_TYPES)
          .optional()
          .describe('Filter by CRM relationship type'),
        company_id: z.string().optional().describe('Filter by company UUID'),
        limit: z.number().int().min(1).max(200).optional().default(50).describe('Max results (default 50, max 200)'),
      }),
      execute: async ({ search, relationship_type, company_id, limit }) => {
        const cappedLimit = Math.min(limit ?? 50, 200)

        let query = supabase
          .from('contact')
          .select(
            'id, full_name, email, phone, job_title, department, company_id, relationship_type, relationship_strength, last_interaction_at, interaction_count, tags',
          )
          .eq('workspace_id', workspaceId)
          .is('merged_into_contact_id', null)
          .order('last_interaction_at', { ascending: false, nullsFirst: false })
          .limit(cappedLimit)

        if (search) {
          // Sanitize: only escape Postgres OR delimiters; ilike already handles wildcards safely.
          const safe = search.replace(/[,()]/g, '')
          query = query.or(`full_name.ilike.%${safe}%,email.ilike.%${safe}%`)
        }
        if (relationship_type) query = query.eq('relationship_type', relationship_type)
        if (company_id) query = query.eq('company_id', company_id)

        const { data, error } = await query

        if (error) return { success: false, error: error.message }
        // Other members' private/team contacts: RLS hides them on a user
        // client, but this may run service-role (contact-visibility.ts).
        const visible = await filterVisibleContacts(supabase, userId, data || [])
        // Job title and department can come from web enrichment: fenced (web-derived.ts).
        const contacts = visible.map((c) => fenceWebFields(c as Record<string, unknown>, CONTACT_WEB_FIELDS))
        return { success: true, contacts, count: contacts.length }
      },
    }),

    get_contact: tool({
      description:
        'Look up a single contact by id, email, or name. Returns the contact record. For interaction history and recent meetings, use get_contact_details instead.',
      inputSchema: z.object({
        contact_id: z.string().optional().describe('UUID of the contact'),
        email: z.string().optional().describe('Email address to look up (exact match)'),
        name: z.string().optional().describe('Name to fuzzy-match against full_name'),
      }),
      execute: async ({ contact_id, email, name }) => {
        // For ID-based lookups, allow resolving across the user's workspaces
        // so an ID copied from the UI works regardless of the active workspace.
        let effectiveWorkspaceId = workspaceId
        if (contact_id) {
          const wsResolved = await resolveEntityWorkspace(supabase, userId, 'contact', contact_id, workspaceId, strictWorkspace)
          if (!wsResolved) return { success: false, error: 'Contact not found' }
          effectiveWorkspaceId = wsResolved.workspaceId
        }

        let query = supabase
          .from('contact')
          .select('*, company:company_id(id, name, domain, logo_url)')
          .eq('workspace_id', effectiveWorkspaceId)

        if (contact_id) {
          query = query.eq('id', contact_id)
        } else if (email) {
          query = query.eq('email', email.toLowerCase())
        } else if (name) {
          query = query.ilike('full_name', `%${name.replace(/[,()]/g, '')}%`)
        } else {
          return { success: false, error: 'Provide contact_id, email, or name' }
        }

        // Fetch a few candidates so a name/email match the caller cannot see
        // does not hide one they can; the first VISIBLE row wins.
        const { data: rows, error } = await query.limit(contact_id ? 1 : 10)

        if (error) return { success: false, error: error.message }
        const [data] = await filterVisibleContacts(supabase, userId, (rows ?? []) as Array<{ id?: unknown }>)
        // A contact the caller cannot see is indistinguishable from a missing one.
        if (!data) return { success: false, error: 'Contact not found' }
        // The columns and blob enrichment fills from public pages, fenced (web-derived.ts).
        return { success: true, contact: fenceContactForModel(data as Record<string, unknown>) }
      },
    }),

    create_contact: tool({
      description: 'Create a new CRM contact in the active workspace.',
      inputSchema: z.object({
        full_name: z
          .string()
          .optional()
          .describe('Full display name. Derived from first/last if omitted.'),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        email: z.string().optional().describe('Primary email address'),
        phone: z.string().optional(),
        job_title: z.string().optional(),
        department: z.string().optional(),
        linkedin_url: z.string().optional(),
        company_id: z.string().optional().describe('Existing company UUID'),
        relationship_type: z
          .enum(RELATIONSHIP_TYPES)
          .optional()
          .default('contact')
          .describe('CRM relationship type. Defaults to "contact".'),
        notes: z.string().optional(),
        tags: z.array(z.string()).optional(),
        workspace_id: z
          .string()
          .optional()
          .describe(
            'Workspace to create in. Defaults to the active workspace. Copy it from the workspace_id on rows you read, or from active_workspace.',
          ),
      }),
      execute: async ({
        full_name,
        first_name,
        last_name,
        email,
        phone,
        job_title,
        department,
        linkedin_url,
        company_id,
        relationship_type,
        notes,
        tags,
        workspace_id,
      }) => {
        if (!full_name && !first_name && !last_name && !email) {
          return {
            success: false,
            error: 'Provide at least one of full_name, first_name, last_name, or email',
          }
        }

        // CREATE-TIME WORKSPACE ROUTING (_shared.ts): an explicit workspace_id
        // wins (membership-checked), otherwise createWorkspacePolicy decides
        // whether to default to the session workspace or refuse and ask.
        // targetWs replaces `workspaceId` for EVERY lookup/write below — the
        // member row, the insert itself, and the two fan-outs.
        const ws = await resolveCreateWorkspace(supabase, userId, workspaceId, workspace_id, {
          strictWorkspace,
          policy: createWorkspacePolicy,
        })
        if (!ws.ok) return ws.error
        const targetWs = ws.workspaceId

        // Resolve current member for ownership (matches /api/account/contacts POST)
        const { data: member } = await supabase
          .from('member')
          .select('id')
          .eq('user_id', userId)
          .eq('workspace_id', targetWs)
          .single()

        if (!member) {
          return { success: false, error: 'Not a workspace member' }
        }

        const derivedName =
          full_name ||
          [first_name, last_name].filter(Boolean).join(' ') ||
          email ||
          ''

        const { data, error } = await supabase
          .from('contact')
          .insert({
            workspace_id: targetWs,
            created_by_member_id: member.id,
            visibility: 'private',
            full_name: derivedName,
            first_name: first_name || null,
            last_name: last_name || null,
            email: email?.toLowerCase() || null,
            phone: phone || null,
            job_title: job_title || null,
            department: department || null,
            linkedin_url: linkedin_url || null,
            company_id: company_id || null,
            relationship_type: relationship_type || 'contact',
            notes: notes || null,
            tags: tags || [],
            source: 'manual',
            // The HOLD: hubspot-push-contact and hubspot-push-sweep skip this
            // row until PATCH /api/account/contacts/[id] lifts it.
            ...(unattended ? { metadata: { [HUBSPOT_PUSH_HOLD_KEY]: hubspotPushHold() } } : {}),
          })
          .select('id, full_name, email, relationship_type')
          .single()

        if (error) return { success: false, error: error.message }

        // Fan out to the HubSpot contact-push writeback (same as the
        // /api/account/contacts POST route). Fire-and-forget: hubspot-push-
        // contact owns ALL gating (workspace opt-in, HubSpot account, dedupe)
        // and no-ops cleanly, so a failed send must never fail the tool. This
        // row is always source='manual'; only send when it carries an email.
        // UNATTENDED runs never send: the row carries the hold stamped above,
        // so the sweep will not pick it up either (Sequence step 2, plan A.1).
        if (data.email && !unattended) {
          inngest
            .send({
              name: 'crm/hubspot-push-contact',
              data: { contactId: data.id, workspaceId: targetWs },
            })
            .catch((err) => {
              console.error('[ai/create_contact] hubspot-push-contact send failed', err)
            })
        }

        return {
          success: true,
          contact: data,
          message: `Created contact: "${data.full_name}"`,
          ...workspaceEcho(targetWs, ws.workspaceName),
        }
      },
    }),

    update_contact: tool({
      description:
        'Update basic fields on a contact (name, title, email, phone, notes). For CRM-specific fields (relationship_type, tags, follow-up reminders), use update_crm_contact instead.',
      inputSchema: z.object({
        contact_id: z.string().describe('UUID of the contact'),
        full_name: z.string().optional(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        job_title: z.string().optional(),
        department: z.string().optional(),
        linkedin_url: z.string().optional(),
        notes: z.string().optional(),
      }),
      execute: async ({
        contact_id,
        full_name,
        first_name,
        last_name,
        email,
        phone,
        job_title,
        department,
        linkedin_url,
        notes,
      }) => {
        const wsResolved = await resolveEntityWorkspace(supabase, userId, 'contact', contact_id, workspaceId, strictWorkspace)
        if (!wsResolved) return { success: false, error: 'Contact not found' }
        // No writes to a contact the caller cannot see (same error as missing),
        // nor to one a per-item grant only lets them read (migration 495).
        if (!(await isContactWritableTo(supabase, contact_id, userId))) {
          return { success: false, error: 'Contact not found' }
        }

        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
        if (full_name !== undefined) updates.full_name = full_name
        if (first_name !== undefined) updates.first_name = first_name
        if (last_name !== undefined) updates.last_name = last_name
        if (email !== undefined) updates.email = email.toLowerCase()
        if (phone !== undefined) updates.phone = phone
        if (job_title !== undefined) updates.job_title = job_title
        if (department !== undefined) updates.department = department
        if (linkedin_url !== undefined) updates.linkedin_url = linkedin_url
        if (notes !== undefined) updates.notes = notes

        // Recompute full_name if first/last changed but full_name wasn't explicitly set
        if (full_name === undefined && (first_name !== undefined || last_name !== undefined)) {
          const { data: existing } = await supabase
            .from('contact')
            .select('first_name, last_name')
            .eq('id', contact_id)
            .eq('workspace_id', wsResolved.workspaceId)
            .single()
          if (existing) {
            const fn = first_name ?? existing.first_name
            const ln = last_name ?? existing.last_name
            const derived = [fn, ln].filter(Boolean).join(' ')
            if (derived) updates.full_name = derived
          }
        }

        const { data, error } = await supabase
          .from('contact')
          .update(updates)
          .eq('id', contact_id)
          .eq('workspace_id', wsResolved.workspaceId)
          .select('id, full_name, email')
          .single()

        if (error) return { success: false, error: error.message }
        return { success: true, contact: data, message: `Updated: "${data.full_name}"` }
      },
    }),
  }
}
