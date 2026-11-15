/**
 * POST /api/intake/forms/<key>: a submission to a form (forms phase 1).
 * Public on purpose: the proxy's matcher covers /account and /admin only,
 * and the key in the URL is what opens the form (./store.ts). A stranger
 * holding it can add ONE row to ONE table through the form's own fields, and
 * nothing else: no read, no edit, no delete, no other column. In order:
 *
 *   1. the key: malformed, wrong or replaced → 404, nothing read; a form
 *      that is switched off → 410;
 *   2. who: a `members` form takes only a signed-in member of its workspace
 *      (401 / 403), and answers no other site's browser (no CORS). A `public`
 *      form checks the origin: when the owner listed sites, a browser from
 *      any other is refused (403); with none listed any may post (the key is
 *      the gate). A script can fake an origin: this stops other websites
 *      embedding the form, not a determined sender, which the caps do;
 *   3. the caps: the try is recorded first and then counted, so posts sent
 *      side by side can't each see room. FORM_CLIENT_HOURLY_CAP tries a
 *      sender per hour across every form (their address as the edge set it,
 *      an IPv6 one as its /64, kept only as a keyed hash: ./client.ts), and
 *      FORM_HOURLY_CAP tries a form per hour. Past either, 429. Every try
 *      counts, a refused one too, so a few senders can use up a form's hour:
 *      the cap bounds what reaches the table, and the form's owner hears of
 *      it in the log (ALERT). The hosted page's bot check is phase 3's;
 *   4. the body (JSON, form or multipart): a honeypot hit is answered exactly
 *      as if stored; a value that doesn't fit its column, or a required field
 *      left empty, is 400 and names the field (./fields.ts);
 *   5. the try is named (a submission id this sender already posted is a
 *      repeat: answered 200 with the row it stored, stored once);
 *   6. the form's maker must still be able to change the table, checked
 *      before anything is made;
 *   7. the contact: with an email or a phone, the CRM contact is found or
 *      made as a lead (its email and phone never changed by what a stranger
 *      typed: src/lib/customers/contacts.ts), and linked on the row when the
 *      table has a column that links contacts. A failure here never loses
 *      the row: a link the table refuses (a contact its maker can't see) is
 *      left off and the row is stored without it;
 *   8. the row is written, as the form's maker, with source 'form': the
 *      database marks it from_form in the same insert, so the agents read it
 *      only as untrusted data. Why a write was refused is never told to the
 *      sender.
 *
 * Answers JSON `{ ok, id, thanks? }` (201; 200 for a repeat), or a 303 to the
 * form's `_redirect` when it names a listed origin's page. Never the row
 * back, never anything else of the workspace's. Logs ids and outcomes only.
 *
 * Pure over {@link FormSubmitDeps}; the route passes the real store.
 */
import { randomUUID } from 'node:crypto'
import { apiError, badRequest, forbidden, notFound, rateLimited, serverError, unauthorized } from '@/lib/api-errors'
import type { CustomFieldValue } from '@/lib/crm/custom-fields'
import { readFormBody } from '@/lib/customers/intake'
import { corsHeaders, originAllowed, safeRedirect } from '@/lib/customers/intake-handler'
import type { DataColumn } from '@/lib/tables/types'
import { parseSubmission, type ParsedSubmission } from './fields'
import type { ClaimedAttempt } from './store'
import type { DataForm } from './types'

/** Tries one form takes in an hour. */
export const FORM_HOURLY_CAP = 60
/** Tries one sender makes in an hour, across every form. */
export const FORM_CLIENT_HOURLY_CAP = 10
const HOUR_MS = 60 * 60_000

export type FormWriteResult = { ok: true } | { ok: false; reason: 'invalid' | 'unavailable'; error: string }

export interface FormSubmitDeps {
  findForm(key: string): Promise<DataForm | null>
  /** The sender, as a keyed hash of their address; null when the edge said nothing usable. */
  clientKey(request: Request): string | null
  /** A `members` form only: 'member', or why not. */
  memberOf(request: Request, workspaceId: string): Promise<'member' | 'signed_out' | 'not_member'>
  countFormAttempts(formId: string, sinceIso: string): Promise<number>
  countClientAttempts(clientHash: string, sinceIso: string): Promise<number>
  /** The table's columns now, or null when the table is gone or archived. */
  columns(form: DataForm): Promise<DataColumn[] | null>
  /** Open a try, counted by the caps from this moment; its id. */
  openAttempt(formId: string, clientHash: string | null): Promise<string>
  claimAttempt(args: { attemptId: string; formId: string; clientHash: string | null; externalId: string | null; rowId: string }): Promise<ClaimedAttempt>
  /** Whether the form's maker can still change its table (its rows are written as them). */
  canWrite(form: DataForm): Promise<boolean>
  markStored(attemptId: string, formId: string): Promise<void>
  releaseAttempt(attemptId: string): Promise<void>
  /** Find or make the CRM contact; its id, or null. May throw: the row is written either way. */
  upsertContact(form: DataForm, contact: NonNullable<ParsedSubmission['contact']>): Promise<string | null>
  writeRow(form: DataForm, row: { id: string; title: string; values: Record<string, CustomFieldValue> }): Promise<FormWriteResult>
  /** After a row is stored: its loops and the maker's inbox event. */
  afterStored?(form: DataForm, rowId: string): Promise<void>
  now?: () => number
  newId?: () => string
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
  return response
}

