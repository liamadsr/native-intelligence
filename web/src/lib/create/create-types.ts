/**
 * Everything the Create dialog makes (components/create-dialog.tsx), one
 * entry per type (Liam, 11-20: "make it cover every feature the app has
 * now"). Three ways an entry makes its thing:
 *
 *   form   one of the dialog's own six forms (Action, Project, Initiative,
 *          Contact, Email, Event), unchanged.
 *   quick  a name (and a field or two) in the dialog, sent to the feature's
 *          own create route (components/create/quick-create.ts), then the
 *          thing opened as the app opens it (openTarget / openCard).
 *   page   a multi-step setup: the feature's page opens on its own create
 *          flow (lib/create/page-create.ts), nothing copied into the dialog.
 *
 * `page` is the `/` page the type belongs to: a type shows only while the
 * workspace has that page (pagesFor: its edition, a guest's members-only
 * pages). The six forms always show, as they did.
 *
 * Left out on purpose: forms (each belongs to a table, made inside it),
 * cycles, labels, views, teams and eval suites (setup, made where they are
 * set up), and captures (the record button makes them).
 */

export type CreateFormTypeId = 'action' | 'project' | 'initiative' | 'contact' | 'email' | 'event'
export type CreateQuickTypeId = 'company' | 'document' | 'table' | 'spreadsheet' | 'channel' | 'package' | 'studio_project'
export type CreatePageTypeId = 'deal' | 'flow' | 'agent' | 'skill' | 'sequence' | 'prospect_list' | 'campaign' | 'booking_link' | 'studio_video'
export type CreateTypeId = CreateFormTypeId | CreateQuickTypeId | CreatePageTypeId

export type CreateTypeGroupId = 'work' | 'customers' | 'outreach' | 'agents' | 'team'

/** In the rail's order: your work, customers, outreach, agents, then the team's. */
export const CREATE_TYPE_GROUPS: ReadonlyArray<{ id: CreateTypeGroupId; label: string }> = [
  { id: 'work', label: 'Work' },
  { id: 'customers', label: 'Customers' },
  { id: 'outreach', label: 'Outreach' },
  { id: 'agents', label: 'Agents' },
  { id: 'team', label: 'Team' },
]

export interface CreateTypeDef {
  id: CreateTypeId
  label: string
  group: CreateTypeGroupId
  mode: 'form' | 'quick' | 'page'
  /** The `/` page it belongs to (page-menu.ts slug): shown only while that page is on. */
  page?: string
  /** True when picking it opens the feature's page (mode `page`). */
  opensPage?: boolean
  keywords?: string[]
}

export const CREATE_TYPES: ReadonlyArray<CreateTypeDef> = [
  // Work
  { id: 'action', label: 'Action', group: 'work', mode: 'form', keywords: ['task', 'issue', 'todo'] },
  { id: 'project', label: 'Project', group: 'work', mode: 'form' },
  { id: 'initiative', label: 'Initiative', group: 'work', mode: 'form', keywords: ['goal'] },
  { id: 'document', label: 'Doc', group: 'work', mode: 'quick', page: 'docs', keywords: ['document', 'page', 'note'] },
  { id: 'table', label: 'Table', group: 'work', mode: 'quick', page: 'tables', keywords: ['database', 'list'] },
  { id: 'spreadsheet', label: 'Spreadsheet', group: 'work', mode: 'quick', page: 'spreadsheets', keywords: ['sheet', 'excel', 'workbook', 'formulas'] },
  { id: 'event', label: 'Event', group: 'work', mode: 'form', keywords: ['meeting', 'calendar'] },
  { id: 'booking_link', label: 'Booking link', group: 'work', mode: 'page', page: 'availability', opensPage: true, keywords: ['scheduling', 'availability', 'calendar'] },
  { id: 'package', label: 'Knowledge package', group: 'work', mode: 'quick', page: 'knowledge', keywords: ['context', 'knowledge'] },
  // Customers
  { id: 'contact', label: 'Contact', group: 'customers', mode: 'form', keywords: ['person', 'crm', 'lead'] },
  { id: 'company', label: 'Company', group: 'customers', mode: 'quick', page: 'companies', keywords: ['account', 'organization', 'crm'] },
  { id: 'deal', label: 'Deal', group: 'customers', mode: 'page', page: 'deals', opensPage: true, keywords: ['pipeline', 'opportunity', 'crm'] },
  { id: 'email', label: 'Email', group: 'customers', mode: 'form', keywords: ['mail', 'message', 'compose'] },
  // Outreach
  { id: 'prospect_list', label: 'Prospect list', group: 'outreach', mode: 'page', page: 'prospecting', opensPage: true, keywords: ['prospecting', 'leads'] },
  { id: 'sequence', label: 'Sequence', group: 'outreach', mode: 'page', page: 'sequences', opensPage: true, keywords: ['outreach', 'cadence'] },
  { id: 'campaign', label: 'Campaign', group: 'outreach', mode: 'page', page: 'campaigns', opensPage: true, keywords: ['marketing'] },
  { id: 'studio_project', label: 'Studio project', group: 'outreach', mode: 'quick', page: 'studio', keywords: ['studio', 'ads', 'video'] },
  { id: 'studio_video', label: 'Studio video', group: 'outreach', mode: 'page', page: 'studio', opensPage: true, keywords: ['studio', 'ad', 'reel'] },
  // Agents
  { id: 'agent', label: 'Agent', group: 'agents', mode: 'page', page: 'agents', opensPage: true, keywords: ['bot', 'teammate'] },
  { id: 'skill', label: 'Skill', group: 'agents', mode: 'page', page: 'agents', opensPage: true },
  { id: 'flow', label: 'Flow', group: 'agents', mode: 'page', page: 'flows', opensPage: true, keywords: ['automation', 'loop', 'workflow'] },
  // Team
  { id: 'channel', label: 'Channel', group: 'team', mode: 'quick', page: 'team-chat', keywords: ['team chat', 'chat'] },
]

const IDS: ReadonlySet<string> = new Set(CREATE_TYPES.map((t) => t.id))

export function isCreateTypeId(value: unknown): value is CreateTypeId {
  return typeof value === 'string' && IDS.has(value)
}

export function createTypeDef(id: CreateTypeId): CreateTypeDef {
  return CREATE_TYPES.find((t) => t.id === id)!
}

/** The types this workspace can create: the six forms always, the rest while their page is on. */
export function availableCreateTypes(pageSlugs: Iterable<string>): CreateTypeDef[] {
  const on = new Set(pageSlugs)
  return CREATE_TYPES.filter((t) => t.mode === 'form' || (t.page != null && on.has(t.page)))
}
