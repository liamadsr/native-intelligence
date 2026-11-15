/**
 * POST /api/intake/forms/<key>: a submission to a form (forms phases 1 and
 * 3). Public on purpose: the proxy's matcher covers /account and /admin
 * only, and the key in the URL is what opens the form (./store.ts). A
 * stranger holding it can add ONE row to ONE table through the form's own
 * fields, and nothing else: no read, no edit, no delete, no other column.
 * The key may instead be a personal link's secret (`fi_`, ./invites.ts),
 * which names its form. In order:
 *
 *   1. the key: malformed, wrong or replaced → 404, nothing read; a personal
 *      link's secret opens its form only while the link is good (not used,
 *      not lapsed) and the form is `invited` (./deps.ts), else 404 too; a
 *      form that is switched off → 410;
 *   2. who: a `members` form takes only a signed-in member of its workspace,
 *      never a guest (401 / 403), and an `invited` form only a personal link
 *      (checked at 6, claimed at 9); neither answers another site's browser
 *      (403, no CORS). A `public` form takes its own page (the app's own
 *      origin) and checks any other origin: when the owner listed sites, a
 *      browser from any other is refused (403); with none listed any may
 *      post (the key is the gate). A script can fake an origin: this stops
 *      other websites embedding the form, not a determined sender, which the
 *      caps do;
 *   3. the caps: the try is recorded first and then counted, so posts sent
 *      side by side can't each see room. FORM_CLIENT_HOURLY_CAP tries a
 *      sender per hour across every form (their address as the edge set it,
 *      an IPv6 one as its /64, kept only as a keyed hash: ./client.ts), and
 *      FORM_HOURLY_CAP tries a form per hour. Past either, 429. Every try
 *      counts, a refused one too, so a few senders can use up a form's hour:
 *      the cap bounds what reaches the table, and the form's owner hears of
 *      it in the log (ALERT);
 *   4. the body. A multipart post to a form that takes files is an upload:
 *      it must declare its length (411 without one) within the most an
 *      upload may be (413), and takes room by it among the uploads this
 *      server holds at once before a byte is read (./upload-room.ts: past
 *      the room, 503 "Try again in a moment." with Retry-After; past
 *      FORM_UPLOADS_PER_SENDER at once from one sender, 429), given back
 *      when the request ends, however it ends. Then the body is read (JSON,
 *      form or multipart: ./body.ts, which caps it before and while it is
 *      read: 413 past the cap; a form that takes files takes a bigger
 *      multipart body, every other form the quote intake's 32 KB). The bytes
 *      of files it carries are recorded on the try at once, so a refused try
 *      counts toward the byte caps too. Its own fields (_challenge, _answer,
 *      _invite, _redirect and the website check's) are taken out first, so
 *      no form field can be filled by them (and none may be called them:
 *      ./fields.ts FORM_RESERVED_NAMES). The website flow's live check
 *      (src/lib/website/intake-test.ts): a post whose check field carries a
 *      pending check's nonce is that check, answered `{ ok, test }` and never
 *      stored. It comes before the fields are read, since the check's post
 *      fills a name, an email and a message, which a form may not take;
 *   5. the bot check, when the form has it on: a solved challenge
 *      (./challenge.ts) or 400 "Reload the page and try again.";
 *   6. an `invited` form with no personal link of the right shape (the
 *      path's own, or the post's _invite) is refused at once (403, "This
 *      link has been used or has expired."), before anything else is read;
 *   7. the form's table: gone or archived since → 410, as a switched-off
 *      form is;
 *   8. the fields: a honeypot hit is answered exactly as if stored; a value
 *      that doesn't fit its column, or a required field left empty, is 400
 *      and names the field (./fields.ts). Then the files, when the form takes
 *      them: each checked by its name, its declared type and its leading
 *      bytes, at most FORM_FILE_LIMITS.maxFiles of maxBytes each, a required
 *      field's left empty refused (400, ./files.ts); then the byte caps,
 *      FORM_FILE_LIMITS.clientBytesPerHour per sender across every form,
 *      formBytesPerHour per form and workspaceBytesPerDay across all of the
 *      workspace's forms (429; a cap that can't be read is a hold). A form
 *      without a files field ignores any file posted, as before;
 *   9. the try is named (a submission id this sender already posted is a
 *      repeat: answered 200 with the row it stored, stored once; when that
 *      first post is not marked stored, its row is looked for: there, 200
 *      with it; not there, or the look fails, 409 while it is being sent; a
 *      challenge another try stores with is refused as at 5). An `invited`
 *      form's personal link is claimed here, by one update (./invites.ts):
 *      used, lapsed or missing is 403, and the try is let go;
 *  10. the form's maker must still be able to change the table, checked
 *      before anything is made;
 *  11. the contact: a personal link made for a contact links that contact,
 *      and none is found or made. Otherwise, with an email or a phone, the
 *      CRM contact is found or made (its email and phone never changed by
 *      what a stranger typed: src/lib/customers/contacts.ts), and its id
 *      linked on the row when the table has a column that links contacts.
 *      Nothing about it changes yet: a found one becomes a lead (and loses a
 *      placeholder name), and a made one starts the contact_created loops,
 *      only once the row is stored (14), and a found one the form's maker
 *      can't see is never changed (./deps.ts). A failure here never loses
 *      the row;
 *  12. on a pipeline (a table of deals) the deal's stage is the first open
 *      one and its owner the form's maker, set here and never from the post
 *      (./pipeline.ts);
 *  13. the row is written, under the id chosen for it at 9, as the form's
 *      maker, with source 'form': the database marks it from_form in the
 *      same insert, so the agents read it only as untrusted data. Why a
 *      write was refused is never told to the sender. A write the table
 *      refuses (`invalid`) while a contact is linked is tried once more
 *      without the link (a contact its maker can't see), never after any
 *      other failure. A write that fails otherwise may have been stored
 *      before its answer was lost, so the row is looked for first: there, it
 *      is stored and this carries on as if the write had answered; not
 *      there (or refused), the try's submission id, its challenge and its
 *      personal link are given back, so the person can send again; when the
 *      look fails too, nothing is given back (an ALERT: never a second row
 *      on a single-use link) and the answer is 500;
 *  14. the files, once the row exists: each stored in the private
 *      attachments bucket under a random name and inserted as an attachment
 *      of the row, marked from_form, with no uploader (./deps.ts). Nothing is
 *      extracted, thumbnailed or indexed. A file that can't be stored is
 *      logged as an ALERT and left out: the row stays and the submission
 *      still succeeds (the person can't fix the store, and resending would
 *      make a second row). Only then is the try marked stored (./store.ts:
 *      tried twice, an ALERT when it fails; a re-post then finds the row at
 *      9) and the personal link marked with its row; then what was held
 *      back for the contact (11), and the table's record_created loops. A
 *      failure in those never loses the answer.
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
import { corsHeaders, originAllowed, safeRedirect } from '@/lib/customers/intake-handler'
import type { DataColumn } from '@/lib/tables/types'
import { INTAKE_TEST_FIELD } from '@/lib/website/types'
import { BODY_TOO_LARGE_FILES, declaredLength, FORM_UPLOAD_BODY_MAX, isMultipart, readFormSubmission } from './body'
import { verifyChallenge } from './challenge'
import { parseSubmission, type ParsedSubmission } from './fields'
import { checkFormFiles, type CheckedFile } from './files'
import { isInviteTokenShape, type FormInvite } from './invites'
import { formDealValues, hasPipelineOwner, pipelineStageColumn } from './pipeline'
import type { ClaimAttemptArgs, ClaimedAttempt } from './store'
import { filesFieldOf, FORM_FILE_LIMITS, type DataForm } from './types'
import { takeUploadRoom, type UploadRoom } from './upload-room'

/** Tries one form takes in an hour. */
export const FORM_HOURLY_CAP = 60
/** Tries one sender makes in an hour, across every form. */
export const FORM_CLIENT_HOURLY_CAP = 10
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
/** Seconds a sender told to wait for room among the uploads is asked to wait. */
const UPLOAD_RETRY_AFTER_S = 5

