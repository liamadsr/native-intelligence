/**
 * Connecting an account from a text (roadmap track A2): the agent texts a
 * single-use link (./one-time.ts, purpose 'oauth_connect') bound to the
 * account whose phone it goes to. Tapping it opens /l/<token>, whose button
 * starts the provider's own sign-in with no Dial8 session:
 *
 *   mint     {@link mintConnectLink}: a link for one provider; its payload is
 *            the capabilities to connect, in order (Google: email, then
 *            calendar), so one tap connects both.
 *   start    {@link startConnectFromLink}: the first leg's signed state, a
 *            web state bound by the oauth_nonce cookie the link's POST sets
 *            in the phone's browser, marked `via: 'text'` with the legs left.
 *   chain    after a leg connects, the callback starts the next with
 *            {@link nextConnectLeg} (a fresh state and nonce, the same
 *            browser, the account just used as the login hint).
 *   confirm  after each leg that connects, {@link confirmTextConnect}
 *            writes it into their home thread and texts it to their verified
 *            number: the first leg at once (so closing the calendar screen
 *            still tells them mail connected; during setup by text it asks
 *            for the website next, src/lib/onboarding/text-setup.ts), a later
 *            leg in one short line. A GitHub connect asks which repo is the
 *            business's website, as a numbered list (roadmap track E). The first leg also emails the connected
 *            address (see below).
 *
 * Never a password by text: the link only ever opens the provider's page.
 *
 * The one risk a link carries is being forwarded: whoever taps it connects
 * THEIR account to the link's Dial8 account (the web flow's binding can't
 * help: the browser that taps the link is, by design, the one that starts the
 * sign-in). So: a link is only ever texted to the account's verified number
 * by the server (the welcome, and connect_link on the person's own text
 * turn; the model, a web chat and MCP never see one), it works once, for 15
 * minutes, the page names the masked number it was sent to before the
 * button, and the connected address gets an email saying which Dial8
 * account it was connected to and how to remove the access.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { appendHomeMessage } from '@/lib/chat/home-message-writer'
import { SMS_CHANNEL } from '@/lib/chat/channel-turn'
import { emailDomain, isWorkEmail } from '@/lib/auth/work-email'
import { isValidCapability, type OAuthCapability, type OAuthProvider } from '@/lib/oauth/config'
import { buildOAuthStart, type OAuthStart } from '@/lib/oauth/authorize-url'
import type { OAuthStateData } from '@/lib/oauth/state'
import { linkedPhoneForUser, recordOutbound } from '@/lib/sms/store'
import { phoneServesWorkspace, sendingLine } from '@/lib/sms/workspace-line'
import { sendSms, type SendSmsResult } from '@/lib/twilio/client'
import { agentSender } from '@/lib/sms/agent-number'
import { maskPhone } from '@/lib/twilio/phone'
import { FROM_EMAIL, getResend } from '@/lib/email'
import { escapeHtml } from '@/lib/email/plain-text-to-html'
import { createOneTimeLink, type CreateLinkResult, type OneTimeLink } from './one-time'

/** The providers a texted link connects, and what each may connect, in order. */
export const TEXT_CONNECT_CAPABILITIES = {
  google: ['email', 'calendar', 'contacts'],
  microsoft: ['email', 'calendar'],
  github: ['github'],
  // Bringing existing customers in (roadmap track G): read-only, imported once on connect.
  hubspot: ['crm'],
  brevo: ['contacts'],
} as const satisfies Partial<Record<OAuthProvider, readonly OAuthCapability[]>>

export type TextConnectProvider = keyof typeof TEXT_CONNECT_CAPABILITIES
export const TEXT_CONNECT_PROVIDERS = Object.keys(TEXT_CONNECT_CAPABILITIES) as TextConnectProvider[]

/**
 * What a plain link for a provider connects. Google's contacts leg is only
 * ever asked for on its own (a `google_contacts` link): its scope waits on
 * Google's verification, and a sign-up's Google link must not stop on it.
 */
export const TEXT_CONNECT_DEFAULT: Record<TextConnectProvider, readonly OAuthCapability[]> = {
  google: ['email', 'calendar'],
  microsoft: ['email', 'calendar'],
  github: ['github'],
  hubspot: ['crm'],
  brevo: ['contacts'],
}

