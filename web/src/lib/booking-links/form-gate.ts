/**
 * A form in front of a booking link (booking insights, phase 4; migration
 * 705's booking_link.form_id, form_rule and form_refusal). The guest answers
 * the form first; only those whose answers meet the link's rule go on to
 * the times. The others read a polite line (the link's own, or ours).
 *
 *   The form       one of the workspace's forms (migration 660), `public`,
 *                  on, and taking no files (the booking page posts JSON).
 *                  Attaching one takes someone who can CHANGE its table, as
 *                  making a form does (src/lib/forms/manage.ts
 *                  tableEditRefusal), so a link never opens a table its
 *                  editor can't write.
 *   The answers    land in the form's table exactly as the form's own page
 *                  writes them: POST …/qualify runs the forms intake itself
 *                  (src/lib/forms/submit.ts handleFormSubmit: its caps, bot
 *                  check, field checks, contact, the row written as the
 *                  form's maker, its loops), with the form found by the
 *                  link's form_id instead of a key (the key is kept only as
 *                  a hash, so the link can't hand it out). A guest who
 *                  doesn't qualify is still a row: what they asked is the
 *                  form's to keep.
 *   The rule       at most FORM_RULE_CONDITIONS_MAX conditions, all of which
 *                  must hold ({@link rulePasses}); none: everyone who sends
 *                  the form qualifies. Checked on the server against the
 *                  values the intake parsed, never the page's say.
 *   The pass       a qualified guest gets a pass ({@link issuePass}): an
 *                  HMAC over the link, the row and an expiry
 *                  (FORM_PASS_TTL_MS), keyed by {@link passKey} (the
 *                  server's secret under its own purpose label). POST …/book
 *                  on a gated link takes nothing without a good one, and
 *                  writes its row into the booking's own insert
 *                  (meeting_booking.form_row_id, unique where set: migration
 *                  705), so a pass books once, atomically.
 *   Abuse          /qualify is the forms intake itself, so it carries the
 *                  public form's protections, unchanged: the sender's and the
 *                  form's hourly caps (FORM_CLIENT_HOURLY_CAP,
 *                  FORM_HOURLY_CAP), the honeypot, the form's bot check when
 *                  it has it on, the origin rule (the booking page is the
 *                  app's own), the field checks and the repeat rule; its
 *                  challenge GET counts against FORM_READS_CLIENT_PER_MINUTE.
 *                  The booking itself keeps /book's caps.
 *
 * Pure but for the handlers and {@link formGateRefusal} (server only).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError, notFound, rateLimited, serverError } from '@/lib/api-errors'
import type { CustomFieldValue } from '@/lib/crm/custom-field-types'
import { issueChallenge } from '@/lib/forms/challenge'
import { formSubmitDeps } from '@/lib/forms/deps'
import { formReadLimited, formShape, type PublicFormShape } from '@/lib/forms/public'
import { handleFormSubmit, type FormSubmitDeps } from '@/lib/forms/submit'
import { findFormById } from '@/lib/forms/store'
import { filesFieldOf, type DataForm } from '@/lib/forms/types'
import { oauthStateSecret } from '@/lib/oauth/state'
import { getTable } from '@/lib/tables/store'
import type { DataColumn } from '@/lib/tables/types'
import { clientKeyOf } from './client'
import { rulePasses, ruleProblem } from './form-rule'
import type { BookingLink, FormRule } from './types'

export { conditionMet, readFormRule, rulePasses, ruleProblem } from './form-rule'

/** How long a qualified guest has to pick a time. */
export const FORM_PASS_TTL_MS = 2 * 60 * 60_000
/** What a guest who doesn't qualify reads when the link says nothing of its own. */
export const DEFAULT_FORM_REFUSAL = "Thanks for your answers. This page can't take a booking for this request, so there are no times to offer here."

// ── The pass ────────────────────────────────────────────────────────────────

const PASS_RE = /^bp1\.([0-9a-f-]{36})\.(\d{13})\.([A-Za-z0-9_-]{43})$/

/** The pass's own key: derived from the server's secret under a fixed purpose label, so it signs nothing else and needs no setting of its own. */
export function passKey(secret: string): Uint8Array {
  return new Uint8Array(createHmac('sha256', secret).update('native-intelligence/booking-form-pass/v1').digest())
}

function passMac(secret: string, linkId: string, rowId: string, exp: string): string {
  return createHmac('sha256', passKey(secret)).update(`${linkId}:${rowId}:${exp}`).digest('base64url')
}

/** A qualified guest's pass for this link and form row, good for FORM_PASS_TTL_MS. Pure over `secret`. */
export function issuePass(linkId: string, rowId: string, now: number, secret: string = oauthStateSecret()): string {
  const exp = String(Math.floor(now + FORM_PASS_TTL_MS)).padStart(13, '0')
  return `bp1.${rowId}.${exp}.${passMac(secret, linkId, rowId, exp)}`
}

