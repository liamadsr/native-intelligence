import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createDeal,
  dealFieldColumns,
  describeChanges,
  describeDeal,
  findDeals,
  getDeal,
  listDealEvents,
  listPipelines,
  lookupDealNames,
  undoDealChange,
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
  cleanOptions,
  customFieldKey,
  customFieldNotFound,
  customFieldTable,
  defineCustomField,
  hasOptions,
  listCustomFieldDefinitions,
  setRecordCustomFields,
  type CustomFieldConfig,
  type CustomFieldEntity,
} from '@/lib/crm/custom-fields'
import { customFieldWriteRefusal } from '@/lib/crm/custom-field-access'
import { fieldReferenceCheck } from '@/lib/crm/custom-field-references'
import { RELATION_TARGET_KINDS } from '@/lib/crm/custom-field-types'
import { formatDealValue } from '@/lib/crm/deal-format'
import { visiblePrivateKindIds } from '@/lib/knowledge/entity-fences'
import { applyOps } from '@/lib/tables/store'
import { resolveCreateWorkspace, resolveEntityWorkspace, workspaceEcho, type CreateWorkspacePolicy } from './_shared'

/**
 * Deals (roadmap #8): the agent creates, finds, updates and moves deals, and
 * defines and sets custom fields on deals and on every kind the entity
 * registry marks `customFields` (contacts, companies, tasks, projects,
 * initiatives, documents). A deal is a pipeline table's row (Tables, phase
 * 7, migration 540): these tools keep their names and behaviour over the
 * table ops (src/lib/crm/deals.ts), so every change is in the pipeline's
 * History with Undo.
 *
 * Apply with undo (Liam's rule): when an email, a meeting or a text clearly
 * moves a deal (a signed contract, a lost deal, a new amount), the agent
 * updates it directly, names where it read it in `because`, says what it
 * changed, and the person can undo it (`undo_deal_change`). There is no
 * accept/dismiss queue. Every change is logged with its before and after.
 *
 * These may run on a service-role client: every pipeline is fenced first
 * with the database's own rule (a private pipeline is its owner's and its
 * grantees'), without grants on a guest's or linked agent's turn, and a
 * pipeline reached only through a grant changes only on the person's own
 * attended turn (editGrants), as a table does.
 *
 * There is no delete, like companies: archiving a deal is a person's click.
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

/** The kinds define_custom_field and set_custom_fields take: the registry's, and deals. */
const FIELD_KINDS = [...CUSTOM_FIELD_ENTITIES, 'deal'] as [CustomFieldEntity | 'deal', ...Array<CustomFieldEntity | 'deal'>]
type FieldKind = CustomFieldEntity | 'deal'
const KIND_NOUNS: Record<FieldKind, { one: string; many: string }> = { ...CUSTOM_FIELD_KIND_NOUNS, deal: { one: 'deal', many: 'deals' } }

