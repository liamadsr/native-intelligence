import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createDeal,
  describeChanges,
  describeDeal,
  findDeals,
  getDeal,
  listDealEvents,
  listPipelines,
  lookupDealNames,
  undoDealEvent,
  updateDeal,
  type Deal,
  type DealActor,
  type DealChangeSource,
  type DealInput,
  type DealPipeline,
} from '@/lib/crm/deals'
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_KIND_NOUNS,
  CUSTOM_FIELD_TYPES,
  customFieldKindList,
  customFieldNotFound,
  customFieldTable,
  defineCustomField,
  listCustomFieldDefinitions,
  setRecordCustomFields,
} from '@/lib/crm/custom-fields'
import { customFieldWriteRefusal } from '@/lib/crm/custom-field-access'
import { formatDealValue } from '@/lib/crm/deal-format'
import { resolveCreateWorkspace, resolveEntityWorkspace, workspaceEcho, type CreateWorkspacePolicy } from './_shared'

/**
 * Deals (roadmap #8): the agent creates, finds, updates and moves deals, and
 * defines and sets custom fields on every kind the entity registry marks
 * `customFields` (deals, contacts, companies, tasks, projects, initiatives,
 * documents). See src/lib/crm/deals.ts and src/lib/crm/custom-fields.ts.
 *
 * Apply with undo (Liam's rule): when an email, a meeting or a text clearly
 * moves a deal (a signed contract, a lost deal, a new amount), the agent
 * updates it directly, names where it read it in `because`, says what it
 * changed, and the person can undo it (`undo_deal_change`). There is no
 * accept/dismiss queue. Every change is logged with its before and after.
 *
 * DELETE is deliberately absent, like companies: a deal's history goes with
 * it, so that is a person's click.
 */

const BECAUSE_SOURCES = ['chat', 'email', 'meeting', 'text'] as const
const SOURCE_MAP: Record<(typeof BECAUSE_SOURCES)[number], DealChangeSource> = {
  chat: 'agent',
  email: 'email',
  meeting: 'capture',
  text: 'sms',
}

const becauseSchema = z
  .object({
    source: z.enum(BECAUSE_SOURCES).describe('Where it came from: the chat, an email, a meeting (capture) or a text.'),
    ref: z.string().max(200).optional().describe('The email thread id, capture id or message id it came from.'),
    reason: z.string().max(500).optional().describe('One sentence the person will see, e.g. "Dana wrote that they signed the contract".'),
  })
  .optional()
  .describe('Why you are changing it. Always set it when an email, meeting or text moved the deal, not the person asking.')

const dealFieldsSchema = {
  value: z.number().min(0).nullable().optional().describe('The amount, e.g. 12500. null clears it.'),
  currency: z.string().length(3).optional().describe('ISO code, default USD.'),
  stage: z.string().optional().describe('Stage name, e.g. "Proposal" or "Won". Unknown names return the stage list.'),
  pipeline: z.string().optional().describe('Pipeline name or id. Default: the default pipeline.'),
  expected_close_date: z.string().nullable().optional().describe('YYYY-MM-DD; null clears it.'),
  owner_id: z.string().nullable().optional().describe('Member id of the owner (list_workspace_members). Default on create: you, the person.'),
  company_id: z.string().nullable().optional().describe('From list_companies.'),
  contact_ids: z.array(z.string()).max(50).optional().describe('From list_contacts. Replaces the list; use add_contact_ids to add.'),
  add_contact_ids: z.array(z.string()).max(50).optional().describe('Contacts to add to the deal.'),
  notes: z.string().max(10000).nullable().optional(),
  custom_fields: z
    .record(z.string(), z.union([z.string(), z.number(), z.null()]))
    .optional()
    .describe('Custom field values by name, e.g. {"Contract length": 12}; null clears one. define_custom_field first if missing.'),
}