/** The form row a pass vouches for on this link, or null (malformed, another link's, lapsed, forged). Pure over `secret`. */
export function verifyPass(token: unknown, linkId: string, now: number, secret: string = oauthStateSecret()): string | null {
  const m = typeof token === 'string' ? PASS_RE.exec(token.trim()) : null
  if (!m) return null
  const [, rowId, exp, mac] = m
  if (Number(exp) <= now) return null
  const want = new Uint8Array(Buffer.from(passMac(secret, linkId, rowId, exp)))
  const got = new Uint8Array(Buffer.from(mac))
  return want.length === got.length && timingSafeEqual(want, got) ? rowId : null
}

// ── Attaching a form (the account API and the tools, through ./links.ts) ───

/**
 * Why `editor` can't put this form in front of a link, or null: it must be
 * the workspace's, `public`, on, take no files, and be one they can change
 * the table of; and `rule` must fit it. Throws on a failed read.
 */
export async function formGateRefusal(supabase: SupabaseClient, editor: { workspaceId: string; userId: string }, formId: string, rule: FormRule | null): Promise<string | null> {
  const form = await findFormById(supabase, formId)
  if (!form || form.workspaceId !== editor.workspaceId) return 'No form with that id in this workspace.'
  if (form.access !== 'public') return 'Only a form anyone can fill in (who can submit: anyone with the link) can be in front of a booking link.'
  if (!form.active) return 'That form is switched off: switch it on first.'
  if (filesFieldOf(form.fields)) return "A form that takes files can't be in front of a booking link."
  const table = await getTable(supabase, form.workspaceId, form.tableId)
  if (!table || table.archived_at) return "That form's table is gone."
  const { tableEditRefusal } = await import('@/lib/forms/manage')
  const refused = await tableEditRefusal(supabase, { workspaceId: editor.workspaceId, userId: editor.userId, table, editGrants: true })
  if (refused) return refused
  return rule ? ruleProblem(rule, form, table.columns) : null
}

// ── The guest's side ────────────────────────────────────────────────────────

export interface FormGateDeps {
  supabase: SupabaseClient
  now?: () => number
  /** The link at an address, live (on, with a host) or null. */
  liveLink: (profile: string, slug: string) => Promise<BookingLink | null>
  /** The form by id (default: data_form). */
  findForm?: (formId: string) => Promise<DataForm | null>
  /** The form's table's live columns, or null when it is gone (default: its table). */
  columns?: (form: DataForm) => Promise<DataColumn[] | null>
  /** The forms intake's seams (default: the real store's, ../forms/deps.ts). */
  submit?: FormSubmitDeps
  /** A stored row's name and values, for a repeat post (default: data_row). */
  rowValues?: (form: DataForm, rowId: string) => Promise<{ title: string; values: Record<string, CustomFieldValue> } | null>
  clientKey?: (request: Request) => string | null
  secret?: string
}

export type GateForm = { kind: 'none' } | { kind: 'closed' } | { kind: 'open'; form: DataForm; shape: PublicFormShape }

/** A link's form as its page draws it: none, closed (gone, off, or no longer a form the gate takes), or open with its shape. Throws on a failed read. */
export async function gateForm(link: Pick<BookingLink, 'formId' | 'workspaceId'>, deps: Pick<FormGateDeps, 'supabase' | 'findForm' | 'columns'>): Promise<GateForm> {
  if (!link.formId) return { kind: 'none' }
  const form = await (deps.findForm ?? ((id: string) => findFormById(deps.supabase, id)))(link.formId)
  if (!form || form.workspaceId !== link.workspaceId || !form.active || form.access !== 'public' || filesFieldOf(form.fields)) return { kind: 'closed' }
  const columns = await (deps.columns ?? (async (f: DataForm) => {
    const table = await getTable(deps.supabase, f.workspaceId, f.tableId)
    return table && !table.archived_at ? table.columns : null
  }))(form)
  if (!columns) return { kind: 'closed' }
  return { kind: 'open', form, shape: formShape(form, columns) }
}

const CLOSED = () => apiError("This booking page isn't taking bookings right now.", { status: 410, code: 'CLOSED' })

async function openGate(profile: string, slug: string, deps: FormGateDeps): Promise<{ link: BookingLink; form: DataForm } | Response> {
  let link: BookingLink | null
  let gate: GateForm
  try {
    link = await deps.liveLink(profile, slug)
    if (!link) return notFound('This booking page does not exist.')
    gate = await gateForm(link, deps)
  } catch {
    return serverError('This booking page is not available right now.')
  }
  if (gate.kind === 'none') return notFound('This booking page asks nothing first.')
  if (gate.kind === 'closed') return CLOSED()
  return { link, form: gate.form }
}

/** GET …/qualify/challenge: the bot check's challenge for the link's form, when it has one on. */
export async function handleQualifyChallenge(request: Request, profile: string, slug: string, deps: FormGateDeps): Promise<Response> {
  const now = (deps.now ?? Date.now)()
  if (formReadLimited((deps.clientKey ?? clientKeyOf)(request), now)) return rateLimited('Too many requests just now. Try again in a minute.')
  const open = await openGate(profile, slug, deps)
  if (open instanceof Response) return open
  return Response.json(issueChallenge(open.form.id, now, deps.secret), { headers: { 'Cache-Control': 'no-store' } })
}

