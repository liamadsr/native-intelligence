/**
 * Managing forms (forms phase 3): the one rule for the agent's form tools
 * (src/lib/ai/tools/tables.ts) and the REST routes the builder uses
 * (src/app/api/account/tables/[id]/forms, src/app/api/account/forms), so the
 * two cannot drift.
 *
 *   Who: making, changing or inviting to a form takes someone who can CHANGE
 *   its table (tableEditRefusal: not a guest; a table reached only by a grant
 *   changes only with an edit grant, data_table_editable_by, and from the
 *   tools only on the person's own attended turn). Reading a table's forms
 *   takes the table readable, and not a guest. A form on a pipeline adds a
 *   deal: its stage and owner are set server-side, never by the stranger
 *   (./pipeline.ts), and the Stage column is no form's to fill.
 *   The caller finds the table with the asker's own fences first; the secret
 *   tables are the service role's, used only after.
 *
 *   What: prepareNewForm and prepareFormPatch clean what is asked (the same
 *   limits the database keeps, 660, 661 and 663) into what the store writes.
 *   A form that takes files (its "$files" field) must keep the bot check on
 *   (FILES_NEED_BOT_CHECK; 663 keeps the same rule): a public upload link
 *   without it is an abuse magnet;
 *   describeForm is a form as the agent reads it, formForApi as the builder
 *   does. Neither ever holds the link's secret: it is shown once, in `url`,
 *   `page_url` and `embed`, when it is made.
 *
 *   The REST handlers (listTableForms, createTableForm, patchForm,
 *   inviteToForm) answer `{ status, body }` for the routes to send.
 *
 * Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { cleanOrigins } from '@/lib/customers/intake-key'
import { cleanText } from '@/lib/customers/intake'
import { hiddenGraphRefs } from '@/lib/knowledge/entity-fences'
import { isUuid } from '@/lib/tables/ops'
import { markSiteUnwired, websiteUsesForm } from '@/lib/website/store'
import { getTable } from '@/lib/tables/store'
import type { DataTable, DataTableWithColumns } from '@/lib/tables/types'
import { postedNameOf, validateFormFields } from './fields'
import { pipelineFormRefusal } from './pipeline'
import { createInvites, inviteDays, type InviteRequest, type MadeInvite } from './invites'
import { createForm, findFormById, formPageUrl, formUrl, listForms, updateForm, type FormPatch, type NewForm } from './store'
import { FORM_FILE_KINDS_TEXT } from './files'
import { filesFieldOf, FORM_ACCESS, FORM_FILE_LIMITS, FORM_FILES_KEY, FORM_LIMITS, FORM_TITLE_KEY, type DataForm, type FormAccess, type FormField } from './types'

type Checked<T> = { ok: true; value: T } | { ok: false; error: string }
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

export const NOT_INVITED_REFUSAL = 'Only a form for invited people takes personal links: set who can submit to invited first.'

/** Why a form that takes files can't have the bot check off. */
export const FILES_NEED_BOT_CHECK =
  'A form that takes files needs the bot check on: without it, anyone holding the link could fill it with uploads. Turn the bot check on, or take Files off the form.'

/** Why these fields and this bot check can't be saved together, or null. Pure. */
export function filesBotCheckRefusal(fields: readonly FormField[], botCheck: boolean): string | null {
  return filesFieldOf(fields) && !botCheck ? FILES_NEED_BOT_CHECK : null
}

type FormTable = Pick<DataTableWithColumns, 'id' | 'name' | 'columns'>

/** Who can submit, in words. Pure. */
export function whoCanSubmit(access: FormAccess): string {
  if (access === 'public') return 'anyone with the link'
  if (access === 'members') return 'signed-in workspace members'
  return 'people with a personal link'
}

/** The snippet a business puts on its own site to draw a public form there (public/f/embed.js). Pure. */
export function embedSnippet(origin: string, key: string): string {
  const base = origin.replace(/\/$/, '')
  return `<div data-ni-form="${key}"></div><script async src="${base}/f/embed.js"></script>`
}

