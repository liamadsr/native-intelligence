/**
 * A form's public side (forms phase 3): what a page needs to draw it, who may
 * open it, and the two reads a page makes before it posts.
 *
 *   formShape        the form as a page draws it: its name, description,
 *                    button, thank-you line, whether it asks for the bot
 *                    check, who may submit, and its fields (the name each is
 *                    posted as, its label, its column's type, whether it is
 *                    required, a select's options; a files field as type
 *                    'file' with the limits the server keeps: max_files,
 *                    max_bytes, accept). Nothing else: never the table's
 *                    name or id, nothing of the workspace.
 *   openForm         a link (a form's key, or a personal link's secret) read
 *                    for whoever opened it: missing (a personal link's
 *                    secret is missing too once it is used or lapsed, or its
 *                    form no longer takes invited people: ./deps.ts),
 *                    closed, a members form for someone signed out or not a
 *                    member (a guest is not one), an invited form without a
 *                    good personal link, or open.
 *   handleFormRead   GET /api/intake/forms/<key> (the shape) and
 *                    GET /api/intake/forms/<key>/challenge (a fresh challenge,
 *                    ./challenge.ts). Each answers its form's CORS as the POST
 *                    does, 404 for a wrong key and 410 for a closed form, and
 *                    a members or invited form only to someone who may submit
 *                    from its own page. They write nothing: a challenge is
 *                    one HMAC and stored nowhere, so they take no ledger entry.
 *                    A sender (formClientKey, as the POST's caps count them)
 *                    makes at most FORM_READS_CLIENT_PER_MINUTE of them a
 *                    minute, across every form, counted in this process
 *                    before anything is read (429 past it): a ledger row per
 *                    read would make a read a write, and the app runs as one
 *                    web process on one server, so this process's count is
 *                    the sender's. It never touches the POST's caps.
 *
 * The page (src/app/f/) calls openForm and formShape itself; the embed
 * (public/f/embed.js) reads the GETs. Pure over {@link FormGateDeps}.
 */
import { apiError, forbidden, notFound, rateLimited, serverError, unauthorized } from '@/lib/api-errors'
import { customFieldKey } from '@/lib/crm/custom-fields'
import type { DataColumn } from '@/lib/tables/types'
import { issueChallenge } from './challenge'
import { postedNameOf } from './fields'
import { inviteIsGood, isInviteTokenShape, type FormInvite } from './invites'
import { isFormKeyShape } from './store'
import { formCorsHeaders, formOriginAllowed, INVITE_REFUSED, sameSite } from './submit'
import { FORM_FILE_ACCEPT, FORM_FILE_LIMITS, FORM_FILES_KEY, FORM_TITLE_KEY, isFormColumn, type DataForm, type FormAccess, type FormFieldType } from './types'

/** A text field whose key or label is one of these is a few lines, not one. */
const LONG_TEXT_SLUGS = new Set(['message', 'notes', 'details', 'comments', 'description', 'about'])

export interface PublicFormField {
  /** What the page posts it as. */
  name: string
  label: string
  /** The column's type; the row's name is text; the form's files are 'file'. */
  type: FormFieldType | 'file'
  required: boolean
  /** A select's or a multi-select's choices. */
  options?: string[]
  /** A text field drawn as a few lines (a message, notes). */
  long?: true
  /** A currency field's code. */
  currency?: string
  /** A files field: at most this many files, each at most max_bytes, of the kinds in accept (an input's accept). */
  max_files?: number
  max_bytes?: number
  accept?: string
}

export interface PublicFormShape {
  name: string
  description: string | null
  submit_label: string | null
  thanks?: string
  bot_check: boolean
  access: FormAccess
  fields: PublicFormField[]
}