function actorFor(userId: string, because: { source: (typeof BECAUSE_SOURCES)[number]; ref?: string; reason?: string } | undefined): DealActor {
  return {
    userId,
    source: because ? SOURCE_MAP[because.source] : 'agent',
    sourceRef: because?.ref ?? null,
    reason: because?.reason ?? null,
  }
}

async function present(db: SupabaseClient, workspaceId: string, viewer: string, deals: Deal[], pipelines?: DealPipeline[]) {
  const pl = pipelines ?? (await listPipelines(db, workspaceId))
  // These tools may run on a service-role client: only what the person can see is named.
  const names = await lookupDealNames(db, workspaceId, deals, viewer)
  return deals.map((d) => ({ ...describeDeal(d, { pipelines: pl, ...names }), value_label: formatDealValue(d.value, d.currency) || null }))
}

function stagesOf(pipelines: DealPipeline[]) {
  return pipelines.map((p) => ({ pipeline: p.name, is_default: p.is_default, stages: p.stages.map((s) => ({ name: s.name, kind: s.kind })) }))
}

export function createDealTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
  // CREATE-TIME WORKSPACE ROUTING (_shared.ts), like companies and contacts.
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
  // EDIT GRANTS (512): whether a grant shared with the person to edit lets
  // this turn's writes through. createTools derives it once: never on a
  // guest's or linked agent's turn (omitGrants), never on an unattended one
  // (a home turn, a skill or work run, open to injected text). Off unless said.
  editGrants = false,
) {
  const viewer = { viewer: userId }
  const createIn = (explicit: string | undefined) =>
    resolveCreateWorkspace(supabase, userId, workspaceId, explicit, { strictWorkspace, policy: createWorkspacePolicy })
  const workspaceIdField = z
    .string()
    .optional()
    .describe('Workspace to create in. Defaults to the active workspace. Copy it from the workspace_id on rows you read, or from active_workspace.')
  const dealWorkspace = async (dealId: string) =>
    (await resolveEntityWorkspace(supabase, userId, 'deal', dealId, workspaceId, strictWorkspace))?.workspaceId ?? null

  return {
    find_deals: tool({
      description:
        "Find deals in the CRM: by name, stage, open/won/lost, company or contact. Returns each deal's value, stage, close date, owner, company and contacts, and every pipeline's stages. Use it before create_deal (a deal already on file is updated, not duplicated) and to find a deal_id.",
      inputSchema: z.object({
        search: z.string().optional().describe('Part of the deal name.'),
        stage: z.string().optional().describe('A stage name, e.g. "Proposal".'),
        status: z.enum(['open', 'won', 'lost', 'all']).optional().describe('Default all.'),
        company_id: z.string().optional(),
        contact_id: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      execute: async (input) => {
        try {
          const { deals, pipelines } = await findDeals(supabase, workspaceId, input)
          return { success: true, count: deals.length, deals: await present(supabase, workspaceId, userId, deals, pipelines), pipelines: stagesOf(pipelines) }
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) }
        }
      },
    }),

    get_deal: tool({
      description: "One deal with its recent changes (who or what made each, from where, and whether it was undone). The change ids are what undo_deal_change takes.",
      inputSchema: z.object({ deal_id: z.string() }),
      execute: async ({ deal_id }) => {
        const ws = await dealWorkspace(deal_id)
        if (!ws) return { success: false, error: 'Deal not found' }
        const deal = await getDeal(supabase, ws, deal_id)
        if (!deal) return { success: false, error: 'Deal not found' }
        const pipelines = await listPipelines(supabase, ws)
        const [described] = await present(supabase, ws, userId, [deal], pipelines)
        const events = await listDealEvents(supabase, ws, deal_id, 15)
        return {
          success: true,
          deal: described,
          history: events.map((e) => ({
            change_id: e.id,
            kind: e.kind,
            what: describeChanges(e.changes, { pipelines }),
            source: e.source,
            reason: e.reason,
            at: e.created_at,
            undone: !!e.undone_at,
          })),
        }
      },
    }),

    create_deal: tool({
      description:
        'Create a deal: a name and whatever is known (value, stage, close date, company, contacts). It lands in the default pipeline\'s first stage unless you name one; the default pipeline is Lead, Qualified, Proposal, Won, Lost. Check find_deals first.',
      inputSchema: z.object({
        name: z.string().min(1).max(200).describe('e.g. "Northwind website redesign".'),
        ...dealFieldsSchema,
        because: becauseSchema,
        workspace_id: workspaceIdField,
      }),
      execute: async ({ because, workspace_id, ...input }) => {
        const ws = await createIn(workspace_id)
        if (!ws.ok) return ws.error
        const result = await createDeal(supabase, ws.workspaceId, input as DealInput & { name: string }, actorFor(userId, because), viewer)
        if (!result.ok) return { success: false, error: result.error }
        const [deal] = await present(supabase, ws.workspaceId, userId, [result.deal])
        return {
          success: true,
          deal,
          message: `Created deal "${result.deal.name}"${deal.stage ? ` in ${deal.stage}` : ''}.`,
          ...workspaceEcho(ws.workspaceId, ws.workspaceName),
        }
      },
    }),

    update_deal: tool({
      description:
        "Change a deal: name, value, stage, close date, owner, company, contacts, notes or custom fields. Only what you pass is touched. When an email, meeting or text clearly changes a deal (a signed contract, a lost deal, a new amount), update it directly with `because`, then tell the person what changed; they can undo it. Don't ask first, and don't guess: a hint is not a change.",
      inputSchema: z.object({
        deal_id: z.string(),
        name: z.string().min(1).max(200).optional(),
        ...dealFieldsSchema,
        because: becauseSchema,
      }),
      execute: async ({ deal_id, because, ...input }) => {
        const ws = await dealWorkspace(deal_id)
        if (!ws) return { success: false, error: 'Deal not found' }
        const result = await updateDeal(supabase, ws, deal_id, input as DealInput, actorFor(userId, because), viewer)
        if (!result.ok) return { success: false, error: result.error }
        const pipelines = await listPipelines(supabase, ws)
        const [deal] = await present(supabase, ws, userId, [result.deal], pipelines)
        const changed = describeChanges(result.changes, { pipelines })
        return {
          success: true,
          deal,
          changed,
          change_id: result.eventId,
          message: changed.length ? `Updated "${result.deal.name}": ${changed.join('; ')}. The person can undo it.` : 'Nothing changed.',
        }
      },
    }),

    move_deal: tool({
      description: 'Move a deal to another stage (e.g. "Won", "Lost", "Proposal"). Same rules as update_deal: when an email, meeting or text moved it, pass `because`.',
      inputSchema: z.object({
        deal_id: z.string(),
        stage: z.string().describe('The stage name.'),
        because: becauseSchema,
      }),
      execute: async ({ deal_id, stage, because }) => {
        const ws = await dealWorkspace(deal_id)
        if (!ws) return { success: false, error: 'Deal not found' }
        const result = await updateDeal(supabase, ws, deal_id, { stage }, actorFor(userId, because), viewer)
        if (!result.ok) return { success: false, error: result.error }
        const pipelines = await listPipelines(supabase, ws)
        const changed = describeChanges(result.changes, { pipelines })
        return {
          success: true,
          deal_id,
          changed,
          change_id: result.eventId,
          message: changed.length ? `Moved "${result.deal.name}": ${changed.join('; ')}. The person can undo it.` : 'It was already there.',
        }
      },
    }),

    undo_deal_change: tool({
      description:
        "Take back a change to a deal: every field it changed goes back, unless that field has changed again since (then the newer value stays). Without change_id, the deal's latest change. Use it when the person says a deal update was wrong.",
      inputSchema: z.object({
        deal_id: z.string(),
        change_id: z.string().optional().describe('From get_deal or the change_id an update returned.'),
      }),
      execute: async ({ deal_id, change_id }) => {
        const ws = await dealWorkspace(deal_id)
        if (!ws) return { success: false, error: 'Deal not found' }
        const result = await undoDealEvent(supabase, ws, { dealId: deal_id, eventId: change_id }, { userId, source: 'agent' })
        if (!result.ok) return { success: false, error: result.error }
        return {
          success: true,
          restored: result.restored,
          kept: result.kept,
          message: result.restored.length
            ? `Undone on "${result.deal.name}": ${result.restored.join(', ')} restored.${result.kept.length ? ` Kept newer: ${result.kept.join(', ')}.` : ''}`
            : `Nothing to restore on "${result.deal.name}": each field has changed again since.`,
        }
      },
    }),

    define_custom_field: tool({
      description: `Add a custom field to every one of a kind of record in the workspace (${customFieldKindList()}; a task is entity_type "action"): text, number, date or select (with options). A field of that name already there is returned as it is.`,
      inputSchema: z.object({
        entity_type: z.enum(CUSTOM_FIELD_ENTITIES),
        label: z.string().min(1).max(60).describe('e.g. "Contract length (months)".'),
        field_type: z.enum(CUSTOM_FIELD_TYPES),
        options: z.array(z.string()).max(50).optional().describe('select only: the choices.'),
        workspace_id: workspaceIdField,
      }),
      execute: async ({ workspace_id, ...input }) => {
        const ws = await createIn(workspace_id)
        if (!ws.ok) return ws.error
        const result = await defineCustomField(supabase, ws.workspaceId, input)
        if (!result.ok) return { success: false, error: result.error }
        return {
          ...workspaceEcho(ws.workspaceId, ws.workspaceName),
          success: true,
          field: { key: result.field.key, label: result.field.label, field_type: result.field.field_type, options: result.field.options },
          message: result.existed ? `"${result.field.label}" already exists.` : `Added "${result.field.label}" to ${CUSTOM_FIELD_KIND_NOUNS[input.entity_type].many}.`,
        }
      },
    }),

    set_custom_fields: tool({
      description: `Set custom field values on one record (${customFieldKindList('one', 'or')}; a task is entity_type "action"), by field name; null clears one. Lists the fields when a name is unknown. (A deal's are undoable like any deal change.)`,
      inputSchema: z.object({
        entity_type: z.enum(CUSTOM_FIELD_ENTITIES),
        id: z.string().describe('The record id.'),
        values: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
        because: becauseSchema,
      }),
      execute: async ({ entity_type, id, values, because }) => {
        if (entity_type === 'deal') {
          const ws = await dealWorkspace(id)
          if (!ws) return { success: false, error: 'Deal not found' }
          const result = await updateDeal(supabase, ws, id, { custom_fields: values }, actorFor(userId, because), viewer)
          if (!result.ok) return { success: false, error: result.error }
          return { success: true, custom_fields: result.deal.custom_fields, change_id: result.eventId }
        }
        const resolved = await resolveEntityWorkspace(supabase, userId, customFieldTable(entity_type), id, workspaceId, strictWorkspace)
        if (!resolved) return { success: false, error: customFieldNotFound(entity_type) }
        // These tools may run on a service-role client: the kind's own edit
        // rule, for this person, before the write (a record they only view
        // through a grant is not theirs to change).
        const refusal = await customFieldWriteRefusal(supabase, userId, resolved.workspaceId, entity_type, id, { grants: editGrants })
        if (refusal) return { success: false, error: refusal.error }
        const result = await setRecordCustomFields(supabase, resolved.workspaceId, entity_type, id, values)
        if (!result.ok) {
          const defs = await listCustomFieldDefinitions(supabase, resolved.workspaceId, entity_type).catch(() => [])
          return { success: false, error: result.error, fields: defs.map((d) => ({ label: d.label, field_type: d.field_type, options: d.options })) }
        }
        return { success: true, custom_fields: result.custom_fields }
      },
    }),
  }
}

export const DEAL_TOOL_NAMES = [
  'find_deals',
  'get_deal',
  'create_deal',
  'update_deal',
  'move_deal',
  'undo_deal_change',
  'define_custom_field',
  'set_custom_fields',
] as const
