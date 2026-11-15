/**
 * A website form wired to one of the business's forms (src/lib/forms), not
 * the quote intake: each submission then also lands as a new row of that
 * form's table.
 *
 *   target     {@link formWiringTarget}: the form, checked against the person
 *              asking with the conditions update_form applies
 *              (src/lib/ai/tools/tables.ts editRefusal, which lives inside
 *              that tool's closure): a member who isn't a guest, and the
 *              table open to the whole workspace, theirs, or (on their own
 *              attended turn) one the database says they may change
 *              (data_table_editable_by). Also public and switched on: a
 *              website's visitors can post to nothing else. And taking no
 *              files: the wiring switches the bot check off, and a form with
 *              files must keep it on (src/lib/forms/manage.ts
 *              FILES_NEED_BOT_CHECK, and migration 663's check).
 *   brief      {@link formBriefFields}: what the coding run posts, as
 *              `{ label, post_as, type, required, options }` per field: the
 *              field labels and their columns' kinds and choices, never the
 *              table's name or anything else of the workspace.
 *   go live    {@link activateFormLink}, at the merge, as the quote key's
 *              swap is: the form's link becomes the one the site carries
 *              (made with the brief; only its SHA-256 is kept on the change),
 *              so its older link stops at that moment; the site's origins
 *              join its allowed ones; its bot check goes off (a site's own
 *              HTML form can't run it); its rows are written as the person
 *              who asked, as update_form's new link does. A form given a
 *              files field since the pull request can't go live so: that
 *              is {@link FormWiringRefused}, a refusal for good, which
 *              approval.ts turns into the wiring failing once, never a
 *              retry on every poll.
 *
 * Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { cleanOrigins } from '@/lib/customers/intake-key'
import { postedNameOf } from '@/lib/forms/fields'
import { findFormById } from '@/lib/forms/store'
import { filesFieldOf, FORM_LIMITS, FORM_TITLE_KEY, isFormFieldType, type DataForm } from '@/lib/forms/types'
import { getTable } from '@/lib/tables/store'
import type { DataColumn } from '@/lib/tables/types'
import type { WebsiteChange } from './types'

type Svc = SupabaseClient

/** One field as the coding run reads it. */
export interface FormBriefField {
  label: string
  /** The name the site's input posts it under. */
  post_as: string
  type: string
  required: boolean
  /** A select's or a multi-select's choices; empty otherwise. */
  options: string[]
}

export interface FormTarget {
  form: DataForm
  fields: FormBriefField[]
}