/** The form as a page draws it (see the header). Fields whose column is gone or no longer a form's to fill are left out, as a submission skips them. Pure. */
export function formShape(form: DataForm, columns: readonly DataColumn[]): PublicFormShape {
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const fields: PublicFormField[] = []
  for (const f of form.fields) {
    if (f.key === FORM_FILES_KEY) {
      fields.push({ name: postedNameOf(f), label: f.label, type: 'file', required: f.required, max_files: FORM_FILE_LIMITS.maxFiles, max_bytes: FORM_FILE_LIMITS.maxBytes, accept: FORM_FILE_ACCEPT })
      continue
    }
    const col = f.key === FORM_TITLE_KEY ? null : byKey.get(f.key)
    if (f.key !== FORM_TITLE_KEY && (!col || !isFormColumn(col))) continue
    const type: FormFieldType = col ? (col.field_type as FormFieldType) : 'text'
    const long = type === 'text' && (LONG_TEXT_SLUGS.has(f.key) || LONG_TEXT_SLUGS.has(customFieldKey(f.label)))
    fields.push({
      name: postedNameOf(f),
      label: f.label,
      type,
      required: f.required,
      ...(col && (type === 'select' || type === 'multi_select') ? { options: [...(col.options ?? [])] } : {}),
      ...(long ? { long: true as const } : {}),
      ...(col && type === 'currency' ? { currency: col.config?.currency ?? 'USD' } : {}),
    })
  }
  return {
    name: form.name,
    description: form.description,
    submit_label: form.submitLabel,
    ...(form.thanks ? { thanks: form.thanks } : {}),
    bot_check: form.botCheck,
    access: form.access,
    fields,
  }
}

export type FormGate =
  | { kind: 'missing' }
  | { kind: 'closed'; form: DataForm }
  | { kind: 'signed_out'; form: DataForm }
  | { kind: 'not_member'; form: DataForm }
  /** An invited form without a good personal link: none, used, lapsed or another form's. */
  | { kind: 'invite_needed'; form: DataForm }
  /** `invite`: the personal link's secret this page posts with (an invited form only). */
  | { kind: 'open'; form: DataForm; columns: DataColumn[]; invite: string | null }

export interface FormGateDeps {
  findForm(key: string): Promise<DataForm | null>
  /** The form a personal link's secret opens: only while the link is good and the form is `invited`, else null. */
  formOfInvite(token: string): Promise<DataForm | null>
  /** The table's columns now, or null when the table is gone or archived. */
  columns(form: DataForm): Promise<DataColumn[] | null>
  /** Whoever opened it, for a members form: 'member' (never a guest), or why not. */
  memberOf(workspaceId: string): Promise<'member' | 'signed_out' | 'not_member'>
  /** The personal link this secret is for this form, whatever its state. */
  findInvite(formId: string, token: string): Promise<FormInvite | null>
  now?: () => number
}

/**
 * Read a link for whoever opened it (see the header). `link` is a form's key
 * or a personal link's secret; `invite` a personal link's secret given beside
 * a form's key (a page's `?i=`). Throws when a read fails.
 */
export async function openForm(link: string, invite: string | null, deps: FormGateDeps): Promise<FormGate> {
  const viaInvite = isInviteTokenShape(link)
  if (!viaInvite && !isFormKeyShape(link)) return { kind: 'missing' }
  const form = viaInvite ? await deps.formOfInvite(link) : await deps.findForm(link)
  if (!form) return { kind: 'missing' }
  if (!form.active) return { kind: 'closed', form }
  const columns = await deps.columns(form)
  if (!columns) return { kind: 'closed', form }
  if (form.access === 'members') {
    const who = await deps.memberOf(form.workspaceId)
    if (who !== 'member') return { kind: who, form }
    return { kind: 'open', form, columns, invite: null }
  }
  if (form.access === 'invited') {
    const token = viaInvite ? link : isInviteTokenShape(invite) ? invite : null
    const found = token ? await deps.findInvite(form.id, token) : null
    if (!token || !inviteIsGood(found, (deps.now ?? Date.now)())) return { kind: 'invite_needed', form }
    return { kind: 'open', form, columns, invite: token }
  }
  return { kind: 'open', form, columns, invite: null }
}