/** Everything a new secret is shown in, once: the intake link, the form's page, and for a public form the embed. Pure. */
export function formLinks(origin: string, key: string, access: FormAccess): { url: string; page_url: string; embed?: string } {
  return { url: formUrl(origin, key), page_url: formPageUrl(origin, key), ...(access === 'public' ? { embed: embedSnippet(origin, key) } : {}) }
}

/** A form as the agent reads it: never its link (shown once, when made). Pure. */
export function describeForm(form: DataForm, table: FormTable) {
  const byKey = new Map(table.columns.map((c) => [c.key, c]))
  return {
    form_id: form.id,
    name: form.name,
    table: table.name,
    table_id: table.id,
    on: form.active,
    who_can_submit: whoCanSubmit(form.access),
    ...(form.description ? { description: form.description } : {}),
    ...(form.submitLabel ? { submit_label: form.submitLabel } : {}),
    bot_check: form.botCheck,
    ...(form.allowedOrigins.length ? { allowed_origins: form.allowedOrigins } : {}),
    ...(form.thanks ? { thanks: form.thanks } : {}),
    fields: form.fields.map((f) => {
      if (f.key === FORM_FILES_KEY) {
        return {
          label: f.label,
          post_as: 'files',
          type: 'files',
          takes: `up to ${FORM_FILE_LIMITS.maxFiles} files of ${FORM_FILE_LIMITS.maxBytes / (1024 * 1024)} MB each: ${FORM_FILE_KINDS_TEXT}`,
          ...(f.required ? { required: true } : {}),
        }
      }
      const col = byKey.get(f.key)
      if (f.key !== FORM_TITLE_KEY && !col) return { label: f.label, gone: 'its column was deleted, so it is skipped' }
      return {
        label: f.label,
        post_as: postedNameOf(f),
        type: col ? col.field_type : 'text',
        ...(col && (col.field_type === 'select' || col.field_type === 'multi_select') ? { options: col.options } : {}),
        ...(f.required ? { required: true } : {}),
      }
    }),
    link_starts: form.keyPrefix,
    ...(form.lastSubmittedAt ? { last_submission: form.lastSubmittedAt } : {}),
  }
}

/** One field as the builder reads it: its column's type, 'file' for the files field, null when its column is gone. */
export interface ApiFormField {
  key: string
  label: string
  required: boolean
  post_as: string
  type: DataTableWithColumns['columns'][number]['field_type'] | 'file' | null
  options?: string[]
  gone?: true
}

/** A form as the builder reads it: every setting by its own name, each field with its column's key. Never its link. Pure. */
export function formForApi(form: DataForm, table: FormTable) {
  const byKey = new Map(table.columns.map((c) => [c.key, c]))
  return {
    id: form.id,
    table_id: table.id,
    name: form.name,
    description: form.description,
    submit_label: form.submitLabel,
    thanks: form.thanks,
    access: form.access,
    who_can_submit: whoCanSubmit(form.access),
    allowed_origins: form.allowedOrigins,
    bot_check: form.botCheck,
    active: form.active,
    fields: form.fields.map((f): ApiFormField => {
      if (f.key === FORM_FILES_KEY) return { key: f.key, label: f.label, required: f.required, post_as: postedNameOf(f), type: 'file' }
      const col = f.key === FORM_TITLE_KEY ? null : byKey.get(f.key)
      const gone = f.key !== FORM_TITLE_KEY && (!col || !!col.deleted_at)
      return {
        key: f.key,
        label: f.label,
        required: f.required,
        post_as: postedNameOf(f),
        type: col ? col.field_type : gone ? null : 'text',
        ...(col && (col.field_type === 'select' || col.field_type === 'multi_select') ? { options: col.options } : {}),
        ...(gone ? { gone: true } : {}),
      }
    }),
    link_starts: form.keyPrefix,
    last_submission: form.lastSubmittedAt,
    created_at: form.createdAt,
    updated_at: form.updatedAt,
    // The page's address holds the secret, which is never stored: it is known only when the link is made.
    page_url_known: false as const,
  }
}

/** Why a table takes no form, or null. A pipeline takes one: each submission a new deal (./pipeline.ts). Pure. */
export function tableFormRefusal(table: Pick<DataTable, 'name' | 'archived_at'>): string | null {
  if (table.archived_at) return `${table.name} is archived.`
  return null
}

