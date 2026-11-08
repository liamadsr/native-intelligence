import type { SupabaseClient } from '@supabase/supabase-js'
import { getResend, BASE_URL, FROM_EMAIL } from '@/lib/email'

/**
 * Admin-issued signup invites — the allow-list that lets a named address
 * create a Native Intelligence account even when the work-email gate (migration 241) would
 * refuse its domain. Rows live in `public.signup_invite` (migration 242) and
 * are only ever written through the admin console with a service-role client.
 *
 * The invite email links to `/login?invite=<token>`; the login page resolves
 * the token server-side (see `resolveSignupInvite`) so the address itself is
 * never carried in a URL.
 */

export const SIGNUP_INVITE_DAYS = 30

export interface SignupInviteRow {
  id: string
  email: string
  token: string
  invited_by: string | null
  note: string | null
  /** May bypass the card-backed trial (comp seat) — false = email gate only. */
  skip_payment: boolean
  expires_at: string
  used_at: string | null
  used_by: string | null
  created_at: string
  updated_at: string
}

export type SignupInviteStatus = 'pending' | 'used' | 'expired'

export function signupInviteStatus(
  row: Pick<SignupInviteRow, 'used_at' | 'expires_at'>,
  now: Date = new Date(),
): SignupInviteStatus {
  if (row.used_at) return 'used'
  if (new Date(row.expires_at) <= now) return 'expired'
  return 'pending'
}

/** Lower-cased, trimmed, minimally shaped — or null when it is not an address. */
export function normalizeInviteEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const email = input.trim().toLowerCase()
  if (email.length < 3 || email.length > 254) return null
  const at = email.lastIndexOf('@')
  if (at < 1 || at === email.length - 1) return null
  if (!email.slice(at + 1).includes('.')) return null
  if (/\s/.test(email)) return null
  return email
}

export function signupInviteUrl(token: string): string {
  return `${BASE_URL}/login?invite=${encodeURIComponent(token)}`
}

/**
 * Create the invite, or refresh an existing one for the same address (new
 * expiry, new note, unused again if it had lapsed). A row that was already
 * USED is left alone — the person has an account; re-inviting is a no-op
 * that reports `already_used`.
 */
export async function upsertSignupInvite(
  supabase: SupabaseClient,
  params: { email: string; invitedBy: string | null; note: string | null; skipPayment: boolean },
): Promise<
  | { ok: true; invite: SignupInviteRow; refreshed: boolean }
  | { ok: false; reason: 'already_used'; invite: SignupInviteRow }
  | { ok: false; reason: 'db_error'; message: string }
> {
  const { data: existing, error: lookupError } = await supabase
    .from('signup_invite')
    .select('*')
    .eq('email', params.email)
    .maybeSingle()
  if (lookupError) return { ok: false, reason: 'db_error', message: lookupError.message }

  if (existing?.used_at) {
    return { ok: false, reason: 'already_used', invite: existing as SignupInviteRow }
  }

  const expiresAt = new Date(Date.now() + SIGNUP_INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString()

  if (existing) {
    const { data, error } = await supabase
      .from('signup_invite')
      .update({
        expires_at: expiresAt,
        note: params.note,
        invited_by: params.invitedBy,
        skip_payment: params.skipPayment,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select('*')
      .single()
    if (error || !data) return { ok: false, reason: 'db_error', message: error?.message ?? 'update failed' }
    return { ok: true, invite: data as SignupInviteRow, refreshed: true }
  }

  const { data, error } = await supabase
    .from('signup_invite')
    .insert({
      email: params.email,
      invited_by: params.invitedBy,
      note: params.note,
      skip_payment: params.skipPayment,
      expires_at: expiresAt,
    })
    .select('*')
    .single()
  if (error || !data) return { ok: false, reason: 'db_error', message: error?.message ?? 'insert failed' }
  return { ok: true, invite: data as SignupInviteRow, refreshed: false }
}

export function renderSignupInviteEmail(
  invite: Pick<SignupInviteRow, 'token' | 'note'> & Partial<Pick<SignupInviteRow, 'skip_payment'>>,
): {
  subject: string
  html: string
} {
  const url = signupInviteUrl(invite.token)
  const note = invite.note?.trim()
  const skip = invite.skip_payment !== false
  return {
    subject: "You're invited to Native Intelligence",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="margin: 0 0 16px;">You're invited to Native Intelligence</h2>
        <p style="color: #555; line-height: 1.6;">
          Create your account with the link below — it's tied to this email address.${
            skip ? ' No card needed.' : ' You\'ll start a 7-day free trial.'
          }
        </p>
        ${note ? `<p style="color: #555; line-height: 1.6; border-left: 3px solid #ddd; padding-left: 12px; white-space: pre-wrap;">${escapeHtml(note)}</p>` : ''}
        <a href="${url}" style="display: inline-block; margin: 24px 0; padding: 12px 24px; background: #000; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">
          Create your account
        </a>
        <p style="color: #888; font-size: 13px; line-height: 1.5;">
          This invite expires in ${SIGNUP_INVITE_DAYS} days. If you didn't expect this email, you can ignore it.
        </p>
      </div>
    `,
  }
}

export async function sendSignupInviteEmail(
  invite: Pick<SignupInviteRow, 'email' | 'token' | 'note'> & Partial<Pick<SignupInviteRow, 'skip_payment'>>,
) {
  const { subject, html } = renderSignupInviteEmail(invite)
  const { error } = await getResend().emails.send({
    from: FROM_EMAIL,
    to: invite.email,
    subject,
    html,
  })
  if (error) throw new Error(error.message)
}

/**
 * The signup invite that entitles this user to skip the card, if any: the
 * row stamped with their id at signup, OR a still-pending row addressed to
 * their email. The second case matters for accounts that EXISTED before the
 * invite was sent — signing in then is not a signup, so the auth.users
 * trigger never stamps `used_by`, yet the person was invited all the same.
 * Service role only (the table has no policies).
 */
export async function findSignupInviteForUser(
  supabase: SupabaseClient,
  user: { id: string; email?: string | null },
): Promise<{ id: string; email: string; used_by: string | null; skip_payment: boolean } | null> {
  const { data: byId } = await supabase
    .from('signup_invite')
    .select('id, email, used_by, skip_payment')
    .eq('used_by', user.id)
    .limit(1)
    .maybeSingle()
  if (byId) return byId
  const email = normalizeInviteEmail(user.email)
  if (!email) return null
  const { data: byEmail } = await supabase
    .from('signup_invite')
    .select('id, email, used_by, skip_payment')
    .eq('email', email)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .limit(1)
    .maybeSingle()
  return byEmail ?? null
}

/**
 * Resolve an invite token from a `/login?invite=` link to the address it was
 * issued for, or null when it is unknown, used, or expired. Read-only, service
 * role: the page calling this is public and RLS would show it nothing.
 */
export async function resolveSignupInvite(
  supabase: SupabaseClient,
  token: string | null | undefined,
): Promise<{ email: string } | null> {
  if (!token || typeof token !== 'string' || !/^[a-f0-9]{16,128}$/.test(token)) return null
  const { data } = await supabase
    .from('signup_invite')
    .select('email, used_at, expires_at')
    .eq('token', token)
    .maybeSingle()
  if (!data || signupInviteStatus(data) !== 'pending') return null
  return { email: data.email }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
