/**
 * Which Dial8 account a verified ChatGPT sign-in belongs to, and the session
 * that signs it in (docs/plans/chatgpt-free-tier.md, phase 1).
 *
 * Resolution, in order:
 *   1. this ChatGPT account is already linked (chatgpt_connection, by
 *      issuer + subject)        → that person;
 *   2. its VERIFIED email is an existing, CONFIRMED Dial8 account → link it
 *      (the same trust Google sign-in gets: Supabase links verified emails).
 *      An account whose email was never confirmed is refused
 *      ('email_unconfirmed'): anyone can sign up with a password under an
 *      address they don't own, and linking would leave that password working.
 *      Resetting its password proves the address, then this links;
 *   3. otherwise               → a new account, email confirmed, named from the
 *      ID token. auth.admin.createUser doesn't run Supabase's
 *      before-user-created hook (Supabase auth admin.go never invokes it), so
 *      the work-email rule (migration 241) doesn't apply: a ChatGPT sign-up
 *      may use a personal address. That's the free tier's intent (Liam,
 *      10-20). The work_email_required mapping below stays, in case Supabase
 *      ever hooks admin creation.
 * An unverified or missing email never links or creates.
 *
 * The session: a magic-link token generated server-side (no email is sent),
 * redeemed with verifyOtp where the session must land: by the server client
 * for the web, or by the desktop webview from a dial8desktop:// deep link.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isWorkEmailRejection } from '@/lib/auth/work-email'
import { connectedUserId } from './connection'
import type { ChatGptIdentity } from './oidc'

export type ResolvedAccount =
  | { ok: true; userId: string; email: string; created: boolean }
  | { ok: false; error: 'unverified_email' | 'email_unconfirmed' | 'work_email_required' | 'account_failed' }

export async function resolveChatGptAccount(
  service: SupabaseClient,
  identity: ChatGptIdentity,
): Promise<ResolvedAccount> {
  const linked = await connectedUserId(service, identity.sub)
  if (linked) {
    const { data, error } = await service.auth.admin.getUserById(linked)
    if (!error && data.user?.email) return { ok: true, userId: linked, email: data.user.email, created: false }
    // A linked user without an email can't be signed in by magic link.
    return { ok: false, error: 'account_failed' }
  }

  if (!identity.email || !identity.emailVerified) return { ok: false, error: 'unverified_email' }

  const { data: existing, error: lookupError } = await service.rpc('chatgpt_user_id_by_email', {
    p_email: identity.email,
  })
  if (lookupError) return { ok: false, error: 'account_failed' }
  if (typeof existing === 'string' && existing) {
    return { ok: true, userId: existing, email: identity.email, created: false }
  }

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email: identity.email,
    email_confirm: true,
    user_metadata: identity.name ? { full_name: identity.name, name: identity.name } : {},
    app_metadata: { signup_via: 'chatgpt' },
  })
  if (createError || !created.user) {
    // The lookup only finds confirmed accounts, so an existing address here is an unconfirmed one.
    if (createError?.code === 'email_exists') return { ok: false, error: 'email_unconfirmed' }
    return { ok: false, error: isWorkEmailRejection(createError?.message) ? 'work_email_required' : 'account_failed' }
  }
  return { ok: true, userId: created.user.id, email: identity.email, created: true }
}

/** A one-time token that redeems to a session for this (existing) account. */
export async function sessionTokenHash(service: SupabaseClient, email: string): Promise<string | null> {
  const { data, error } = await service.auth.admin.generateLink({ type: 'magiclink', email })
  if (error) return null
  return data.properties?.hashed_token ?? null
}