/**
 * Why `userId` can't change this table, or null: not a member, a guest, or
 * a table they reach only through a grant without an edit grant (and, from
 * the tools, not on their own attended turn: `editGrants`). The database
 * checks the same (data_table_editable_by). `db` reads their member row.
 */
export async function tableEditRefusal(
  db: SupabaseClient,
  args: { workspaceId: string; userId: string; table: Pick<DataTable, 'id' | 'name' | 'visibility' | 'owner_member_id'>; editGrants: boolean },
): Promise<string | null> {
  const { data } = await db.from('member').select('id, role').eq('workspace_id', args.workspaceId).eq('user_id', args.userId).maybeSingle()
  const me = data as { id: string; role: string } | null
  if (!me) return 'Table not found.'
  if (me.role === 'guest') return "A guest of this workspace can read its tables but can't change them."
  if (args.table.visibility === 'workspace' || args.table.owner_member_id === me.id) return null
  if (!args.editGrants) return `${args.table.name} was shared with the person, so it changes only when they ask you in their own chat.`
  const { data: editable, error } = await db.rpc('data_table_editable_by', { p_table_id: args.table.id, p_user_id: args.userId })
  if (error || editable !== true) return `The person can view ${args.table.name} but not change it.`
  return null
}

/** What every form setting may be asked as: the builder's names, or the tools' after they map theirs. */
export interface FormSettingsInput {
  name?: unknown
  description?: unknown
  submitLabel?: unknown
  thanks?: unknown
  access?: unknown
  allowedOrigins?: unknown
  botCheck?: unknown
  active?: unknown
}

type CleanSettings = Omit<FormPatch, 'fields' | 'newLink'>

/** A text setting: a string within `max` (cleaned), null or '' to clear it when `clearable`. */
function textSetting(label: string, value: unknown, max: number, opts: { multiline?: boolean; clearable: boolean }): Checked<string | null> {
  if (value === null || (typeof value === 'string' && !value.trim())) return opts.clearable ? { ok: true, value: null } : fail(`${label} can't be empty.`)
  if (typeof value !== 'string') return fail(`${label} is text.`)
  if (value.trim().length > max) return fail(`${label} is at most ${max} characters.`)
  const cleaned = cleanText(value, max, { multiline: opts.multiline })
  return cleaned ? { ok: true, value: cleaned } : opts.clearable ? { ok: true, value: null } : fail(`${label} can't be empty.`)
}

/** The settings asked for, cleaned: only those given. Pure. */
export function cleanFormSettings(input: FormSettingsInput): Checked<CleanSettings> {
  const out: CleanSettings = {}
  if (input.name !== undefined) {
    const v = textSetting('A form\'s name', input.name, FORM_LIMITS.name, { clearable: false })
    if (!v.ok) return v
    out.name = v.value as string
  }
  if (input.description !== undefined) {
    const v = textSetting('The description', input.description, FORM_LIMITS.description, { multiline: true, clearable: true })
    if (!v.ok) return v
    out.description = v.value
  }
  if (input.submitLabel !== undefined) {
    const v = textSetting("The button's words", input.submitLabel, FORM_LIMITS.submitLabel, { clearable: true })
    if (!v.ok) return v
    out.submitLabel = v.value
  }
  if (input.thanks !== undefined) {
    const v = textSetting('The thank-you line', input.thanks, FORM_LIMITS.thanks, { multiline: true, clearable: true })
    if (!v.ok) return v
    out.thanks = v.value
  }
  if (input.access !== undefined) {
    if (typeof input.access !== 'string' || !(FORM_ACCESS as readonly string[]).includes(input.access)) return fail(`Who can submit is one of ${FORM_ACCESS.join(', ')}.`)
    out.access = input.access as FormAccess
  }
  if (input.allowedOrigins !== undefined) {
    const raw = input.allowedOrigins
    if (!Array.isArray(raw) || raw.some((o) => typeof o !== 'string')) return fail('The allowed sites are a list of addresses, e.g. ["https://brightweave.example"].')
    if (raw.length > FORM_LIMITS.origins) return fail(`At most ${FORM_LIMITS.origins} allowed sites.`)
    const cleaned = cleanOrigins(raw)
    if (cleaned.length < raw.filter((o) => (o as string).trim()).length) return fail('Each allowed site is an https address, e.g. https://brightweave.example.')
    out.allowedOrigins = cleaned
  }
  if (input.botCheck !== undefined) {
    if (typeof input.botCheck !== 'boolean') return fail('bot_check is true or false.')
    out.botCheck = input.botCheck
  }
  if (input.active !== undefined) {
    if (typeof input.active !== 'boolean') return fail('active is true or false.')
    out.active = input.active
  }
  return { ok: true, value: out }
}