export type FormWriteResult = { ok: true } | { ok: false; reason: 'invalid' | 'unavailable'; error: string }

/** The fields a post carries for the form itself, never for a column. */
export const FORM_CHALLENGE_FIELD = '_challenge'
export const FORM_ANSWER_FIELD = '_answer'
export const FORM_INVITE_FIELD = '_invite'
export const FORM_REDIRECT_FIELD = '_redirect'
const OWN_FIELDS = [FORM_CHALLENGE_FIELD, FORM_ANSWER_FIELD, FORM_INVITE_FIELD, FORM_REDIRECT_FIELD, INTAKE_TEST_FIELD]

/** What a refused bot check tells the person: the page's challenge is stale, or it never ran one. */
export const CHALLENGE_REFUSED = 'Reload the page and try again.'
/** What a personal link that can't be used tells the person. */
export const INVITE_REFUSED = 'This link has been used or has expired.'
/** What an upload past the server's room for uploads tells the person. */
export const UPLOAD_BUSY = 'Try again in a moment.'

/** The contact a submission links: its id, and what was held back for it until the row is stored. */
export interface FormContact {
  id: string
  /** The found contact's change and a made one's loops (./deps.ts), run once the row is stored. May throw. */
  settle?: () => Promise<void>
}

export interface FormSubmitDeps {
  findForm(key: string): Promise<DataForm | null>
  /** The form a personal link's secret opens: only while the link is good and the form is `invited`, else null. */
  formOfInvite?(token: string): Promise<DataForm | null>
  /** The sender, as a keyed hash of their address; null when the edge said nothing usable. */
  clientKey(request: Request): string | null
  /** A `members` form only: 'member' (never a guest), or why not. */
  memberOf(request: Request, workspaceId: string): Promise<'member' | 'signed_out' | 'not_member'>
  countFormAttempts(formId: string, sinceIso: string): Promise<number>
  countClientAttempts(clientHash: string, sinceIso: string): Promise<number>
  /** The table's columns now, or null when the table is gone or archived. */
  columns(form: DataForm): Promise<DataColumn[] | null>
  /** Open a try, counted by the caps from this moment; its id. */
  openAttempt(formId: string, clientHash: string | null): Promise<string>
  claimAttempt(args: ClaimAttemptArgs): Promise<ClaimedAttempt>
  /** An `invited` form: claim the personal link for this submission (good, this form's), or null. */
  claimInvite?(formId: string, token: string, nowIso: string): Promise<FormInvite | null>
  /** The claimed link's submission was not stored: it works again. */
  releaseInvite?(inviteId: string): Promise<void>
  markInviteStored?(inviteId: string, rowId: string): Promise<void>
  /** The website flow's live check: true when `nonce` is one of the workspace's pending checks (recorded). */
  takeTest?(workspaceId: string, nonce: string): Promise<boolean>
  /** The bot check's key; the server's own when not given. */
  challengeSecret?(): string
  /** Whether the form's maker can still change its table (its rows are written as them). */
  canWrite(form: DataForm): Promise<boolean>
  markStored(attemptId: string, formId: string): Promise<void>
  releaseAttempt(attemptId: string): Promise<void>
  /** Whether the row with this id is in the form's table: a write whose answer was lost may have stored it. Throws when it can't tell. Without it, a failed write is taken as not stored. */
  rowExists?(form: DataForm, rowId: string): Promise<boolean>
  /** The form's maker's member id in its workspace (a pipeline's deal is theirs), or null. May throw: the deal is written unowned then. */
  makerMemberId?(form: DataForm): Promise<string | null>
  /** Find or make the CRM contact: its id (and what is held back for it), or null. May throw: the row is written either way. */
  upsertContact(form: DataForm, contact: NonNullable<ParsedSubmission['contact']>): Promise<string | FormContact | null>
  writeRow(form: DataForm, row: { id: string; title: string; values: Record<string, CustomFieldValue> }): Promise<FormWriteResult>
  /** The bytes of files this try carried (./store.ts recordAttemptBytes). A form that takes files takes none without it. */
  recordUploadBytes?(attemptId: string, bytes: number): Promise<void>
  /** Bytes of files sent since `sinceIso`: by one sender, to one form, or to all of a workspace's forms. */
  uploadBytesSince?(by: { clientHash: string } | { formId: string } | { workspaceId: string }, sinceIso: string): Promise<number>
  /** Store a stored row's files as its attachments: how many were stored and how many failed. May throw (every file failed). */
  storeFiles?(form: DataForm, rowId: string, files: readonly CheckedFile[]): Promise<{ stored: number; failed: number }>
  /** After a row is stored: its loops and the maker's inbox event. */
  afterStored?(form: DataForm, rowId: string): Promise<void>
  now?: () => number
  newId?: () => string
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
  return response
}

