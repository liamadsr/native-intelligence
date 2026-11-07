/**
 * The account a text sign-up makes (./signup.ts step 3), once the person
 * texted back the right code:
 *
 *   1. the auth user, by phone (confirmed: the code just proved it), with a
 *      placeholder name the handle_new_user trigger needs to build the
 *      workspace and owner row (the agent learns the real names during
 *      setup, src/lib/onboarding/text-setup.ts). `app_metadata.signup_via`
 *      is 'sms'. A number an older account still carries on its auth row
 *      (it unlinked the number, the number moved to someone else, or it is
 *      only that account's business line) is freed from that account first
 *      (migrations 457 and 464 release_signup_number):
 *      numbers get recycled, so the person who proved the number gets a
 *      fresh account, never someone else's. A phone-only account (no email:
 *      ./business-line.ts accountEmail) has no other way in once its number
 *      is gone, so its connections (mail, calendar) are switched off rather
 *      than left syncing for nobody. An account with an email still has a
 *      way in, so its connections stay;
 *   2. the workspace is named "My business" until setup renames it, and
 *      takes the service-business edition (adoptBusinessEdition), so the app
 *      and the agent say the owner's words: jobs, customers, calls;
 *   3. the number is linked and verified on user_phone, on the Dial8 line,
 *      with the sign-up words' consent version (alert texts on: consent.ts),
 *      and any other row for the number is removed, business lines too (a
 *      sign-up runs only for a number with no Dial8-line holder, and the code
 *      just proved who holds the phone now: privacy first);
 *   4. the member row skips the web wizard (onboarding_completed_at) and
 *      carries `onboarding_progress.text_signup`, which turns the setup by
 *      text on.
 *
 * A failure after the user exists removes it again (best-effort), so the
 * person's next code starts clean.
 *
 * The welcome (welcomeNewAccount) is written into their home thread and is
 * the webhook's reply: it carries the single-use "connect your Google
 * account" link (src/lib/links/oauth-link.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { appendHomeMessage } from '@/lib/chat/home-message-writer'
import { SMS_CHANNEL } from '@/lib/chat/channel-turn'
import { mintConnectLink } from '@/lib/links/oauth-link'
import { adoptBusinessEdition } from '@/lib/editions/resolve'
import { SMS_TEXT_SIGNUP_CONSENT_VERSION, consentCoversAlerts } from './consent'
import { accountEmail } from './business-line'

/** The name the auth trigger builds the workspace and owner row with, until setup learns theirs. */
export const SIGNUP_PLACEHOLDER_NAME = 'Owner'
/** The workspace's name until setup learns the business's. */
export const SIGNUP_WORKSPACE_NAME = 'My business'

/** An account a text sign-up made. */
export interface PhoneAccount {
  userId: string
  workspaceId: string
  phone: string
}

export type CreatePhoneAccountResult = { ok: true; account: PhoneAccount } | { ok: false; error: string }

/** Make the account for a number that just proved itself with a code. Never throws. */
export async function createPhoneAccount(supabase: SupabaseClient, args: { phone: string; nowMs: number }): Promise<CreatePhoneAccountResult> {
  const { phone } = args
  const at = new Date(args.nowMs).toISOString()
  let userId: string | null = null
  try {
    const create = () =>
      supabase.auth.admin.createUser({
        phone,
        phone_confirm: true,
        user_metadata: { full_name: SIGNUP_PLACEHOLDER_NAME },
        app_metadata: { signup_via: 'sms' },
      })
    let created = await create()
    if (created.error?.code === 'phone_exists') {
      // An older account's auth row still carries the number, but no verified
      // Dial8-line link does (else this text would have gone to that account's
      // agent; a business line is reached on a business's number only).
      const released = await supabase.rpc('release_signup_number', { p_phone: phone })
      if (released.error) return { ok: false, error: `release failed: ${released.error.message}` }
      const releasedIds = Array.isArray(released.data) ? (released.data as unknown[]).filter((id): id is string => typeof id === 'string') : []
      if (releasedIds.length) {
        const phoneOnly = await phoneOnlyAccounts(supabase, releasedIds)
        const { error: offError } = phoneOnly.length ? await supabase.from('connected_account').update({ is_enabled: false }).in('user_id', phoneOnly) : { error: null }
        console.info(
          `[sms-signup] released a number from ${releasedIds.length} older account(s); connections off for ${phoneOnly.length} phone-only: ${offError ? `failed (${offError.message})` : 'yes'}`,
        )
      }
      created = await create()
    }
    if (created.error || !created.data.user) return { ok: false, error: `create failed: ${created.error?.message ?? 'no user'}` }
    userId = created.data.user.id

    // The trigger made the workspace and the owner row.
    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('workspace_id')
      .eq('user_id', userId)
      .eq('role', 'owner')
      .limit(1)
      .maybeSingle<{ workspace_id: string }>()
    if (memberError || !member) throw new Error(`owner row missing: ${memberError?.message ?? 'none'}`)
    const workspaceId = member.workspace_id

    const { error: nameError } = await supabase.from('workspace').update({ name: SIGNUP_WORKSPACE_NAME }).eq('id', workspaceId)
    if (nameError) throw new Error(`workspace rename failed: ${nameError.message}`)
    // A business that serves customers (src/lib/editions/words.ts). Never
    // throws: a sign-up never fails on its words.
    await adoptBusinessEdition(supabase, workspaceId, 'signup')

    // One person per number: the code proved this person holds it (every other row goes, business lines too).
    const { error: releaseError } = await supabase.from('user_phone').delete().eq('phone_e164', phone).neq('user_id', userId)
    if (releaseError) throw new Error(`user_phone release failed: ${releaseError.message}`)
    const { error: linkError } = await supabase.from('user_phone').insert({
      user_id: userId,
      workspace_id: workspaceId,
      phone_e164: phone,
      line: 'dial8',
      verified_at: at,
      consented_at: at,
      consent_version: SMS_TEXT_SIGNUP_CONSENT_VERSION,
      ...(consentCoversAlerts(SMS_TEXT_SIGNUP_CONSENT_VERSION) ? { alerts_consented_at: at, alerts_consent_version: SMS_TEXT_SIGNUP_CONSENT_VERSION } : {}),
      updated_at: at,
    })
    if (linkError) throw new Error(`user_phone link failed: ${linkError.message}`)

    // Setup happens by text: no web wizard, and text_signup turns the setup section on.
    const { error: doneError } = await supabase.from('member').update({ onboarding_completed_at: at }).eq('user_id', userId).eq('workspace_id', workspaceId)
    if (doneError) throw new Error(`member update failed: ${doneError.message}`)
    const { error: progressError } = await supabase.rpc('merge_onboarding_progress', {
      p_workspace_id: workspaceId,
      p_patch: { text_signup: { started_at: at } },
      p_user_id: userId,
    })
    if (progressError) throw new Error(`progress write failed: ${progressError.message}`)

    return { ok: true, account: { userId, workspaceId, phone } }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    if (userId) await removeHalfMadeAccount(supabase, userId)
    return { ok: false, error }
  }
}