/**
 * A new form on `table`, from what was asked: `fields` as
 * `[{ key, label?, required? }]` by column key. Its name defaults to the
 * table's, who may submit to anyone with the link, and the bot check to on
 * (a form is hosted unless said otherwise). Pure.
 */
export function prepareNewForm(
  table: Pick<DataTableWithColumns, 'id' | 'name' | 'columns' | 'archived_at'>,
  who: { workspaceId: string; userId: string },
  input: FormSettingsInput & { fields: unknown },
): Checked<NewForm> {
  const refused = tableFormRefusal(table)
  if (refused) return fail(refused)
  const settings = cleanFormSettings({ ...input, name: input.name === undefined || input.name === null || input.name === '' ? table.name.slice(0, FORM_LIMITS.name) : input.name })
  if (!settings.ok) return settings
  const fields = validateFormFields(table.columns, input.fields)
  if (!fields.ok) return fields
  const unmet = pipelineFormRefusal(table.columns, fields.value)
  if (unmet) return fail(unmet)
  const s = settings.value
  const files = filesBotCheckRefusal(fields.value, s.botCheck ?? true)
  if (files) return fail(files)
  return {
    ok: true,
    value: {
      workspaceId: who.workspaceId,
      tableId: table.id,
      userId: who.userId,
      name: s.name ?? table.name,
      fields: fields.value,
      access: s.access ?? 'public',
      allowedOrigins: s.allowedOrigins ?? [],
      thanks: s.thanks ?? null,
      description: s.description ?? null,
      submitLabel: s.submitLabel ?? null,
      botCheck: s.botCheck ?? true,
    },
  }
}

/**
 * A change to a form on `table`, from what was asked; `newLink: true` makes a
 * new link, written as `userId`. Nothing asked is refused. `current` is the
 * form as it is: the fields and the bot check the change leaves are checked
 * together (files need the bot check). Pure.
 */
export function prepareFormPatch(
  table: Pick<DataTableWithColumns, 'columns'>,
  userId: string,
  input: FormSettingsInput & { fields?: unknown; newLink?: unknown },
  current: Pick<DataForm, 'fields' | 'botCheck'>,
): Checked<FormPatch> {
  const settings = cleanFormSettings(input)
  if (!settings.ok) return settings
  const patch: FormPatch = { ...settings.value }
  if (input.fields !== undefined) {
    const fields = validateFormFields(table.columns, input.fields)
    if (!fields.ok) return fields
    const unmet = pipelineFormRefusal(table.columns, fields.value)
    if (unmet) return fail(unmet)
    patch.fields = fields.value
  }
  if (input.newLink !== undefined && input.newLink !== true && input.newLink !== false) return fail('new_link is true or false.')
  if (input.newLink === true) patch.newLink = { userId }
  if (!Object.keys(patch).length) return fail('Nothing to change.')
  const files = filesBotCheckRefusal(patch.fields ?? current.fields, patch.botCheck ?? current.botCheck)
  if (files) return fail(files)
  return { ok: true, value: patch }
}

/**
 * What a change to a form stops a website's own HTML form doing, when one
 * is wired to it: a new link (it posts to the old one), switching the form
 * off, taking it away from anyone with the link, turning the bot check on
 * (a site's own form can't run it), or adding a files field (which needs
 * the bot check, and which a site's own form doesn't send).
 */
export type WebsiteBreak = 'new_link' | 'off' | 'access' | 'files' | 'bot_check'

