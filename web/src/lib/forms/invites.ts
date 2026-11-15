/**
 * Personal links to an invited form (forms phase 3, migration 661): each
 * stores ONE submission, then it is used. Rows of data_form_invite, read and
 * written by the service role only; a caller checks who is asking first.
 *
 * The secret is `fi_` and 32 random bytes, base64url, as a form's own key
 * (./store.ts): only its SHA-256 is stored, it is shown once when it is made.
 * A link is `<origin>/f/<secret>`: the form's own key is never stored, so a
 * personal link could not carry it, and needs not, since the secret names its
 * form.
 *
 * Who claims it: a submission, with one UPDATE ... WHERE used_at IS NULL AND
 * expires_at > now RETURNING (claimInvite), so two posts side by side store
 * one. A write that then fails gives it back (releaseInvite); a stored one is
 * marked with its row (markInviteStored).
 *
 * Server only.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formPageUrl } from './store'
import { FORM_INVITE_DAYS, FORM_LIMITS, type DataForm } from './types'

export const FORM_INVITE_PREFIX = 'fi_'
const TOKEN_SHAPE = /^fi_[A-Za-z0-9_-]{43}$/
const DAY_MS = 24 * 60 * 60_000

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function generateInviteToken(): string {
  return `${FORM_INVITE_PREFIX}${randomBytes(32).toString('base64url')}`
}

export function isInviteTokenShape(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_SHAPE.test(value)
}

export interface FormInvite {
  id: string
  formId: string
  label: string | null
  contactId: string | null
  createdBy: string | null
  createdAt: string
  expiresAt: string
  usedAt: string | null
  rowId: string | null
}

const INVITE_COLUMNS = 'id, form_id, label, contact_id, created_by, created_at, expires_at, used_at, row_id'

interface InviteRow {
  id: string
  form_id: string
  label: string | null
  contact_id: string | null
  created_by: string | null
  created_at: string
  expires_at: string
  used_at: string | null
  row_id: string | null
}

function toInvite(row: InviteRow): FormInvite {
  return {
    id: row.id,
    formId: row.form_id,
    label: row.label,
    contactId: row.contact_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    rowId: row.row_id,
  }
}

/** Whether an invite opens its form now: not used, not lapsed. Pure. */
export function inviteIsGood(invite: Pick<FormInvite, 'usedAt' | 'expiresAt'> | null, now: number): boolean {
  return !!invite && !invite.usedAt && Date.parse(invite.expiresAt) > now
}

/** Days a new link lasts: the default when not given, at least one, at most the most. Pure. */
export function inviteDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return FORM_INVITE_DAYS.default
  return Math.min(FORM_INVITE_DAYS.max, Math.max(1, Math.round(value)))
}

export interface InviteRequest {
  label: string | null
  contactId: string | null
}

export interface MadeInvite {
  id: string
  label: string | null
  contactId: string | null
  /** The personal link, shown once. */
  url: string
  expiresAt: string
}

/**
 * Make personal links to `form`, one per request, all in one insert. Answers
 * each with its link: shown once, never stored. The caller has checked the
 * asker may change the form, and that each contact is one they can see.
 */
export async function createInvites(
  supabase: SupabaseClient,
  form: Pick<DataForm, 'id'>,
  requests: readonly InviteRequest[],
  opts: { userId: string; origin: string; expiresInDays?: number; now?: number },
): Promise<MadeInvite[]> {
  if (!requests.length) return []
  if (requests.length > FORM_LIMITS.invitesPerCall) throw new Error(`at most ${FORM_LIMITS.invitesPerCall} invites at once`)
  const expiresAt = new Date((opts.now ?? Date.now()) + inviteDays(opts.expiresInDays) * DAY_MS).toISOString()
  const tokens = requests.map(() => generateInviteToken())
  const { data, error } = await supabase
    .from('data_form_invite')
    .insert(
      requests.map((r, i) => ({
        form_id: form.id,
        token_hash: hashInviteToken(tokens[i]),
        label: r.label,
        contact_id: r.contactId,
        created_by: opts.userId,
        expires_at: expiresAt,
      })),
    )
    .select('id, token_hash, label, contact_id, expires_at')
  if (error || !data) throw new Error(`data_form_invite insert failed: ${error?.message ?? 'no rows'}`)
  const byHash = new Map((data as Array<{ id: string; token_hash: string; label: string | null; contact_id: string | null; expires_at: string }>).map((r) => [r.token_hash, r]))
  return tokens.map((token) => {
    const row = byHash.get(hashInviteToken(token))
    if (!row) throw new Error('data_form_invite insert failed: a row is missing')
    return { id: row.id, label: row.label, contactId: row.contact_id, url: formPageUrl(opts.origin, token), expiresAt: row.expires_at }
  })
}

/** The invite this secret is, whatever its state, or null (a wrong or malformed one). */
export async function findInviteByToken(supabase: SupabaseClient, token: string): Promise<FormInvite | null> {
  if (!isInviteTokenShape(token)) return null
  const { data, error } = await supabase.from('data_form_invite').select(INVITE_COLUMNS).eq('token_hash', hashInviteToken(token)).maybeSingle<InviteRow>()
  if (error) throw new Error(`data_form_invite read failed: ${error.message}`)
  return data ? toInvite(data) : null
}

/** The invite this secret is for this form, whatever its state, or null. */
export async function findInvite(supabase: SupabaseClient, formId: string, token: string): Promise<FormInvite | null> {
  const invite = await findInviteByToken(supabase, token)
  return invite && invite.formId === formId ? invite : null
}

/**
 * Claim the invite for one submission: it must be this form's, unused and
 * not lapsed. One UPDATE decides, so of two posts side by side one gets it.
 * Null when it is not there or not good.
 */
export async function claimInvite(supabase: SupabaseClient, formId: string, token: string, nowIso: string): Promise<FormInvite | null> {
  if (!isInviteTokenShape(token)) return null
  const { data, error } = await supabase
    .from('data_form_invite')
    .update({ used_at: nowIso })
    .eq('form_id', formId)
    .eq('token_hash', hashInviteToken(token))
    .is('used_at', null)
    .gt('expires_at', nowIso)
    .select(INVITE_COLUMNS)
    .maybeSingle<InviteRow>()
  if (error) throw new Error(`data_form_invite claim failed: ${error.message}`)
  return data ? toInvite(data) : null
}

/** The claimed submission was stored as this row. Best effort (the row is stored either way, and the invite stays used). */
export async function markInviteStored(supabase: SupabaseClient, inviteId: string, rowId: string): Promise<void> {
  try {
    await supabase.from('data_form_invite').update({ row_id: rowId }).eq('id', inviteId)
  } catch {
    // Best effort.
  }
}

/** The claimed submission could not be stored: the link works again. Best effort. */
export async function releaseInvite(supabase: SupabaseClient, inviteId: string): Promise<void> {
  try {
    await supabase.from('data_form_invite').update({ used_at: null }).eq('id', inviteId).is('row_id', null)
  } catch {
    // Best effort.
  }
}

/** Invites used, or lapsed, before `beforeIso`: nothing reads them any more. */
export async function deleteOldFormInvites(supabase: SupabaseClient, beforeIso: string): Promise<void> {
  const used = await supabase.from('data_form_invite').delete().lt('used_at', beforeIso)
  if (used.error) throw new Error(`data_form_invite delete failed: ${used.error.message}`)
  const lapsed = await supabase.from('data_form_invite').delete().lt('expires_at', beforeIso)
  if (lapsed.error) throw new Error(`data_form_invite delete failed: ${lapsed.error.message}`)
}