const PROVIDER_LABEL: Record<TextConnectProvider, string> = { google: 'Google', microsoft: 'Microsoft', github: 'GitHub', hubspot: 'HubSpot', brevo: 'Brevo' }
/** Where the owner of a connected account removes Dial8's access, on the provider's own site. */
const REVOKE_URL: Record<TextConnectProvider, string> = {
  google: 'https://myaccount.google.com/permissions',
  microsoft: 'https://account.live.com/consent/Manage',
  github: 'https://github.com/settings/applications',
  hubspot: 'https://app.hubspot.com/connected-apps',
  brevo: 'https://app.brevo.com/settings',
}
const CAPABILITY_LABEL: Partial<Record<OAuthCapability, string>> = { email: 'email', calendar: 'calendar', github: 'repositories', crm: 'contacts and companies', contacts: 'contacts' }

/** True when connecting a capability starts an import of the owner's people (src/lib/crm/import/). */
export function importsOnConnect(provider: string, capability: string): boolean {
  return ((provider === 'google' || provider === 'brevo') && capability === 'contacts') || (provider === 'hubspot' && capability === 'crm')
}

/** Where the phone's browser lands when the connect ends (src/app/l/done/page.tsx). */
export const TEXT_CONNECT_DONE_PATH = '/l/done'

export interface OAuthConnectPayload {
  provider: TextConnectProvider
  capabilities: OAuthCapability[]
}

export function isTextConnectProvider(value: unknown): value is TextConnectProvider {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TEXT_CONNECT_CAPABILITIES, value)
}

export function providerLabel(provider: string): string {
  return isTextConnectProvider(provider) ? PROVIDER_LABEL[provider] : provider
}

/** A link's payload, checked: the provider and its capabilities, in the provider's order. Null when it isn't one. */
export function parseOAuthConnectPayload(payload: Record<string, unknown>): OAuthConnectPayload | null {
  const provider = payload.provider
  if (!isTextConnectProvider(provider)) return null
  const allowed: readonly string[] = TEXT_CONNECT_CAPABILITIES[provider]
  const asked = Array.isArray(payload.capabilities) ? payload.capabilities : []
  const capabilities = allowed.filter((c): c is OAuthCapability => asked.includes(c) && isValidCapability(c))
  return capabilities.length ? { provider, capabilities } : null
}

/** A connect link for one provider, bound to this account. `capabilities`: a subset of the provider's (default: its plain link's). */
export async function mintConnectLink(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; provider: TextConnectProvider; origin: string; ttlMs?: number; capabilities?: readonly OAuthCapability[] },
): Promise<CreateLinkResult> {
  const allowed: readonly string[] = TEXT_CONNECT_CAPABILITIES[args.provider]
  const asked = (args.capabilities ?? TEXT_CONNECT_DEFAULT[args.provider]).filter((c) => allowed.includes(c))
  const payload: OAuthConnectPayload = { provider: args.provider, capabilities: allowed.filter((c): c is OAuthCapability => asked.includes(c as OAuthCapability)) as OAuthCapability[] }
  if (payload.capabilities.length === 0) return { ok: false, error: 'nothing to connect' }
  return createOneTimeLink(supabase, {
    purpose: 'oauth_connect',
    userId: args.userId,
    workspaceId: args.workspaceId,
    payload: { ...payload },
    origin: args.origin,
    ...(args.ttlMs ? { ttlMs: args.ttlMs } : {}),
  })
}

/** The first leg of a link's connect. */
export function startConnectFromLink(link: OneTimeLink): { ok: true; start: OAuthStart; provider: TextConnectProvider } | { ok: false; error: string } {
  const payload = parseOAuthConnectPayload(link.payload)
  if (!payload) return { ok: false, error: 'bad_link' }
  const [first, ...then] = payload.capabilities
  return {
    ok: true,
    provider: payload.provider,
    start: buildOAuthStart({
      provider: payload.provider,
      capability: first,
      userId: link.userId,
      workspaceId: link.workspaceId,
      source: 'web',
      returnTo: TEXT_CONNECT_DONE_PATH,
      text: { then, done: [] },
    }),
  }
}

/**
 * After a texted link's leg connected `capability`: the next leg's start, or
 * null when it was the last. Only for a provider a texted link connects.
 */
export function nextConnectLeg(state: OAuthStateData, provider: OAuthProvider, capability: OAuthCapability, accountEmail: string | null): OAuthStart | null {
  if (state.via !== 'text' || !state.userId || !isTextConnectProvider(provider)) return null
  const allowed: readonly string[] = TEXT_CONNECT_CAPABILITIES[provider]
  const [next, ...rest] = state.then.filter((c) => allowed.includes(c) && c !== capability && !state.done.includes(c))
  if (!next || !isValidCapability(next)) return null
  return buildOAuthStart({
    provider,
    capability: next,
    userId: state.userId,
    workspaceId: state.workspaceId,
    source: 'web',
    returnTo: TEXT_CONNECT_DONE_PATH,
    loginHint: accountEmail && accountEmail.includes('@') && !accountEmail.endsWith('@unknown') ? accountEmail : null,
    text: { then: rest.filter(isValidCapability), done: [...state.done.filter(isValidCapability), capability] },
  })
}