type FormBreakShape = Pick<DataForm, 'access' | 'active' | 'botCheck' | 'fields'>

/** What this change stops a wired website's form doing, or null. `before` and `after` are the form either side of it. Pure. */
export function websiteBreakOf(before: FormBreakShape | null, after: FormBreakShape | null, newLink: boolean): WebsiteBreak | null {
  if (newLink) return 'new_link'
  if (!before || !after) return null
  if (before.active && !after.active) return 'off'
  if (before.access === 'public' && after.access !== 'public') return 'access'
  if (!filesFieldOf(before.fields) && filesFieldOf(after.fields)) return 'files'
  if (!before.botCheck && after.botCheck) return 'bot_check'
  return null
}

/** What the caller is told when a change left the connected website's form posting to no avail: what stopped, and what to do. Pure. */
export function websiteUnwiredNote(formId: string, broke: WebsiteBreak = 'new_link'): string {
  const reconnect = `wire_website_form with form_id ${formId}`
  switch (broke) {
    case 'off':
      return `Their connected website's form posts to this form, so its entries stop arriving while the form is off. Tell them, and once it is back on, offer to reconnect the site (${reconnect}).`
    case 'access':
      return `Their connected website's form can only post to a form anyone with the link may fill in, so its entries are now refused. Tell them, and offer to set who can submit back to anyone with the link and reconnect the site (${reconnect}).`
    case 'files':
      return `Their connected website's form can't send files or run the bot check a form with files needs, so its entries are now refused. Tell them, and offer to take Files off the form and reconnect the site (${reconnect}), or to share the form's own page or embed instead.`
    case 'bot_check':
      return `Their connected website's form can't run the bot check, so its entries are now refused. Tell them, and offer to turn the bot check off again and reconnect the site (${reconnect}).`
    default:
      return `Their connected website's form used the old link, so its entries no longer arrive. Tell them, and offer to reconnect it (${reconnect}).`
  }
}

/**
 * Write a change to a form (`write`, updateForm). When the change stops a
 * website's own form posting to it (websiteBreakOf: a new link, switched
 * off, no longer public, the bot check on, a files field added) and the
 * connected website was wired to this form, the site is marked unwired
 * (src/lib/website/store.ts), as a new quote link does, and `website` says
 * what stopped and what to do. `before` is the form as it was; read here
 * when not given. The website part never throws and never fails the change:
 * a read or a check that fails reads as nothing broken or not wired, a mark
 * that fails still tells (the site's posts are refused either way).
 */
export async function writeFormChange<T extends { key: string | null; form?: FormBreakShape } | null>(
  service: SupabaseClient,
  args: { workspaceId: string; formId: string; newLink: boolean; before?: FormBreakShape | null },
  write: () => Promise<T>,
): Promise<{ written: T; website: string | null }> {
  const before = args.newLink ? null : args.before !== undefined ? args.before : await findFormById(service, args.formId).catch(() => null)
  const written = await write()
  if (!written) return { written, website: null }
  const broke = args.newLink ? (written.key ? 'new_link' : null) : websiteBreakOf(before, written.form ?? null, false)
  if (!broke) return { written, website: null }
  const used = await websiteUsesForm(service, args.workspaceId, args.formId).catch(() => false)
  if (!used) return { written, website: null }
  await markSiteUnwired(service, args.workspaceId, { kind: 'form', formId: args.formId }).catch((err) => {
    console.error(`[forms] form=${args.formId} website unwire failed:`, err instanceof Error ? err.message : String(err))
  })
  return { written, website: websiteUnwiredNote(args.formId, broke) }
}

/** The contacts among `ids` in the workspace that `userId` may see. */
async function visibleContactIds(db: SupabaseClient, workspaceId: string, userId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  const { data, error } = await db.from('contact').select('id').eq('workspace_id', workspaceId).in('id', ids)
  if (error) throw new Error(`contact read failed: ${error.message}`)
  const found = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
  const hidden = await hiddenGraphRefs(db, found.map((id) => ({ type: 'contact', id })), userId, workspaceId)
  return new Set(found.filter((id) => !hidden.has(`contact:${id}`)))
}