export type FormTargetResult = { ok: true; target: FormTarget } | { ok: false; code: string; error: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const no = (code: string, error: string): FormTargetResult => ({ ok: false, code, error })

/** The form's fields the run posts, from its table's live columns: a field whose column is gone or can't be filled any more is left out. Pure. */
export function formBriefFields(form: Pick<DataForm, 'fields'>, columns: readonly Pick<DataColumn, 'key' | 'field_type' | 'options' | 'deleted_at'>[]): FormBriefField[] {
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const out: FormBriefField[] = []
  for (const field of form.fields) {
    if (field.key === FORM_TITLE_KEY) {
      out.push({ label: field.label, post_as: postedNameOf(field), type: 'text', required: field.required, options: [] })
      continue
    }
    const col = byKey.get(field.key)
    if (!col || col.deleted_at || !isFormFieldType(col.field_type)) continue
    const choices = col.field_type === 'select' || col.field_type === 'multi_select' ? (col.options ?? []).slice(0, 50) : []
    out.push({ label: field.label, post_as: postedNameOf(field), type: col.field_type, required: field.required, options: choices })
  }
  return out
}

/**
 * The form a wiring posts to, if the person may point their website at it
 * (see the header). `editGrants`: their own attended turn, where a table
 * shared with them by an edit grant counts. Throws on a failed read.
 */
export async function formWiringTarget(svc: Svc, who: { userId: string; workspaceId: string }, formId: string, opts: { editGrants: boolean }): Promise<FormTargetResult> {
  const missing = no('NO_SUCH_FORM', `No form ${formId} that they can change. list_forms lists them.`)
  const id = formId.trim()
  if (!UUID_RE.test(id)) return missing
  const form = await findFormById(svc, id)
  if (!form || form.workspaceId !== who.workspaceId) return missing
  const { data: member } = await svc.from('member').select('id, role').eq('workspace_id', who.workspaceId).eq('user_id', who.userId).maybeSingle()
  const me = member as { id: string; role: string } | null
  if (!me) return missing
  if (me.role === 'guest') return no('NOT_ALLOWED', "A guest of this workspace can't point the website at one of its forms.")
  const table = await getTable(svc, who.workspaceId, form.tableId)
  if (!table) return missing
  if (table.archived_at) return no('TABLE_ARCHIVED', 'That form’s table is archived, so it takes nothing. Nothing was started.')
  if (table.visibility !== 'workspace' && table.owner_member_id !== me.id) {
    if (!opts.editGrants) return no('NOT_ALLOWED', 'That form’s table was shared with them, so the website is pointed at it only when they ask in their own chat.')
    const { data: editable, error } = await svc.rpc('data_table_editable_by', { p_table_id: table.id, p_user_id: who.userId })
    if (error || editable !== true) return no('NOT_ALLOWED', 'They can view that form’s table but not change it, so the website can’t be pointed at it. Nothing was started.')
  }
  if (form.access !== 'public') {
    return no('FORM_NOT_PUBLIC', 'That form takes only signed-in members, so a website’s visitors can’t post to it. If they want it open to anyone, update_form with who_can_submit public first, then try again.')
  }
  if (!form.active) return no('FORM_OFF', 'That form is switched off, so it takes nothing. If they want it on, update_form with on: true first, then try again.')
  if (filesFieldOf(form.fields)) return no('FORM_TAKES_FILES', FORM_TAKES_FILES)
  const fields = formBriefFields(form, table.columns)
  if (!fields.length) return no('FORM_EMPTY', 'That form has no fields left to fill (its columns are gone). Fix the form first (update_form with fields).')
  return { ok: true, target: { form, fields } }
}

/**
 * Why a form that takes files can't be wired: the wiring switches its bot
 * check off (a site's own HTML form can't run it), and a form with files
 * must keep it on.
 */
export const FORM_TAKES_FILES =
  'That form takes files, and a form with files must keep its bot check on, which a website’s own form can’t run. Nothing was started. Either take Files off the form first (update_form with files: null) and try again, or give them the form’s own page or its embed snippet instead, which do run the bot check.'

/**
 * A form wiring that can never go live as it stands (the form took a files
 * field after the pull request): the merge fails it once, with `reason`,
 * instead of trying again.
 */
export class FormWiringRefused extends Error {
  readonly code: string
  readonly reason: string
  constructor(code: string, reason: string) {
    super(reason)
    this.name = 'FormWiringRefused'
    this.code = code
    this.reason = reason
  }
}

/** The allowed origins a wired form ends with: the site's first (never dropped), then the ones it had, up to the form's limit. Pure. */
export function wiredFormOrigins(siteOrigins: readonly string[], had: readonly string[]): string[] {
  return cleanOrigins([...siteOrigins, ...had]).slice(0, FORM_LIMITS.origins)
}

/**
 * What the merge writes on the form. `bot_check` arrives with migration 661
 * (another change, its column and its DataForm field): this payload is typed
 * here, not through DataForm, so this file compiles with or without it.
 */
interface FormLinkWrite {
  key_hash: string
  key_prefix: string
  created_by: string
  allowed_origins: string[]
  bot_check?: false
  updated_at: string
}

/** A database without migration 661's column refuses a write that names it. */
function missingBotCheckColumn(error: { code?: string; message?: string } | null): boolean {
  return !!error && /bot_check/.test(error.message ?? '') && (error.code === '42703' || error.code === 'PGRST204' || /column/i.test(error.message ?? ''))
}

/**
 * A form wiring merged: the form's link becomes the site's (see the header).
 * Safe to repeat. Throws on a failed read or write, and when the form is gone
 * (the deploy watch tries again on every poll, as for a quote key); throws
 * {@link FormWiringRefused}, before writing anything, when the form now takes
 * files (no retry can make that write go through).
 */
export async function activateFormLink(svc: Svc, change: Pick<WebsiteChange, 'workspaceId' | 'wiringIntake' | 'intakeKeyHash' | 'intakeKeyPrefix' | 'intakeOrigins' | 'requestedBy'>): Promise<void> {
  if (change.wiringIntake?.kind !== 'form' || !change.intakeKeyHash || !change.intakeKeyPrefix) return
  const form = await findFormById(svc, change.wiringIntake.formId)
  if (!form || form.workspaceId !== change.workspaceId) throw new Error('the wired form is gone')
  if (filesFieldOf(form.fields)) throw new FormWiringRefused('FORM_TAKES_FILES', 'the form now takes files, and a form with files must keep its bot check on, which a website’s own form can’t run')
  const link: FormLinkWrite = {
    key_hash: change.intakeKeyHash,
    key_prefix: change.intakeKeyPrefix,
    created_by: change.requestedBy,
    allowed_origins: wiredFormOrigins(change.intakeOrigins, form.allowedOrigins),
    updated_at: new Date().toISOString(),
  }
  const update = (payload: FormLinkWrite) => svc.from('data_form').update(payload).eq('workspace_id', change.workspaceId).eq('id', form.id)
  let { error } = await update({ ...link, bot_check: false })
  // No bot check column yet (661 not applied): there is no bot check to switch off.
  if (missingBotCheckColumn(error)) ({ error } = await update(link))
  if (error) throw new Error(`data_form update failed: ${error.message}`)
}