/** The text a connect link goes out in (connect_link). Pure. */
export function connectLinkText(provider: TextConnectProvider, url: string, capabilities?: readonly OAuthCapability[]): string {
  const name = PROVIDER_LABEL[provider]
  const what = capabilities?.length === 1 && capabilities[0] === 'contacts' ? `${name} Contacts` : `${name} account`
  const reads = (capabilities ?? TEXT_CONNECT_DEFAULT[provider]).every((c) => importsOnConnect(provider, c)) ? ' I only read them, to bring your contacts into Dial8.' : ''
  return `Connect your ${what}: ${url} It opens ${name}'s own sign-in and works once, for 15 minutes.${reads} I'll never ask for a password by text.`
}

/** The connected capabilities as words: "email and calendar". */
function capabilityWords(capabilities: readonly string[]): string {
  const words = capabilities.map((c) => CAPABILITY_LABEL[c as OAuthCapability] ?? c)
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/**
 * The text after a leg connects. The first leg says what connected (and what
 * is still to come on that page) and, during setup by text, asks for the
 * website next; a later leg is one short line. Pure.
 */
export function textConnectConfirmation(args: {
  provider: string
  capabilities: readonly string[]
  email: string | null
  inSetup: boolean
  first?: boolean
  pending?: readonly string[]
  failed?: boolean
  /** A GitHub connect: the owner's likeliest website repos, numbered in the text (roadmap track E). Empty: none they can change. */
  websiteRepos?: readonly string[] | null
}): string {
  const name = providerLabel(args.provider)
  const what = capabilityWords(args.capabilities)
  if (args.failed) return `${name} ${what ? `${what} ` : ''}didn't connect. Text me "connect ${name}" anytime for a new link.`
  // A contacts source: its first import has started (roadmap track G).
  const importing = args.capabilities.some((c) => importsOnConnect(args.provider, c))
    ? " I'm bringing your contacts into Dial8 now (read only, nothing is sent) and will text you a summary when it's done."
    : ''
  if (args.first === false) return `${name} ${what ? `${what} ` : ''}is connected too.${importing}`
  const account = args.email && !args.email.endsWith('@unknown') ? ` (${args.email})` : ''
  const pending = args.pending?.length ? ` ${capitalize(capabilityWords(args.pending))} is next on that page.` : ''
  const head = `${name} is connected${account}${what ? `: ${what}` : ''}.${pending}${importing}`
  // A GitHub connect (roadmap track E): which repo is their website, as a numbered short list they answer by text.
  if (args.provider === 'github' && args.websiteRepos) return `${head} ${websiteRepoQuestion(args.websiteRepos)}`
  // During setup, the website question follows a mail or calendar connect, not a contacts one.
  if (!args.inSetup || !args.capabilities.some((c) => c === 'email' || c === 'calendar')) return head
  const domain = isWorkEmail(args.email) ? emailDomain(args.email) : null
  return domain
    ? `${head} Is ${domain} your business's website? Reply yes, or send me the right one, and I'll read it and set up your business.`
    : `${head} What's your business's website? Send it and I'll read it and set up your business.`
}

/** "Which one is your website? 1) a 2) b … Reply with its number.", or what to do when there is none. Pure. */
export function websiteRepoQuestion(repos: readonly string[]): string {
  if (!repos.length) return "I don't see a repository your account can change. If a web designer keeps your site, they can give your GitHub account access, then text me."
  const list = repos.map((r, i) => `${i + 1}) ${r}`).join(' ')
  return `Which one is your website? ${list} Reply with its number, or its name if it isn't there.`
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

/** Seams for the tests. */
export interface ConfirmTextConnectDeps {
  send?: (to: string, body: string, deps?: { from?: string }) => Promise<SendSmsResult>
  /** A GitHub connect's website choices (default src/lib/website/repos.ts websiteRepoChoices). */
  websiteRepos?: (userId: string, workspaceId: string) => Promise<string[] | null>
  email?: (args: { to: string; provider: TextConnectProvider; maskedPhone: string | null }) => Promise<boolean>
}

/**
 * Tell the person, in their home thread and by text, that a texted link's
 * leg connected (`capabilities`: what this leg connected). `first` is the
 * flow's first leg: it says what is still to come (`pending`), asks for the
 * website during setup, and emails the connected address once. `messageKey`
 * makes the thread write idempotent (the leg's nonce). Texts only their
 * verified number that hasn't said STOP. The provider's address is never made
 * the account's sign-in email: a forwarded link would tie a stranger's
 * address to this account. Never throws.
 */
export async function confirmTextConnect(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; provider: string; capabilities: readonly string[]; email: string | null; messageKey: string; first: boolean; pending?: readonly string[]; failed?: boolean },
  deps: ConfirmTextConnectDeps = {},
): Promise<{ texted: boolean }> {
  try {
    const inSetup = args.first && (await inTextSetup(supabase, args.userId, args.workspaceId))
    // GitHub by text is a business's website (roadmap track E): ask which repo it is, as a numbered list.
    const websiteRepos =
      args.provider === 'github' && args.first && !args.failed
        ? await (deps.websiteRepos ?? (async (userId: string, workspaceId: string) => (await import('@/lib/website/repos')).websiteRepoChoices(supabase, userId, workspaceId)))(args.userId, args.workspaceId).catch(() => null)
        : null
    const text = textConnectConfirmation({ ...args, inSetup, websiteRepos })
    await appendHomeMessage(supabase, {
      userId: args.userId,
      workspaceId: args.workspaceId,
      parts: [{ type: 'text', text }],
      messageId: `text-connect-${args.messageKey}`,
      metadata: { kind: 'text_connect', channel: SMS_CHANNEL, provider: args.provider },
    })
    const phone = await linkedPhoneForUser(supabase, args.userId)
    if (args.first && !args.failed && args.email && isTextConnectProvider(args.provider)) {
      await (deps.email ?? sendConnectedNotice)({ to: args.email, provider: args.provider, maskedPhone: phone ? maskPhone(phone.phone) : null }).catch(() => false)
    }
    // Linked here, or one of this workspace's own people, texted from its business number (src/lib/sms/workspace-line.ts);
    // a business-line phone only ever from a business number ('no_line': none to send from). Else their agent's own number, else Dial8's.
    if (!phone || phone.optedOut || !(await phoneServesWorkspace(supabase, phone, args.workspaceId))) return { texted: false }
    const from = await sendingLine(supabase, phone, args.workspaceId)
    if (from === 'no_line') return { texted: false }
    const send = deps.send ?? sendSms
    const sender = from ? null : await agentSender(supabase, args.userId)
    const sent = from ? await send(phone.phone, text, { from }) : sender ? await send(phone.phone, text, { sender }) : await send(phone.phone, text)
    if (!sent.ok) return { texted: false }
    await recordOutbound(supabase, { phone: phone.phone, kind: 'connected', sid: sent.sid, userId: args.userId })
    return { texted: true }
  } catch (err) {
    console.warn('[text-connect] confirmation failed:', err instanceof Error ? err.message : err)
    return { texted: false }
  }
}

/** The notice's words. Pure. */
export function connectedNoticeEmail(args: { to: string; provider: TextConnectProvider; maskedPhone: string | null }): { subject: string; text: string } {
  const name = PROVIDER_LABEL[args.provider]
  const whose = args.maskedPhone ? `the Dial8 account texting ${args.maskedPhone}` : 'a Dial8 account'
  return {
    subject: `Your ${name} account was connected to Dial8`,
    text:
      `Your ${name} account ${args.to} was just connected to ${whose}, from a link Dial8 texted to that number. If that was you, there's nothing to do. ` +
      `If it wasn't, remove Dial8's access here: ${REVOKE_URL[args.provider]} and reply to this email so we can look into it.`,
  }
}

/**
 * Email the connected address that it was connected, and to which Dial8
 * account: the one defence a person who tapped a forwarded link has. Best
 * effort: returns whether Resend took it.
 */
async function sendConnectedNotice(args: { to: string; provider: TextConnectProvider; maskedPhone: string | null }): Promise<boolean> {
  if (!process.env.RESEND_API_KEY || !args.to.includes('@') || args.to.endsWith('@unknown')) return false
  const { subject, text } = connectedNoticeEmail(args)
  const { error } = await getResend().emails.send({
    from: FROM_EMAIL,
    to: args.to,
    subject,
    text,
    html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;"><p style="color: #333; line-height: 1.6;">${escapeHtml(text)}</p></div>`,
  })
  return !error
}

/** True while the person's setup by text is on (onboarding_progress.text_signup, not finished). */
async function inTextSetup(supabase: SupabaseClient, userId: string, workspaceId: string): Promise<boolean> {
  const { data } = await supabase.from('member').select('onboarding_progress').eq('user_id', userId).eq('workspace_id', workspaceId).maybeSingle()
  const progress = (data as { onboarding_progress?: unknown } | null)?.onboarding_progress
  const signup = progress && typeof progress === 'object' ? (progress as Record<string, unknown>).text_signup : null
  return !!signup && typeof signup === 'object' && !(signup as Record<string, unknown>).finished_at
}