/**
 * The released accounts with no other way in: no email (a phone-only text
 * sign-up). One whose email can't be read is left alone (its connections
 * stay): switching them off is tidying, never worth a wrong guess.
 */
async function phoneOnlyAccounts(supabase: SupabaseClient, userIds: readonly string[]): Promise<string[]> {
  const out: string[] = []
  for (const userId of userIds) {
    try {
      if ((await accountEmail(supabase, userId)) === null) out.push(userId)
    } catch (err) {
      console.warn('[sms-signup] released account not checked, its connections stay:', err instanceof Error ? err.message : err)
    }
  }
  return out
}

/** Best-effort: the user (its member row and phone go with it) and the workspace it owned alone. */
async function removeHalfMadeAccount(supabase: SupabaseClient, userId: string): Promise<void> {
  try {
    const { data } = await supabase.from('member').select('workspace_id').eq('user_id', userId)
    await supabase.auth.admin.deleteUser(userId)
    for (const row of (data as Array<{ workspace_id: string }> | null) ?? []) {
      await supabase.from('workspace').delete().eq('id', row.workspace_id)
    }
  } catch {
    // Best-effort: a stray account is freed by the next sign-up's release.
  }
}

/** The welcome text (the reply to the right code). */
export function signupWelcomeText(connectUrl: string | null): string {
  const intro = "You're in! I'm your Dial8 agent. Text me like you'd text an assistant and I'll handle the busywork for your business."
  const connect = connectUrl
    ? ` First, connect your Google account so I can see your email and calendar: ${connectUrl} It opens Google's own sign-in and works once, for 15 minutes. I'll never ask for a password by text.`
    : ' First, text me "connect Google" and I\'ll send you a link to connect your email and calendar.'
  return `${intro}${connect} Reply STOP to opt out, HELP for help.`
}

/**
 * Write the welcome into the new account's home thread (the agent's own
 * words there, so the thread reads as it happened) and return it as the
 * reply. The Google link is minted for this account; if it can't be, the
 * welcome says how to ask for one. Never throws.
 */
export async function welcomeNewAccount(supabase: SupabaseClient, account: PhoneAccount, args: { origin: string; nowMs: number }): Promise<string> {
  let url: string | null = null
  try {
    const link = await mintConnectLink(supabase, { userId: account.userId, workspaceId: account.workspaceId, provider: 'google', origin: args.origin })
    url = link.ok ? link.url : null
    if (!link.ok) console.warn('[sms-signup] connect link not made:', link.error)
  } catch (err) {
    console.warn('[sms-signup] connect link not made:', err instanceof Error ? err.message : err)
  }
  const text = signupWelcomeText(url)
  await appendHomeMessage(supabase, {
    userId: account.userId,
    workspaceId: account.workspaceId,
    parts: [{ type: 'text', text }],
    messageId: `text-signup-welcome-${account.userId}`,
    metadata: { kind: 'text_signup_welcome', channel: SMS_CHANNEL },
  })
  return text
}
