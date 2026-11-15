/**
 * Rows of migration 660: data_form (a form and its link's hashed secret) and
 * data_form_attempt (what its link tried, for the caps and for storing a
 * re-posted submission once). Every read and write is the service role's,
 * fenced here by id and workspace; a caller checks who is asking first.
 * Throws on a failed read or write, except where a function says otherwise.
 *
 * The secret in a form's link is `fk_` and 32 random bytes, base64url. Only
 * its SHA-256 is stored, so a leaked table never yields a working link; it
 * is shown once, when it is made, and a new one stops the old. A form's page
 * shows its link to anyone who views the page source, so the secret is a
 * "publishable" one: it lets a stranger add a row through the form, nothing
 * more (./submit.ts says what stands against misuse).
 *
 * Server only.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { cleanOrigins } from '@/lib/customers/intake-key'
import { readFormFields } from './fields'
import type { DataForm, FormAccess, FormField } from './types'

export const FORM_KEY_PREFIX = 'fk_'
const KEY_SHAPE = /^fk_[A-Za-z0-9_-]{43}$/

export function hashFormKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/** A fresh secret. */
export function generateFormKey(): string {
  return `${FORM_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
}

export function isFormKeyShape(value: unknown): value is string {
  return typeof value === 'string' && KEY_SHAPE.test(value)
}

/** A form's link for its secret. */
export function formUrl(origin: string, key: string): string {
  return `${origin.replace(/\/$/, '')}/api/intake/forms/${key}`
}

const FORM_COLUMNS = 'id, workspace_id, table_id, name, fields, access, allowed_origins, thanks, active, key_prefix, created_by, created_at, updated_at, last_submitted_at'

interface FormRow {
  id: string
  workspace_id: string
  table_id: string
  name: string
  fields: unknown
  access: string
  allowed_origins: string[] | null
  thanks: string | null
  active: boolean
  key_prefix: string
  created_by: string | null
  created_at: string
  updated_at: string
  last_submitted_at: string | null
}

function toForm(row: FormRow): DataForm {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    tableId: row.table_id,
    name: row.name,
    fields: readFormFields(row.fields),
    // An access this code doesn't know is the narrower one.
    access: row.access === 'public' ? 'public' : 'members',
    allowedOrigins: cleanOrigins(row.allowed_origins),
    thanks: row.thanks,
    active: row.active,
    keyPrefix: row.key_prefix,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSubmittedAt: row.last_submitted_at,
  }
}

/** The form this secret opens, or null (a wrong, replaced or malformed one). Switched-off forms too: the caller says what that means. */
export async function findFormByKey(supabase: SupabaseClient, key: string): Promise<DataForm | null> {
  if (!isFormKeyShape(key)) return null
  const { data, error } = await supabase.from('data_form').select(FORM_COLUMNS).eq('key_hash', hashFormKey(key)).maybeSingle<FormRow>()
  if (error) throw new Error(`data_form read failed: ${error.message}`)
  return data ? toForm(data) : null
}

/** A form by its id alone: the caller then checks the asker against its table. */
export async function findFormById(supabase: SupabaseClient, formId: string): Promise<DataForm | null> {
  const { data, error } = await supabase.from('data_form').select(FORM_COLUMNS).eq('id', formId).maybeSingle<FormRow>()
  if (error) throw new Error(`data_form read failed: ${error.message}`)
  return data ? toForm(data) : null
}

/** A workspace's forms, newest first; one table's when named. */
export async function listForms(supabase: SupabaseClient, workspaceId: string, opts: { tableId?: string } = {}): Promise<DataForm[]> {
  let q = supabase.from('data_form').select(FORM_COLUMNS).eq('workspace_id', workspaceId)
  if (opts.tableId) q = q.eq('table_id', opts.tableId)
  const { data, error } = await q.order('created_at', { ascending: false }).limit(200)
  if (error) throw new Error(`data_form read failed: ${error.message}`)
  return ((data ?? []) as FormRow[]).map(toForm)
}

export interface NewForm {
  workspaceId: string
  tableId: string
  userId: string
  name: string
  fields: FormField[]
  access: FormAccess
  allowedOrigins: readonly string[]
  thanks: string | null
}

/** Make a form. Answers it with its link's secret: shown once, never stored. */
export async function createForm(supabase: SupabaseClient, input: NewForm): Promise<{ form: DataForm; key: string }> {
  const key = generateFormKey()
  const { data, error } = await supabase
    .from('data_form')
    .insert({
      workspace_id: input.workspaceId,
      table_id: input.tableId,
      name: input.name,
      fields: input.fields,
      access: input.access,
      allowed_origins: cleanOrigins(input.allowedOrigins),
      thanks: input.thanks,
      key_hash: hashFormKey(key),
      key_prefix: key.slice(0, 9),
      created_by: input.userId,
    })
    .select(FORM_COLUMNS)
    .single<FormRow>()
  if (error || !data) throw new Error(`data_form insert failed: ${error?.message ?? 'no row'}`)
  return { form: toForm(data), key }
}

export interface FormPatch {
  name?: string
  fields?: FormField[]
  access?: FormAccess
  allowedOrigins?: readonly string[]
  thanks?: string | null
  active?: boolean
  /** A new link: the old one stops at once. Its rows are then written as `userId`. */
  newLink?: { userId: string }
}

/** Change a form. With `newLink`, also answers the new secret (shown once). Null when it isn't there. */
export async function updateForm(supabase: SupabaseClient, workspaceId: string, formId: string, patch: FormPatch): Promise<{ form: DataForm; key: string | null } | null> {
  const key = patch.newLink ? generateFormKey() : null
  const { data, error } = await supabase
    .from('data_form')
    .update({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.fields !== undefined ? { fields: patch.fields } : {}),
      ...(patch.access !== undefined ? { access: patch.access } : {}),
      ...(patch.allowedOrigins !== undefined ? { allowed_origins: cleanOrigins(patch.allowedOrigins) } : {}),
      ...(patch.thanks !== undefined ? { thanks: patch.thanks } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(key && patch.newLink ? { key_hash: hashFormKey(key), key_prefix: key.slice(0, 9), created_by: patch.newLink.userId } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('workspace_id', workspaceId)
    .eq('id', formId)
    .select(FORM_COLUMNS)
    .maybeSingle<FormRow>()
  if (error) throw new Error(`data_form update failed: ${error.message}`)
  return data ? { form: toForm(data), key } : null
}

// ── What a form's link counts ───────────────────────────────────────────────

/** Tries on a form since `sinceIso`. */
export async function countFormAttempts(supabase: SupabaseClient, formId: string, sinceIso: string): Promise<number> {
  const { count, error } = await supabase.from('data_form_attempt').select('id', { count: 'exact', head: true }).eq('form_id', formId).gte('created_at', sinceIso)
  if (error) throw new Error(`data_form_attempt count failed: ${error.message}`)
  return count ?? 0
}

/** One sender's tries on every form since `sinceIso`. */
export async function countClientAttempts(supabase: SupabaseClient, clientHash: string, sinceIso: string): Promise<number> {
  const { count, error } = await supabase.from('data_form_attempt').select('id', { count: 'exact', head: true }).eq('client_hash', clientHash).gte('created_at', sinceIso)
  if (error) throw new Error(`data_form_attempt count failed: ${error.message}`)
  return count ?? 0
}

/**
 * Open a try, before its cap is read: the caps count it, so posts sent side
 * by side can't each see room under them. Answers its id.
 */
export async function openAttempt(supabase: SupabaseClient, formId: string, clientHash: string | null): Promise<string> {
  const { data, error } = await supabase.from('data_form_attempt').insert({ form_id: formId, client_hash: clientHash }).select('id').single<{ id: string }>()
  if (error || !data) throw new Error(`data_form_attempt insert failed: ${error?.message ?? 'no row'}`)
  return data.id
}

export type ClaimedAttempt = { kind: 'new' } | { kind: 'repeat'; rowId: string | null }

/**
 * Name the row a try is about to write, and the form's own submission id
 * when it sent one. An id this sender already posted on this form is a
 * repeat (answered with the row it stored, when it has): the unique index
 * decides, so two posts side by side store one.
 */
export async function claimAttempt(
  supabase: SupabaseClient,
  args: { attemptId: string; formId: string; clientHash: string | null; externalId: string | null; rowId: string },
): Promise<ClaimedAttempt> {
  const { error } = await supabase.from('data_form_attempt').update({ external_id: args.externalId, row_id: args.rowId }).eq('id', args.attemptId)
  if (!error) return { kind: 'new' }
  if (error.code !== '23505' || !args.externalId) throw new Error(`data_form_attempt update failed: ${error.message}`)
  let q = supabase.from('data_form_attempt').select('row_id, stored_at').eq('form_id', args.formId).eq('external_id', args.externalId)
  q = args.clientHash ? q.eq('client_hash', args.clientHash) : q.is('client_hash', null)
  const { data: first } = await q.limit(1).maybeSingle<{ row_id: string | null; stored_at: string | null }>()
  return { kind: 'repeat', rowId: first?.stored_at ? first.row_id : null }
}

/** The try wrote its row. Best effort (the row is stored either way). */
export async function markAttemptStored(supabase: SupabaseClient, attemptId: string, formId: string): Promise<void> {
  const now = new Date().toISOString()
  try {
    await supabase.from('data_form_attempt').update({ stored_at: now }).eq('id', attemptId)
    await supabase.from('data_form').update({ last_submitted_at: now }).eq('id', formId)
  } catch {
    // Best effort.
  }
}

/** The try's write failed: it keeps counting toward the caps, and its submission id is free to post again. Best effort. */
export async function releaseAttempt(supabase: SupabaseClient, attemptId: string): Promise<void> {
  try {
    await supabase.from('data_form_attempt').update({ external_id: null, row_id: null }).eq('id', attemptId)
  } catch {
    // Best effort.
  }
}

/** Tries older than `beforeIso`: no cap counts them any more, and their submission ids are forgotten. */
export async function deleteOldFormAttempts(supabase: SupabaseClient, beforeIso: string): Promise<void> {
  const { error } = await supabase.from('data_form_attempt').delete().lt('created_at', beforeIso)
  if (error) throw new Error(`data_form_attempt delete failed: ${error.message}`)
}