/**
 * The personal links asked for, from `[{ label?, contact_id? }]` (one to
 * FORM_LIMITS.invitesPerCall), each contact one `userId` can see in the
 * workspace. `db` reads the contacts with the asker's fences.
 */
export async function cleanInviteRequests(db: SupabaseClient, who: { workspaceId: string; userId: string }, raw: unknown): Promise<Checked<InviteRequest[]>> {
  if (!Array.isArray(raw) || raw.length === 0) return fail('Name at least one invite, e.g. [{ "label": "Sam Rivera" }].')
  if (raw.length > FORM_LIMITS.invitesPerCall) return fail(`At most ${FORM_LIMITS.invitesPerCall} invites at once.`)
  const out: InviteRequest[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail('Each invite is { label?, contact_id? }.')
    const r = item as Record<string, unknown>
    const label = r.label === undefined || r.label === null ? { ok: true as const, value: null } : textSetting("An invite's label", r.label, FORM_LIMITS.inviteLabel, { clearable: true })
    if (!label.ok) return label
    const contact = r.contact_id ?? r.contactId
    if (contact !== undefined && contact !== null && !isUuid(contact)) return fail('contact_id is a contact\'s id.')
    out.push({ label: label.value, contactId: (contact as string | undefined) ?? null })
  }
  const asked = [...new Set(out.map((r) => r.contactId).filter((x): x is string => !!x))]
  const seen = await visibleContactIds(db, who.workspaceId, who.userId, asked)
  const missing = asked.find((id) => !seen.has(id))
  if (missing) return fail(`No contact ${missing} that you can see.`)
  return { ok: true, value: out }
}

/** Why a form takes no personal links, or null. Pure. */
export function inviteRefusal(form: Pick<DataForm, 'access' | 'active'>): string | null {
  if (form.access !== 'invited') return NOT_INVITED_REFUSAL
  if (!form.active) return 'The form is switched off: switch it on first.'
  return null
}

/** Personal links as the builder and the agent are shown them, once. Pure. */
export function describeInvites(made: readonly MadeInvite[]) {
  return made.map((m) => ({ id: m.id, label: m.label, contact_id: m.contactId, url: m.url, expires_at: m.expiresAt }))
}

// ── The REST handlers ───────────────────────────────────────────────────────

export interface ManageContext {
  /** The asker's own client (their session's RLS): finds the table and their member row. */
  db: SupabaseClient
  /** The service role's, for the secret tables, used only after the check. */
  service: SupabaseClient
  workspaceId: string
  userId: string
  origin: string
}

export type ManageResult = { status: number; body: Record<string, unknown> } | { status: number; error: string }

const notFoundTable: ManageResult = { status: 404, error: 'Table not found' }
const notFoundForm: ManageResult = { status: 404, error: 'Form not found' }

/** The table, readable by the asker, and why they can't change it (or null). */
async function tableFor(ctx: ManageContext, tableId: string): Promise<{ table: DataTableWithColumns; refusal: string | null } | null> {
  if (!isUuid(tableId)) return null
  const table = await getTable(ctx.db, ctx.workspaceId, tableId)
  if (!table) return null
  // The builder is the person's own hand in the app: a grant to edit counts (as on their attended turn).
  return { table, refusal: await tableEditRefusal(ctx.db, { workspaceId: ctx.workspaceId, userId: ctx.userId, table, editGrants: true }) }
}

/** Whether the asker is a guest of the workspace: they never see its forms. */
async function isGuest(ctx: ManageContext): Promise<boolean> {
  const { data } = await ctx.db.from('member').select('role').eq('workspace_id', ctx.workspaceId).eq('user_id', ctx.userId).maybeSingle()
  return !data || (data as { role: string }).role === 'guest'
}

/** GET /api/account/tables/<id>/forms: the table's forms, never their secrets. */
export async function listTableForms(ctx: ManageContext, tableId: string): Promise<ManageResult> {
  if (!isUuid(tableId)) return notFoundTable
  const table = await getTable(ctx.db, ctx.workspaceId, tableId)
  if (!table || (await isGuest(ctx))) return notFoundTable
  const forms = await listForms(ctx.service, ctx.workspaceId, { tableId: table.id })
  return { status: 200, body: { forms: forms.map((f) => formForApi(f, table)) } }
}