/** The CORS headers a form answers `origin` with: none for a `members` form (the app's own pages only). Pure. */
export function formCorsHeaders(origin: string | null, form: Pick<DataForm, 'access' | 'allowedOrigins'> | null): Record<string, string> {
  if (form?.access === 'members') return { Vary: 'Origin' }
  return corsHeaders(origin, form)
}

/**
 * Whether a browser's request comes from the app's own pages: its Origin
 * names the host the request was sent to. No Origin (not a browser's
 * cross-site request) passes. Pure.
 */
export function sameSite(request: Request, origin: string | null): boolean {
  if (!origin) return true
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').split(',')[0].trim().toLowerCase()
  try {
    return !!host && new URL(origin).host.toLowerCase() === host
  } catch {
    return false
  }
}

/** The table's column a row's contact goes in: its first live one that links contacts, or null. Pure. */
export function contactColumnOf(columns: readonly DataColumn[]): DataColumn | null {
  return columns.find((c) => !c.deleted_at && c.field_type === 'relation' && c.config?.target?.kind === 'contact') ?? null
}

/** Answer one submission (see the header). */
export async function handleFormSubmit(request: Request, rawKey: string, deps: FormSubmitDeps): Promise<Response> {
  const origin = request.headers.get('origin')
  const unavailable = () => serverError('Could not take this right now.')
  let form: DataForm | null
  try {
    form = await deps.findForm(rawKey)
  } catch (err) {
    console.error('[form-intake] form lookup failed:', err instanceof Error ? err.message : String(err))
    return withHeaders(unavailable(), formCorsHeaders(origin, null))
  }
  if (!form) return withHeaders(notFound('Not found'), formCorsHeaders(origin, null))
  const cors = formCorsHeaders(origin, form)
  if (!form.active) return withHeaders(apiError('This form is closed.', { status: 410, code: 'FORM_CLOSED' }), cors)

  if (form.access === 'members') {
    // The member's session rides the request, so only the app's own pages may send it.
    if (!sameSite(request, origin)) return withHeaders(forbidden('This form is filled in from the app.'), cors)
    let who: Awaited<ReturnType<FormSubmitDeps['memberOf']>>
    try {
      who = await deps.memberOf(request, form.workspaceId)
    } catch (err) {
      console.error('[form-intake] member check failed:', err instanceof Error ? err.message : String(err))
      return withHeaders(unavailable(), cors)
    }
    if (who === 'signed_out') return withHeaders(unauthorized('Sign in to fill in this form.'), cors)
    if (who !== 'member') return withHeaders(forbidden('This form is for members of its workspace.'), cors)
  } else if (!originAllowed(origin, form)) {
    console.warn(`[form-intake] form=${form.id} origin refused`)
    return withHeaders(apiError('This site may not post to this form.', { status: 403, code: 'ORIGIN_REFUSED' }), cors)
  }

  // The try is opened before its caps are read, so they count it: posts sent side by side can't each see room.
  const now = (deps.now ?? Date.now)()
  const since = new Date(now - HOUR_MS).toISOString()
  const client = deps.clientKey(request)
  let attemptId: string
  try {
    attemptId = await deps.openAttempt(form.id, client)
    if (client && (await deps.countClientAttempts(client, since)) > FORM_CLIENT_HOURLY_CAP) {
      console.warn(`[form-intake] form=${form.id} sender cap reached`)
      return withHeaders(rateLimited('Too many submissions from you right now. Try again in a little while.'), cors)
    }
    if ((await deps.countFormAttempts(form.id, since)) > FORM_HOURLY_CAP) {
      console.warn(`[form-intake] form=${form.id} ALERT hourly cap reached`)
      return withHeaders(rateLimited('This form is busy right now. Try again in a little while.'), cors)
    }
  } catch (err) {
    // A cap that can't be written or read is a hold, never an open door.
    console.error('[form-intake] cap check failed:', err instanceof Error ? err.message : String(err))
    return withHeaders(unavailable(), cors)
  }

  const posted = await readFormBody(request)
  if (!posted) return withHeaders(badRequest('Send the form as JSON or form fields.'), cors)

  let columns: DataColumn[] | null
  try {
    columns = await deps.columns(form)
  } catch (err) {
    console.error('[form-intake] columns read failed:', err instanceof Error ? err.message : String(err))
    return withHeaders(unavailable(), cors)
  }
  if (!columns) return withHeaders(apiError('This form is closed.', { status: 410, code: 'FORM_CLOSED' }), cors)

  const redirect = form.access === 'public' ? safeRedirect((posted as Record<string, unknown>)._redirect, form) : null
  const done = (id: string, status: 200 | 201) => {
    if (redirect) return withHeaders(new Response(null, { status: 303, headers: { Location: redirect } }), cors)
    return withHeaders(Response.json({ ok: true, id, ...(form.thanks ? { thanks: form.thanks } : {}) }, { status }), cors)
  }
  const newId = deps.newId ?? randomUUID

  const parsed = parseSubmission(form.fields, columns, posted)
  if (!parsed.ok) {
    // A bot filled the honeypot: answered exactly as if stored, so it learns nothing.
    if (parsed.reason === 'bot') return done(newId(), 201)
    return withHeaders(badRequest(parsed.error), cors)
  }
  const submission = parsed.submission

  const rowId = newId()
  let claimed: ClaimedAttempt
  try {
    claimed = await deps.claimAttempt({ attemptId, formId: form.id, clientHash: client, externalId: submission.externalId, rowId })
  } catch (err) {
    console.error('[form-intake] attempt write failed:', err instanceof Error ? err.message : String(err))
    return withHeaders(unavailable(), cors)
  }
  if (claimed.kind === 'repeat') {
    if (claimed.rowId) return done(claimed.rowId, 200)
    // The first post of this submission is still being stored (or failed a moment ago): never "stored" on its word.
    return withHeaders(apiError('That submission is already being sent. Try again in a moment.', { status: 409, code: 'SUBMISSION_IN_FLIGHT' }), cors)
  }

  // Before anything is made: the form's maker must still be able to change the table.
  let writable = false
  try {
    writable = await deps.canWrite(form)
  } catch (err) {
    console.error('[form-intake] maker check failed:', err instanceof Error ? err.message : String(err))
  }
  if (!writable) {
    await deps.releaseAttempt(attemptId)
    console.error(`[form-intake] form=${form.id} ALERT its maker can no longer change the table: nothing stored`)
    return withHeaders(unavailable(), cors)
  }

  const values = { ...submission.values }
  let linked: string | null = null
  if (submission.contact) {
    const column = contactColumnOf(columns)
    try {
      const contactId = await deps.upsertContact(form, submission.contact)
      if (contactId && column) {
        values[column.key] = [contactId]
        linked = column.key
      }
    } catch (err) {
      console.warn(`[form-intake] form=${form.id} contact skipped:`, err instanceof Error ? err.message : String(err))
    }
  }

  const write = async (rowValues: Record<string, CustomFieldValue>): Promise<FormWriteResult> => {
    try {
      return await deps.writeRow(form, { id: rowId, title: submission.title, values: rowValues })
    } catch (err) {
      return { ok: false, reason: 'unavailable', error: err instanceof Error ? err.message : String(err) }
    }
  }
  let written = await write(values)
  if (!written.ok && linked) {
    // The contact may be one the form's maker can't see (someone's private contact): the row is kept, without the link.
    const { [linked]: _dropped, ...unlinked } = values
    console.warn(`[form-intake] form=${form.id} contact link refused, stored without it`)
    written = await write(unlinked)
  }
  if (!written.ok) {
    await deps.releaseAttempt(attemptId)
    // Why the table refused is the workspace's own business: never told to the sender.
    console.error(`[form-intake] form=${form.id} ALERT submission not stored (${written.reason}): ${written.error}`)
    return withHeaders(written.reason === 'invalid' ? badRequest("This form can't take that right now.") : unavailable(), cors)
  }
  await deps.markStored(attemptId, form.id)
  console.info(`[form-intake] form=${form.id} row=${rowId} stored`)
  // What a stored submission starts (the table's record_created loops, the maker's inbox). Never loses the answer.
  try {
    await deps.afterStored?.(form, rowId)
  } catch (err) {
    console.error(`[form-intake] form=${form.id} follow-ups failed:`, err instanceof Error ? err.message : String(err))
  }
  return done(rowId, 201)
}