export interface FormReadDeps extends FormGateDeps {
  /** The bot check's key; the server's own when not given. */
  challengeSecret?(): string
  /** The sender, as the POST's caps key them (./client.ts formClientKey); null when the edge said nothing usable (then uncounted). */
  clientKey?(request: Request): string | null
}

/**
 * The shape and challenge reads one sender makes in a minute, across every
 * form. A page draws a form with two (its shape, a challenge) and a refused
 * challenge takes one more, so a person never comes near it; a script
 * polling the GETs does.
 */
export const FORM_READS_CLIENT_PER_MINUTE = 30
const MINUTE_MS = 60_000
/** Senders counted at most at once; past it the count starts over (a flood of senders is the edge's to stop). */
const FORM_READ_SENDERS_MAX = 5000

/** Each sender's reads this minute, in this process. */
const formReads = new Map<string, { since: number; count: number }>()

/** Test seam: forget the reads counted. */
export function __clearFormReadsForTests(): void {
  formReads.clear()
}

/** Whether this sender has read its fill this minute (counting this read). Pure but for the count. */
export function formReadLimited(client: string | null, now: number): boolean {
  if (!client) return false
  const seen = formReads.get(client)
  if (!seen || now - seen.since >= MINUTE_MS) {
    if (!seen && formReads.size >= FORM_READ_SENDERS_MAX) formReads.clear()
    formReads.set(client, { since: now, count: 1 })
    return false
  }
  seen.count++
  return seen.count > FORM_READS_CLIENT_PER_MINUTE
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
  response.headers.set('Cache-Control', 'no-store')
  return response
}

/** Answer GET …/<key> (`shape`) or GET …/<key>/challenge (`challenge`): see the header. */
export async function handleFormRead(request: Request, link: string, what: 'shape' | 'challenge', deps: FormReadDeps): Promise<Response> {
  const origin = request.headers.get('origin')
  // Counted before anything is read: a sender past its minute reads nothing.
  if (formReadLimited(deps.clientKey?.(request) ?? null, (deps.now ?? Date.now)())) {
    return withHeaders(rateLimited('Too many requests for this form just now. Try again in a minute.'), formCorsHeaders(origin, null))
  }
  const invite = new URL(request.url).searchParams.get('i')
  let gate: FormGate
  try {
    gate = await openForm(link, invite, deps)
  } catch (err) {
    console.error('[form-read] form lookup failed:', err instanceof Error ? err.message : String(err))
    return withHeaders(serverError('Could not open this form right now.'), formCorsHeaders(origin, null))
  }
  if (gate.kind === 'missing') return withHeaders(notFound('Not found'), formCorsHeaders(origin, null))
  const { form } = gate
  const cors = formCorsHeaders(origin, form)
  if (gate.kind === 'closed') return withHeaders(apiError('This form is closed.', { status: 410, code: 'FORM_CLOSED' }), cors)
  // A members or invited form is its own page's alone, as its POST is.
  if (form.access !== 'public' && !sameSite(request, origin)) return withHeaders(forbidden('This form is filled in from its own page.'), cors)
  if (!formOriginAllowed(request, origin, form)) return withHeaders(apiError('This site may not post to this form.', { status: 403, code: 'ORIGIN_REFUSED' }), cors)
  if (gate.kind === 'signed_out') return withHeaders(unauthorized('Sign in to fill in this form.'), cors)
  if (gate.kind === 'not_member') return withHeaders(forbidden('This form is for members of its workspace.'), cors)
  if (gate.kind === 'invite_needed') return withHeaders(apiError(INVITE_REFUSED, { status: 403, code: 'INVITE_USED' }), cors)
  if (what === 'challenge') return withHeaders(Response.json(issueChallenge(form.id, (deps.now ?? Date.now)(), deps.challengeSecret?.())), cors)
  return withHeaders(Response.json(formShape(form, gate.columns)), cors)
}