/** POST /api/account/tables/<id>/forms: make a form; its secret shown once. */
export async function createTableForm(ctx: ManageContext, tableId: string, body: Record<string, unknown>): Promise<ManageResult> {
  const found = await tableFor(ctx, tableId)
  if (!found) return notFoundTable
  if (found.refusal) return { status: 403, error: found.refusal }
  const input = prepareNewForm(found.table, { workspaceId: ctx.workspaceId, userId: ctx.userId }, apiSettings(body, { fields: body.fields }))
  if (!input.ok) return { status: 400, error: input.error }
  const made = await createForm(ctx.service, input.value)
  return { status: 201, body: { form: formForApi(made.form, found.table), ...formLinks(ctx.origin, made.key, made.form.access) } }
}

/** The form, if it is in the asker's workspace and its table is one they can read; with why they can't change it. */
async function formFor(ctx: ManageContext, formId: string): Promise<{ form: DataForm; table: DataTableWithColumns; refusal: string | null } | null> {
  if (!isUuid(formId)) return null
  const form = await findFormById(ctx.service, formId)
  if (!form || form.workspaceId !== ctx.workspaceId) return null
  const found = await tableFor(ctx, form.tableId)
  return found ? { form, ...found } : null
}

/** PATCH /api/account/forms/<id>: change a form; a new secret (new_link) shown once. */
export async function patchForm(ctx: ManageContext, formId: string, body: Record<string, unknown>): Promise<ManageResult> {
  const found = await formFor(ctx, formId)
  if (!found) return notFoundForm
  if (found.refusal) return { status: 403, error: found.refusal }
  const patch = prepareFormPatch(found.table, ctx.userId, apiSettings(body, { fields: body.fields, newLink: body.new_link }), found.form)
  if (!patch.ok) return { status: 400, error: patch.error }
  const { written: updated, website } = await writeFormChange(ctx.service, { workspaceId: ctx.workspaceId, formId: found.form.id, newLink: !!patch.value.newLink, before: found.form }, () =>
    updateForm(ctx.service, ctx.workspaceId, found.form.id, patch.value),
  )
  if (!updated) return notFoundForm
  return {
    status: 200,
    body: { form: formForApi(updated.form, found.table), ...(updated.key ? formLinks(ctx.origin, updated.key, updated.form.access) : {}), ...(website ? { website } : {}) },
  }
}

/** POST /api/account/forms/<id>/invites: personal links to an invited form, shown once. */
export async function inviteToForm(ctx: ManageContext, formId: string, body: Record<string, unknown>): Promise<ManageResult> {
  const found = await formFor(ctx, formId)
  if (!found) return notFoundForm
  if (found.refusal) return { status: 403, error: found.refusal }
  const refused = inviteRefusal(found.form)
  if (refused) return { status: 400, error: refused }
  if (body.expires_in_days !== undefined && (typeof body.expires_in_days !== 'number' || !Number.isFinite(body.expires_in_days))) return { status: 400, error: 'expires_in_days is a number of days.' }
  const requests = await cleanInviteRequests(ctx.db, { workspaceId: ctx.workspaceId, userId: ctx.userId }, body.invites)
  if (!requests.ok) return { status: 400, error: requests.error }
  const days = inviteDays(body.expires_in_days)
  const made = await createInvites(ctx.service, found.form, requests.value, { userId: ctx.userId, origin: ctx.origin, expiresInDays: days })
  return { status: 201, body: { invites: describeInvites(made), expires_in_days: days } }
}

/** The builder's snake_case settings, as FormSettingsInput. Pure. */
function apiSettings<T extends Record<string, unknown>>(body: Record<string, unknown>, extra: T): FormSettingsInput & T {
  return {
    name: body.name,
    description: body.description,
    submitLabel: body.submit_label,
    thanks: body.thanks,
    access: body.access,
    allowedOrigins: body.allowed_origins,
    botCheck: body.bot_check,
    active: body.active,
    ...extra,
  }
}