/**
 * The CORS headers a form answers `origin` with: none for a `members` or an
 * `invited` form (its own page only), else the intake's, for its GETs too. Pure.
 */
export function formCorsHeaders(origin: string | null, form: Pick<DataForm, 'access' | 'allowedOrigins'> | null): Record<string, string> {
  if (form && form.access !== 'public') return { Vary: 'Origin' }
  const headers = corsHeaders(origin, form)
  if (headers['Access-Control-Allow-Methods']) headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
  return headers
}

/**
 * Whether a browser from `origin` may use this form: its own page (the
 * app's origin) always; for a public form, a listed site, or any when none
 * are listed. Pure.
 */
export function formOriginAllowed(request: Request, origin: string | null, form: Pick<DataForm, 'access' | 'allowedOrigins'>): boolean {
  if (sameSite(request, origin)) return true
  return form.access === 'public' && originAllowed(origin, form)
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

/** Answer one submission (see the header): steps 1 to 4's room here, the rest in takeSubmission. */
export async function handleFormSubmit(request: Request, rawKey: string, deps: FormSubmitDeps): Promise<Response> {
  const origin = request.headers.get('origin')
  const unavailable = () => serverError('Could not take this right now.')
  // A personal link's secret names its form, and is the link this post claims.
  const linkInvite = isInviteTokenShape(rawKey) ? rawKey : null
  let form: DataForm | null
  try {
    form = linkInvite ? ((await deps.formOfInvite?.(linkInvite)) ?? null) : await deps.findForm(rawKey)
  } catch (err) {
    console.error('[form-intake] form lookup failed:', err instanceof Error ? err.message : String(err))
    return withHeaders(unavailable(), formCorsHeaders(origin, null))
  }
  if (!form) return withHeaders(notFound('Not found'), formCorsHeaders(origin, null))
  const cors = formCorsHeaders(origin, form)
  if (!form.active) return withHeaders(apiError('This form is closed.', { status: 410, code: 'FORM_CLOSED' }), cors)

  if (form.access !== 'public' && !sameSite(request, origin)) {
    // A member's session rides the request, and a personal link is its own page's: only the app's own pages may send either.
    return withHeaders(forbidden('This form is filled in from its own page.'), cors)
  }
  if (form.access === 'members') {
    let who: Awaited<ReturnType<FormSubmitDeps['memberOf']>>
    try {
      who = await deps.memberOf(request, form.workspaceId)
    } catch (err) {
      console.error('[form-intake] member check failed:', err instanceof Error ? err.message : String(err))
      return withHeaders(unavailable(), cors)
    }
    if (who === 'signed_out') return withHeaders(unauthorized('Sign in to fill in this form.'), cors)
    if (who !== 'member') return withHeaders(forbidden('This form is for members of its workspace.'), cors)
  } else if (!formOriginAllowed(request, origin, form)) {
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

  // An upload takes room by its declared length before a byte of it is read, and gives it back when this request ends.
  const filesField = filesFieldOf(form.fields)
  let room: UploadRoom | null = null
  if (filesField && isMultipart(request)) {
    const declared = declaredLength(request)
    if (declared === null) return withHeaders(apiError('Send the form with its length (Content-Length).', { status: 411, code: 'LENGTH_REQUIRED' }), cors)
    if (declared > FORM_UPLOAD_BODY_MAX) return withHeaders(apiError(BODY_TOO_LARGE_FILES, { status: 413, code: 'TOO_LARGE' }), cors)
    room = takeUploadRoom(declared, client)
    if (!room.ok) {
      const retry = { ...cors, 'Retry-After': String(UPLOAD_RETRY_AFTER_S) }
      if (room.reason === 'sender') {
        console.warn(`[form-intake] form=${form.id} sender has uploads in flight`)
        return withHeaders(rateLimited('You are already sending files. Try again in a moment.'), retry)
      }
      console.warn(`[form-intake] form=${form.id} ALERT no room for uploads in flight`)
      return withHeaders(apiError(UPLOAD_BUSY, { status: 503, code: 'BUSY' }), retry)
    }
  }
  try {
    return await takeSubmission({ request, form, deps, cors, client, attemptId, now, since, linkInvite, filesField })
  } finally {
    if (room?.ok) room.release()
  }
}

interface SubmissionContext {
  request: Request
  form: DataForm
  deps: FormSubmitDeps
  cors: Record<string, string>
  client: string | null
  attemptId: string
  now: number
  since: string
  linkInvite: string | null
  filesField: ReturnType<typeof filesFieldOf>
}

/** Steps 4 to 14 of the header, for a try the caps let through. */
async function takeSubmission(ctx: SubmissionContext): Promise<Response> {
  const { request, form, deps, cors, client, attemptId, now, since, linkInvite, filesField } = ctx
  const unavailable = () => serverError('Could not take this right now.')
  const read = await readFormSubmission(request, { files: !!filesField })
  if (!read.ok) return withHeaders(read.status === 413 ? apiError(read.error, { status: 413, code: 'TOO_LARGE' }) : badRequest(read.error), cors)
  const body = read.fields
  if (read.fileBytes > 0) {
    // Counted before anything else reads the post: a refused try's bytes count toward the byte caps too.
    try {
      if (!deps.recordUploadBytes) throw new Error('no byte ledger')
      await deps.recordUploadBytes(attemptId, read.fileBytes)
    } catch (err) {
      console.error('[form-intake] byte cap write failed:', err instanceof Error ? err.message : String(err))
      return withHeaders(unavailable(), cors)
    }
  }
  // The post's own fields, out before anything reads the form's.
  const own = Object.fromEntries(OWN_FIELDS.map((name) => [name, body[name]]))
  const posted = Object.fromEntries(Object.entries(body).filter(([name]) => !OWN_FIELDS.includes(name)))

  // The website flow's live check: through the key, the origin and the caps like a customer's post, never stored.
  const testNonce = own[INTAKE_TEST_FIELD]
  if (typeof testNonce === 'string' && deps.takeTest) {
    let took = false
    try {
      took = await deps.takeTest(form.workspaceId, testNonce)
    } catch (err) {
      console.error('[form-intake] test check failed:', err instanceof Error ? err.message : String(err))
    }
    if (took) {
      console.info(`[form-intake] form=${form.id} website check received`)
      return withHeaders(Response.json({ ok: true, test: true }, { status: 200 }), cors)
    }
  }

  let challengeId: string | null = null
  if (form.botCheck) {
    const checked = verifyChallenge({ formId: form.id, token: own[FORM_CHALLENGE_FIELD], answer: own[FORM_ANSWER_FIELD], now, secret: deps.challengeSecret?.() })
    if (!checked.ok) {
      console.warn(`[form-intake] form=${form.id} bot check refused (${checked.reason})`)
      return withHeaders(apiError(CHALLENGE_REFUSED, { status: 400, code: 'CHALLENGE_FAILED' }), cors)
    }
    challengeId = checked.id
  }

  // An invited form takes nothing without a personal link: the path's, or the post's own.
  const inviteToken = form.access === 'invited' ? (linkInvite ?? (isInviteTokenShape(own[FORM_INVITE_FIELD]) ? (own[FORM_INVITE_FIELD] as string) : null)) : null
  if (form.access === 'invited' && (!inviteToken || !deps.claimInvite)) return withHeaders(apiError(INVITE_REFUSED, { status: 403, code: 'INVITE_USED' }), cors)

  let columns: DataColumn[] | null
  try {
    columns = await deps.columns(form)
  } catch (err) {
    console.error('[form-intake] columns read failed:', err instanceof Error ? err.message : String(err))
    return withHeaders(unavailable(), cors)
  }
  if (!columns) return withHeaders(apiError('This form is closed.', { status: 410, code: 'FORM_CLOSED' }), cors)

  const redirect = form.access === 'public' ? safeRedirect(own[FORM_REDIRECT_FIELD], form) : null
  const done = (id: string, status: 200 | 201) => {
    if (redirect) return withHeaders(new Response(null, { status: 303, headers: { Location: redirect } }), cors)
    return withHeaders(Response.json({ ok: true, id, ...(form.thanks ? { thanks: form.thanks } : {}) }, { status }), cors)
  }
  const newId = deps.newId ?? randomUUID
  /** Whether a row is in the table: 'unknown' when the look fails. Without the look, not. */
  const rowStored = async (id: string): Promise<'yes' | 'no' | 'unknown'> => {
    if (!deps.rowExists) return 'no'
    try {
      return (await deps.rowExists(form, id)) ? 'yes' : 'no'
    } catch (err) {
      console.error(`[form-intake] form=${form.id} row look failed:`, err instanceof Error ? err.message : String(err))
      return 'unknown'
    }
  }

  const parsed = parseSubmission(form.fields, columns, posted)
  if (!parsed.ok) {
    // A bot filled the honeypot: answered exactly as if stored, so it learns nothing.
    if (parsed.reason === 'bot') return done(newId(), 201)
    return withHeaders(badRequest(parsed.error), cors)
  }
  const submission = parsed.submission

  // The files, when the form takes them: checked whole before anything is made, then the byte caps.
  let files: CheckedFile[] = []
  if (filesField) {
    const checked = checkFormFiles(filesField, read.files)
    if (!checked.ok) return withHeaders(badRequest(checked.error), cors)
    files = checked.files
    if (files.length) {
      try {
        if (!deps.uploadBytesSince || !deps.storeFiles) throw new Error('no file store')
        if (client && (await deps.uploadBytesSince({ clientHash: client }, since)) > FORM_FILE_LIMITS.clientBytesPerHour) {
          console.warn(`[form-intake] form=${form.id} sender byte cap reached`)
          return withHeaders(rateLimited('Too many files from you right now. Try again in a little while.'), cors)
        }
        if ((await deps.uploadBytesSince({ formId: form.id }, since)) > FORM_FILE_LIMITS.formBytesPerHour) {
          console.warn(`[form-intake] form=${form.id} ALERT hourly byte cap reached`)
          return withHeaders(rateLimited('This form is busy right now. Try again in a little while.'), cors)
        }
        if ((await deps.uploadBytesSince({ workspaceId: form.workspaceId }, new Date(now - DAY_MS).toISOString())) > FORM_FILE_LIMITS.workspaceBytesPerDay) {
          console.warn(`[form-intake] form=${form.id} ALERT the workspace's daily byte quota reached`)
          return withHeaders(rateLimited('This form is busy right now. Try again in a little while.'), cors)
        }
      } catch (err) {
        console.error('[form-intake] byte cap check failed:', err instanceof Error ? err.message : String(err))
        return withHeaders(unavailable(), cors)
      }
    }
  }

  const rowId = newId()
  let claimed: ClaimedAttempt
  try {
    claimed = await deps.claimAttempt({ attemptId, formId: form.id, clientHash: client, externalId: submission.externalId, rowId, challengeId })
  } catch (err) {
    console.error('[form-intake] attempt write failed:', err instanceof Error ? err.message : String(err))
    return withHeaders(unavailable(), cors)
  }
  if (claimed.kind === 'repeat') {
    if (claimed.rowId) return done(claimed.rowId, 200)
    // Its first post's row may be there with the try never marked stored: then it is stored, and this is answered with it.
    if (claimed.unstoredRowId && (await rowStored(claimed.unstoredRowId)) === 'yes') return done(claimed.unstoredRowId, 200)
    // The first post of this submission is still being stored (or failed a moment ago): never "stored" on its word.
    return withHeaders(apiError('That submission is already being sent. Try again in a moment.', { status: 409, code: 'SUBMISSION_IN_FLIGHT' }), cors)
  }
  if (claimed.kind === 'challenge_used') {
    console.warn(`[form-intake] form=${form.id} bot check refused (used)`)
    return withHeaders(apiError(CHALLENGE_REFUSED, { status: 400, code: 'CHALLENGE_FAILED' }), cors)
  }

  // The personal link, claimed for this submission alone: of two posts side by side, one gets it.
  let invite: FormInvite | null = null
  if (inviteToken && deps.claimInvite) {
    try {
      invite = await deps.claimInvite(form.id, inviteToken, new Date(now).toISOString())
    } catch (err) {
      console.error('[form-intake] invite claim failed:', err instanceof Error ? err.message : String(err))
      await deps.releaseAttempt(attemptId)
      return withHeaders(unavailable(), cors)
    }
    if (!invite) {
      await deps.releaseAttempt(attemptId)
      console.warn(`[form-intake] form=${form.id} personal link refused`)
      return withHeaders(apiError(INVITE_REFUSED, { status: 403, code: 'INVITE_USED' }), cors)
    }
  }
  /** Give back what this try took: its submission id and challenge, and its personal link. */
  const letGo = async () => {
    await deps.releaseAttempt(attemptId)
    if (invite) await deps.releaseInvite?.(invite.id)
  }

  // Before anything is made: the form's maker must still be able to change the table.
  let writable = false
  try {
    writable = await deps.canWrite(form)
  } catch (err) {
    console.error('[form-intake] maker check failed:', err instanceof Error ? err.message : String(err))
  }
  if (!writable) {
    await letGo()
    console.error(`[form-intake] form=${form.id} ALERT its maker can no longer change the table: nothing stored`)
    return withHeaders(unavailable(), cors)
  }

  let values: Record<string, CustomFieldValue> = { ...submission.values }
  let linked: string | null = null
  let settleContact: (() => Promise<void>) | null = null
  const column = contactColumnOf(columns)
  if (invite?.contactId) {
    // The person the link was made for: never one found or made from what was typed.
    if (column) {
      values[column.key] = [invite.contactId]
      linked = column.key
    }
  } else if (submission.contact) {
    try {
      const found = await deps.upsertContact(form, submission.contact)
      const contact = typeof found === 'string' ? { id: found } : found
      if (contact) {
        settleContact = contact.settle ?? null
        if (column) {
          values[column.key] = [contact.id]
          linked = column.key
        }
      }
    } catch (err) {
      console.warn(`[form-intake] form=${form.id} contact skipped:`, err instanceof Error ? err.message : String(err))
    }
  }

  // A pipeline's deal: the first open stage and the maker as owner, whatever was posted.
  if (pipelineStageColumn(columns)) {
    let owner: string | null = null
    if (hasPipelineOwner(columns) && deps.makerMemberId) {
      try {
        owner = await deps.makerMemberId(form)
      } catch (err) {
        console.warn(`[form-intake] form=${form.id} owner skipped:`, err instanceof Error ? err.message : String(err))
      }
    }
    values = formDealValues(columns, values, owner)
  }

  const write = async (rowValues: Record<string, CustomFieldValue>): Promise<FormWriteResult> => {
    try {
      return await deps.writeRow(form, { id: rowId, title: submission.title, values: rowValues })
    } catch (err) {
      return { ok: false, reason: 'unavailable', error: err instanceof Error ? err.message : String(err) }
    }
  }
  let written = await write(values)
  if (!written.ok && written.reason === 'invalid' && linked) {
    // The table refused the row: the contact may be one the form's maker can't see (someone's private contact). Kept without the link.
    const { [linked]: _dropped, ...unlinked } = values
    console.warn(`[form-intake] form=${form.id} contact link refused, stored without it`)
    written = await write(unlinked)
  }
  if (!written.ok) {
    // A refusal stored nothing; any other failure may have been stored before its answer was lost, so the row is looked for first.
    const there = written.reason === 'invalid' ? 'no' : await rowStored(rowId)
    if (there === 'unknown') {
      // Can't tell: nothing given back, so a resend can't make a second row on a single-use link.
      console.error(`[form-intake] form=${form.id} row=${rowId} ALERT write unclear and the row can't be looked for: its submission id, challenge and link stay taken (${written.reason}): ${written.error}`)
      return withHeaders(unavailable(), cors)
    }
    if (there === 'no') {
      await letGo()
      // Why the table refused is the workspace's own business: never told to the sender.
      console.error(`[form-intake] form=${form.id} ALERT submission not stored (${written.reason}): ${written.error}`)
      return withHeaders(written.reason === 'invalid' ? badRequest("This form can't take that right now.") : unavailable(), cors)
    }
    console.warn(`[form-intake] form=${form.id} row=${rowId} write answered ${written.reason}, but the row is there: stored`)
  }
  // The row exists: its files now. One that can't be stored is left out, never the row (see the header).
  if (files.length && deps.storeFiles) {
    try {
      const kept = await deps.storeFiles(form, rowId, files)
      if (kept.failed) console.error(`[form-intake] form=${form.id} row=${rowId} ALERT ${kept.failed} of ${files.length} files not stored`)
    } catch (err) {
      console.error(`[form-intake] form=${form.id} row=${rowId} ALERT files not stored:`, err instanceof Error ? err.message : String(err))
    }
  }
  // The files are views into the one body buffer (./body.ts): let go of them all, so it is freed before the follow-ups below.
  files = []
  read.files.length = 0
  await deps.markStored(attemptId, form.id)
  if (invite) await deps.markInviteStored?.(invite.id, rowId)
  console.info(`[form-intake] form=${form.id} row=${rowId} stored`)
  // What a stored submission starts: the contact's held-back change and loops, then the table's record_created loops and the maker's inbox. Never loses the answer.
  if (settleContact) {
    try {
      await settleContact()
    } catch (err) {
      console.warn(`[form-intake] form=${form.id} contact follow-up failed:`, err instanceof Error ? err.message : String(err))
    }
  }
  try {
    await deps.afterStored?.(form, rowId)
  } catch (err) {
    console.error(`[form-intake] form=${form.id} follow-ups failed:`, err instanceof Error ? err.message : String(err))
  }
  return done(rowId, 201)
}