/** "documents, contacts, ... and deals": the kinds in words, deals last as before. */
function fieldKindList(form: 'one' | 'many' = 'many', joiner = 'and'): string {
  const words = FIELD_KINDS.map((k) => KIND_NOUNS[k][form])
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} ${joiner} ${words[words.length - 1]}` : words.join('')
}

function actorFor(userId: string, because: { source: (typeof BECAUSE_SOURCES)[number]; ref?: string; reason?: string } | undefined): DealActor {
  return {
    userId,
    source: because ? SOURCE_MAP[because.source] : 'agent',
    sourceRef: because?.ref ?? null,
    reason: because?.reason ?? null,
  }
}

async function present(
  db: SupabaseClient,
  workspaceId: string,
  viewer: string,
  deals: Deal[],
  pipelines: DealPipeline[],
  opts: { grants?: boolean } = {},
) {
  // These tools may run on a service-role client: only what the person can see is named.
  const names = await lookupDealNames(db, workspaceId, deals, viewer, opts)
  return deals.map((d) => ({ ...describeDeal(d, { pipelines, ...names }), value_label: formatDealValue(d.value, d.currency) || null }))
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
  // A guest's or a linked agent's turn (CreateToolsOptions.omitGrants): a
  // contact, company or pipeline shared with the person names nothing and joins no deal.
  omitGrants = false,
) {
  const readOpts: { grants?: boolean } = omitGrants ? { grants: false } : {}
  const viewer = { viewer: userId, ...readOpts }
  const createIn = (explicit: string | undefined) =>
    resolveCreateWorkspace(supabase, userId, workspaceId, explicit, { strictWorkspace, policy: createWorkspacePolicy })
  const workspaceIdField = z
    .string()
    .optional()
    .describe('Workspace to create in. Defaults to the active workspace. Copy it from the workspace_id on rows you read, or from active_workspace.')
  const dealWorkspace = async (dealId: string) =>
    (await resolveEntityWorkspace(supabase, userId, 'data_row', dealId, workspaceId, strictWorkspace))?.workspaceId ?? null

  /** The pipelines the person reads in `ws`. */
  const readable = (ws: string) => listPipelines(supabase, ws, { viewer: userId, readable: (ids) => visiblePrivateKindIds(supabase, 'data_table', userId, ids, ws, readOpts) })

  /**
   * The pipelines the person may change in `ws` this turn: a guest changes
   * none, and one read only through a grant changes on their own attended
   * turn (editGrants; the database checks it is an edit grant).
   */
  async function writable(ws: string): Promise<DealPipeline[]> {
    const { data } = await supabase.from('member').select('role').eq('workspace_id', ws).eq('user_id', userId).maybeSingle()
    if (!data || (data as { role: string }).role === 'guest') return []
    const fence = editGrants && !omitGrants ? readOpts : { grants: false }
    return listPipelines(supabase, ws, { viewer: userId, readable: (ids) => visiblePrivateKindIds(supabase, 'data_table', userId, ids, ws, fence) })
  }

  const notWritable = 'You can view that deal but not change it here.'

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
          const pipelines = await readable(workspaceId)
          const { deals } = await findDeals(supabase, workspaceId, input, { viewer: userId, readable: async (ids) => new Set(ids.filter((id) => pipelines.some((p) => p.id === id))) })
          return { success: true, count: deals.length, deals: await present(supabase, workspaceId, userId, deals, pipelines, readOpts), pipelines: stagesOf(pipelines) }
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
        const pipelines = await readable(ws)
        const deal = await getDeal(supabase, ws, deal_id, pipelines)
        if (!deal) return { success: false, error: 'Deal not found' }
        const columns = pipelines.find((p) => p.id === deal.pipeline_id)?.columns ?? []
        const [described] = await present(supabase, ws, userId, [deal], pipelines, readOpts)
        const events = await listDealEvents(supabase, ws, deal, 15)
        return {
          success: true,
          deal: described,
          history: events.map((e) => ({
            change_id: e.id,
            kind: e.kind,
            what: describeChanges(e.changes, { columns }),
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
        const pipelines = await writable(ws.workspaceId)
        if (!pipelines.length) return { success: false, error: "There is no pipeline here the person can add a deal to." }
        const result = await createDeal(supabase, ws.workspaceId, input as DealInput & { name: string }, actorFor(userId, because), { ...viewer, pipelines })
        if (!result.ok) return { success: false, error: result.error }
        const [deal] = await present(supabase, ws.workspaceId, userId, [result.deal], pipelines, readOpts)
        return {
          success: true,
          deal,
          change_id: result.eventId,
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
        const pipelines = await writable(ws)
        if (!(await getDeal(supabase, ws, deal_id, pipelines))) {
          return { success: false, error: (await getDeal(supabase, ws, deal_id, await readable(ws))) ? notWritable : 'Deal not found' }
        }
        const result = await updateDeal(supabase, ws, deal_id, input as DealInput, actorFor(userId, because), { ...viewer, pipelines })
        if (!result.ok) return { success: false, error: result.error }
        const columns = pipelines.find((p) => p.id === result.deal.pipeline_id)?.columns ?? []
        const [deal] = await present(supabase, ws, userId, [result.deal], pipelines, readOpts)
        const changed = describeChanges(result.changes, { columns })
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
        const pipelines = await writable(ws)
        if (!(await getDeal(supabase, ws, deal_id, pipelines))) {
          return { success: false, error: (await getDeal(supabase, ws, deal_id, await readable(ws))) ? notWritable : 'Deal not found' }
        }
        const result = await updateDeal(supabase, ws, deal_id, { stage }, actorFor(userId, because), { ...viewer, pipelines })
        if (!result.ok) return { success: false, error: result.error }
        const columns = pipelines.find((p) => p.id === result.deal.pipeline_id)?.columns ?? []
        const changed = describeChanges(result.changes, { columns })
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
        const pipelines = await writable(ws)
        if (!(await getDeal(supabase, ws, deal_id, pipelines))) {
          return { success: false, error: (await getDeal(supabase, ws, deal_id, await readable(ws))) ? notWritable : 'Deal not found' }
        }
        const result = await undoDealChange(supabase, ws, { dealId: deal_id, changeId: change_id }, { userId, source: 'agent' }, { ...viewer, pipelines })
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
      description: `Add a custom field to every one of a kind of record in the workspace (${fieldKindList()}; a task is entity_type "action"). A field of that name already there is returned as it is.`,
      inputSchema: z.object({
        entity_type: z.enum(FIELD_KINDS),
        label: z.string().min(1).max(60).describe('e.g. "Contract length (months)".'),
        field_type: z.enum(CUSTOM_FIELD_TYPES),
        options: z.array(z.string()).max(50).optional().describe('select and multi_select: the choices.'),
        currency: z.string().length(3).optional().describe('currency: the default ISO code (USD when absent).'),
        links_to: z.enum(RELATION_TARGET_KINDS).optional().describe("relation: the kind it links to (data_row: a table's rows, with table_id)."),
        table_id: z.string().optional(),
        multiple: z.boolean().optional().describe('relation: links several records.'),
        workspace_id: workspaceIdField,
      }),
      execute: async ({ workspace_id, currency, links_to, table_id, multiple, ...input }) => {
        const ws = await createIn(workspace_id)
        if (!ws.ok) return ws.error
        const config: CustomFieldConfig | undefined =
          input.field_type === 'currency' ? { currency } : input.field_type === 'relation' ? { target: { kind: links_to!, table_id }, multiple } : undefined
        if (input.entity_type === 'deal') {
          // A deal's field is a column on each pipeline the person may change.
          const label = input.label.trim()
          const key = customFieldKey(label)
          if (!key) return { success: false, error: 'A field needs a name with a letter or number in it.' }
          if (hasOptions(input.field_type) && cleanOptions(input.options).length < 2) return { success: false, error: 'A select field needs at least two options.' }
          const pipelines = await writable(ws.workspaceId)
          if (!pipelines.length) return { success: false, error: 'There is no pipeline here the person can change.' }
          let existed = true
          for (const p of pipelines) {
            if (p.columns.some((c) => c.label.toLowerCase() === label.toLowerCase())) continue
            existed = false
            const written = await applyOps(
              supabase,
              ws.workspaceId,
              p.id,
              { baseVersion: null, ops: [{ op: 'create_column', label, field_type: input.field_type, options: input.options, config }] },
              { userId, source: 'agent', asUserId: userId, ...(omitGrants ? { grants: false } : {}) },
            )
            if (!written.ok) return { success: false, error: `${p.name}: ${written.error}` }
          }
          return {
            ...workspaceEcho(ws.workspaceId, ws.workspaceName),
            success: true,
            field: { key, label, field_type: input.field_type, options: cleanOptions(input.options), config: config ?? {} },
            message: existed ? `"${label}" already exists.` : `Added "${label}" to deals.`,
          }
        }
        const result = await defineCustomField(supabase, ws.workspaceId, { ...input, entity_type: input.entity_type, config })
        if (!result.ok) return { success: false, error: result.error }
        return {
          ...workspaceEcho(ws.workspaceId, ws.workspaceName),
          success: true,
          field: { key: result.field.key, label: result.field.label, field_type: result.field.field_type, options: result.field.options, config: result.field.config },
          message: result.existed ? `"${result.field.label}" already exists.` : `Added "${result.field.label}" to ${KIND_NOUNS[input.entity_type].many}.`,
        }
      },
    }),

    set_custom_fields: tool({
      description: `Set custom field values on one record (${fieldKindList('one', 'or')}; a task is entity_type "action"), by field name; null clears one. A multi_select or relation takes a list (relation: record ids), a checkbox true or false, a person a member id, a currency an amount or {amount, currency}. Lists the fields when a name is unknown. (A deal's are undoable like any deal change.)`,
      inputSchema: z.object({
        entity_type: z.enum(FIELD_KINDS),
        id: z.string().describe('The record id.'),
        values: z.record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.object({ amount: z.number(), currency: z.string().optional() }), z.null()]),
        ),
        because: becauseSchema,
      }),
      execute: async ({ entity_type, id, values, because }) => {
        if (entity_type === 'deal') {
          const ws = await dealWorkspace(id)
          if (!ws) return { success: false, error: 'Deal not found' }
          const pipelines = await writable(ws)
          const current = await getDeal(supabase, ws, id, pipelines)
          if (!current) return { success: false, error: (await getDeal(supabase, ws, id, await readable(ws))) ? notWritable : 'Deal not found' }
          const result = await updateDeal(supabase, ws, id, { custom_fields: values }, actorFor(userId, because), { ...viewer, pipelines })
          if (!result.ok) {
            const pipeline = pipelines.find((p) => p.id === current.pipeline_id)
            return { success: false, error: result.error, fields: (pipeline ? dealFieldColumns(pipeline) : []).map((c) => ({ label: c.label, field_type: c.field_type, options: c.options })) }
          }
          return { success: true, custom_fields: result.deal.custom_fields, change_id: result.eventId }
        }
        const resolved = await resolveEntityWorkspace(supabase, userId, customFieldTable(entity_type), id, workspaceId, strictWorkspace)
        if (!resolved) return { success: false, error: customFieldNotFound(entity_type) }
        // These tools may run on a service-role client: the kind's own edit
        // rule, for this person, before the write (a record they only view
        // through a grant is not theirs to change).
        const refusal = await customFieldWriteRefusal(supabase, userId, resolved.workspaceId, entity_type, id, { grants: editGrants, readGrants: !omitGrants })
        if (refusal) return { success: false, error: refusal.error }
        const result = await setRecordCustomFields(supabase, resolved.workspaceId, entity_type, id, values, {
          checkReferences: fieldReferenceCheck(supabase, { workspaceId: resolved.workspaceId, userId, grants: !omitGrants }),
        })
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