async function storedValues(supabase: SupabaseClient, form: DataForm, rowId: string): Promise<{ title: string; values: Record<string, CustomFieldValue> } | null> {
  const { data, error } = await supabase.from('data_row').select('id, title, custom_fields').eq('id', rowId).eq('table_id', form.tableId).eq('workspace_id', form.workspaceId).maybeSingle()
  if (error) throw new Error(`data_row read failed: ${error.message}`)
  const row = data as { title: string | null; custom_fields: Record<string, CustomFieldValue> | null } | null
  return row ? { title: row.title ?? '', values: row.custom_fields ?? {} } : null
}

/**
 * POST …/qualify: the guest's answers to the link's form (see the header).
 * The intake's own answer when it refuses (its status and words); else
 * `{ ok, qualified: true, pass }` or `{ ok, qualified: false, message }`.
 */
export async function handleQualify(request: Request, profile: string, slug: string, deps: FormGateDeps): Promise<Response> {
  const open = await openGate(profile, slug, deps)
  if (open instanceof Response) return open
  const { link, form } = open
  const base = deps.submit ?? formSubmitDeps(deps.supabase)
  let written: { id: string; title: string; values: Record<string, CustomFieldValue> } | null = null
  const submit: FormSubmitDeps = {
    ...base,
    // The link's form, whatever the path says: the intake never reads a key here.
    findForm: async () => form,
    formOfInvite: async () => null,
    writeRow: async (f, row) => {
      const result = await base.writeRow(f, row)
      if (result.ok) written = { id: row.id, title: row.title, values: row.values }
      return result
    },
    // Only the booking page posts here: never a redirect elsewhere.
    ...(deps.now ? { now: deps.now } : {}),
  }
  const answered = await handleFormSubmit(request, 'booking-link-gate', submit)
  if (!answered.ok) return answered
  const data = (await answered.json().catch(() => ({}))) as { ok?: boolean; id?: string }
  const rowId = typeof data.id === 'string' ? data.id : null
  if (!data.ok || !rowId) return serverError('Could not take this right now.')

  let answers = written as { id: string; title: string; values: Record<string, CustomFieldValue> } | null
  if (!answers || answers.id !== rowId) {
    // A repeat of a post already stored, or a honeypot's pretend answer: read what is stored (none: not qualified).
    try {
      const stored = await (deps.rowValues ?? ((f, id) => storedValues(deps.supabase, f, id)))(form, rowId)
      answers = stored ? { id: rowId, ...stored } : null
    } catch {
      return serverError('Could not take this right now.')
    }
  }
  const qualified = !!answers && rulePasses(link.formRule, answers)
  if (!qualified) return Response.json({ ok: true, qualified: false, message: link.formRefusal || DEFAULT_FORM_REFUSAL }, { headers: { 'Cache-Control': 'no-store' } })
  return Response.json({ ok: true, qualified: true, pass: issuePass(link.id, rowId, (deps.now ?? Date.now)(), deps.secret) }, { headers: { 'Cache-Control': 'no-store' } })
}

// ── The forms an editor may put in front of a link (Settings' picker) ──────

export interface GateableForm {
  id: string
  name: string
  table_name: string
  /** What a rule can check: each field's key, label, answer type and a select's choices. */
  fields: Array<{ key: string; label: string; type: string; options?: string[] }>
}

/**
 * The workspace's forms `editor` may put in front of a link (as
 * {@link formGateRefusal} would allow, rule aside), each with what a rule
 * can check. Never a form on a table they can't change. Throws on a failed read.
 */
export async function gateableForms(supabase: SupabaseClient, editor: { workspaceId: string; userId: string }): Promise<GateableForm[]> {
  const { listForms } = await import('@/lib/forms/store')
  const { tableEditRefusal } = await import('@/lib/forms/manage')
  const { OPS_BY_TYPE } = await import('./form-rule')
  const forms = (await listForms(supabase, editor.workspaceId)).filter((f) => f.access === 'public' && f.active && !filesFieldOf(f.fields))
  const out: GateableForm[] = []
  const tables = new Map<string, Awaited<ReturnType<typeof getTable>>>()
  for (const form of forms.slice(0, 100)) {
    if (!tables.has(form.tableId)) tables.set(form.tableId, await getTable(supabase, form.workspaceId, form.tableId))
    const table = tables.get(form.tableId)
    if (!table || table.archived_at) continue
    if (await tableEditRefusal(supabase, { workspaceId: editor.workspaceId, userId: editor.userId, table, editGrants: true })) continue
    const fields = form.fields.flatMap((f) => {
      const col = table.columns.find((c) => c.key === f.key && !c.deleted_at)
      const type = f.key === '$title' ? 'title' : col?.field_type
      if (!type || !OPS_BY_TYPE[type]) return []
      return [{ key: f.key, label: f.label, type, ...(col && (type === 'select' || type === 'multi_select') ? { options: [...(col.options ?? [])] } : {}) }]
    })
    out.push({ id: form.id, name: form.name, table_name: table.name, fields })
  }
  return out
}
