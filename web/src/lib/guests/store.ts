/**
 * People who text the owner's agent (guest access, migration 427), read and
 * written with the service role. The owner's routes (People tab) call these
 * after their own auth; every function takes the owner's user id and touches
 * only that owner's rows.
 *
 *   createGuest       add a person: their name, the channels they reach the
 *                     agent on (Text, Slack: migration 434), their number
 *                     (needed for Text) and tools (from a preset). Returns their one-time invite code, which
 *                     the invite link puts in their first text. A number
 *                     that is someone's own verified phone, the owner's
 *                     among them, or another owner's active guest, is
 *                     refused: one Dial8 number, so a phone reaches one
 *                     agent.
 *   renewInvite       a fresh code for someone who hasn't texted yet.
 *   updateGuest       their name, channels, number (once, for someone
 *                     added without one), tools, asks, the owner's notes,
 *                     or the addresses their calendar invites come from
 *                     (migration 455).
 *   approveRequest    a JOIN request becomes an active guest, with a preset.
 *   removeGuest       no more access; what their agent learned is deleted.
 *   requestCode /
 *   setRequestsOpen   the owner's code for "JOIN <code>", and its switch.
 *   trustedGuestEmails
 *                     the owner's guests' calendar addresses, for meeting
 *                     prep and the look-ahead.
 *
 * Guests always text first: nothing here sends a text.
 *
 * Server only.
 */
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CODE_ALPHABET, REPLY_CODE_LENGTH, isYesOrNoWord } from '@/lib/safety/caller'
import { isNanpNumber, normalizeE164 } from '@/lib/twilio/phone'
import { smsHref } from '@/lib/sms/phone-format'
import { getToolSideEffect } from '@/lib/ai/tool-registry'
import {
  askToolsWithDefaults,
  isGuestPresetId,
  normalizeAskBefore,
  normalizeAskTools,
  normalizeGuestTools,
  presetOf,
  presetSettings,
  type GuestAskBefore,
  type GuestPresetId,
  type GuestPresetValue,
} from './presets'
import { GUEST_CALENDAR_EMAILS_MAX, cleanCalendarEmails, isPlausibleEmail } from './people'

/** How long an invite code works. */
export const GUEST_INVITE_TTL_MS = 7 * 24 * 60 * 60_000
/** People one owner may list at once (any state but removed). */
export const GUESTS_PER_OWNER = 25
export const GUEST_NAME_MAX = 80
export const GUEST_NOTES_MAX = 2000
export { GUEST_CALENDAR_EMAILS_MAX, cleanCalendarEmails }

export type GuestState = 'invited' | 'requested' | 'active' | 'removed'

/**
 * Where a guest reaches the owner's agent: Text, Slack (migration 434), and
 * their own Dial8 agent (dial8, migration 435: src/lib/agent-links). The
 * People routes here never add or take away dial8: only a link does.
 */
export const GUEST_CHANNELS = ['sms', 'slack', 'dial8'] as const
export type GuestChannelId = (typeof GUEST_CHANNELS)[number]

/** Stored or requested channels, cleaned: known ones only, deduped, in order. Anything else is dropped (fail closed). */
export function normalizeChannels(channels: unknown): GuestChannelId[] {
  const given = new Set(Array.isArray(channels) ? channels : [])
  return GUEST_CHANNELS.filter((c) => given.has(c))
}

/**
 * The channels of theirs not yet proven theirs: their invite code still binds
 * these. Their agent (dial8) is bound by the link going active, never by an
 * invite, so it is never listed here (agent_guest.peer_bound_at says it).
 */
export function unboundChannels(guest: Pick<AgentGuest, 'channels' | 'phoneBoundAt' | 'slackUserId'>): GuestChannelId[] {
  return guest.channels.filter((c) => (c === 'sms' ? guest.phoneBoundAt === null : c === 'slack' ? guest.slackUserId === null : false))
}

export interface AgentGuest {
  id: string
  ownerUserId: string
  workspaceId: string
  displayName: string
  /** Null for someone who reaches the agent on Slack only (migration 434). */
  phone: string | null
  /** Where they reach the agent (migration 434). */
  channels: GuestChannelId[]
  /** When their number was proven theirs (their invite or JOIN texted from it); a text reaches their agent only after (434). */
  phoneBoundAt: string | null
  /** The Slack account bound to them (they DMed the Dial8 bot with their invite), else null (434). */
  slackTeamId: string | null
  slackUserId: string | null
  /** The Dial8 user this person is, for their agent (dial8), else null (435). */
  peerUserId: string | null
  /** When the link with them went active; their agent reaches nothing before (435). */
  peerBoundAt: string | null
  /**
   * The addresses their calendar invites come from, as the owner listed them
   * (migration 455): lower case, deduped. An active guest's count as the
   * owner's trusted people (trustedGuestEmails).
   */
  calendarEmails: string[]
  /**
   * A business's customer (preset 'customer', migration 458;
   * src/lib/customers/): the business number they texted, and their CRM
   * contact when known. Null for everyone the owner added.
   */
  businessNumberId: string | null
  contactId: string | null
  preset: GuestPresetValue
  tools: string[]
  /** Held, but every call waits for the owner's yes (migration 429). Always a subset of tools. */
  askTools: string[]
  askBefore: GuestAskBefore[]
  notes: string | null
  state: GuestState
  inviteExpiresAt: string | null
  requestedAt: string | null
  activatedAt: string | null
  removedAt: string | null
  optedOut: boolean
  lastInboundAt: string | null
  createdAt: string
}

interface AgentGuestRow {
  id: string
  owner_user_id: string
  workspace_id: string
  display_name: string
  phone_e164: string | null
  channels?: string[] | null
  phone_bound_at?: string | null
  slack_team_id?: string | null
  slack_user_id?: string | null
  /** Migration 435: absent on a database without it. */
  peer_user_id?: string | null
  peer_bound_at?: string | null
  /** Migration 455. */
  calendar_emails?: string[] | null
  /** Migration 458: a business's customer. */
  business_number_id?: string | null
  contact_id?: string | null
  preset: string
  tools: string[] | null
  /** Migration 429: absent on a database without it (every risky call still asks). */
  ask_tools?: string[] | null
  ask_before: string[] | null
  notes: string | null
  state: string
  invite_expires_at: string | null
  requested_at: string | null
  activated_at: string | null
  removed_at: string | null
  opted_out_at: string | null
  last_inbound_at: string | null
  created_at: string
}

export const AGENT_GUEST_SELECT =
  'id, owner_user_id, workspace_id, display_name, phone_e164, channels, phone_bound_at, slack_team_id, slack_user_id, peer_user_id, peer_bound_at, calendar_emails, business_number_id, contact_id, preset, tools, ask_tools, ask_before, notes, state, invite_expires_at, requested_at, activated_at, removed_at, opted_out_at, last_inbound_at, created_at'

const STATES: readonly GuestState[] = ['invited', 'requested', 'active', 'removed']

/** Stored addresses as the app reads them: strings only, lower case, plausible, deduped, at most the cap. */
function storedCalendarEmails(value: unknown): string[] {
  const emails = (Array.isArray(value) ? value : []).filter((v): v is string => typeof v === 'string').map((v) => v.trim().toLowerCase())
  return [...new Set(emails.filter(isPlausibleEmail))].slice(0, GUEST_CALENDAR_EMAILS_MAX)
}

/** A row as the app reads it. Tools and asks are cleaned (fail closed); an unknown state reads as removed. */
export function toGuest(row: AgentGuestRow): AgentGuest {
  const tools = normalizeGuestTools(row.tools)
  const askBefore = normalizeAskBefore(row.ask_before)
  // A row never given asks (null) reads as each tool's default; a saved list is the owner's word.
  const askTools = normalizeAskTools(row.ask_tools, tools, askBefore)
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    workspaceId: row.workspace_id,
    displayName: row.display_name,
    phone: row.phone_e164,
    channels: normalizeChannels(row.channels),
    phoneBoundAt: row.phone_bound_at ?? null,
    slackTeamId: row.slack_team_id ?? null,
    slackUserId: row.slack_user_id ?? null,
    peerUserId: row.peer_user_id ?? null,
    peerBoundAt: row.peer_bound_at ?? null,
    calendarEmails: storedCalendarEmails(row.calendar_emails),
    preset: row.preset === 'household' || row.preset === 'colleague' || row.preset === 'customer' ? row.preset : 'custom',
    businessNumberId: row.business_number_id ?? null,
    contactId: row.contact_id ?? null,
    tools,
    askTools,
    askBefore,
    notes: row.notes,
    state: (STATES as readonly string[]).includes(row.state) ? (row.state as GuestState) : 'removed',
    inviteExpiresAt: row.invite_expires_at,
    requestedAt: row.requested_at,
    activatedAt: row.activated_at,
    removedAt: row.removed_at,
    optedOut: row.opted_out_at !== null,
    lastInboundAt: row.last_inbound_at,
    createdAt: row.created_at,
  }
}

// ── Codes ───────────────────────────────────────────────────────────────────

/** A fresh code: six characters of the unambiguous alphabet, never a word a reply reads as yes or no. */
export function generateGuestCode(): string {
  for (;;) {
    let code = ''
    for (let i = 0; i < REPLY_CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)]
    if (!isYesOrNoWord(code)) return code
  }
}

/** The key invite codes are hashed with: the required internal secret (fail closed without it). */
function inviteKey(): string | null {
  const key = process.env.RUN_SKILL_INTERNAL_SECRET
  return key && key.length > 0 ? key : null
}

/** The stored form of an invite code: an HMAC bound to the guest and their number. Exported for the tests. */
export function hashInviteCode(code: string, binding: { guestId: string; phone: string | null }, key: string): string {
  // A Slack-only guest has no number: the code is bound to the guest alone.
  return createHmac('sha256', key).update(`guest-invite:${binding.guestId}:${binding.phone ?? ''}:${code.toUpperCase()}`).digest('hex')
}

/** Whether `code` is this guest's invite (constant time). */
export function inviteCodeMatches(code: string, binding: { guestId: string; phone: string | null }, storedHash: string | null, key: string): boolean {
  if (!storedHash) return false
  const a = new Uint8Array(Buffer.from(hashInviteCode(code, binding, key), 'utf8'))
  const b = new Uint8Array(Buffer.from(storedHash, 'utf8'))
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The first text the invite link types in for them: "Hi, it's Sam · K7Q4MX". */
export function inviteText(displayName: string, code: string): string {
  const first = displayName.trim().split(/\s+/)[0] || 'me'
  return `Hi, it's ${first} · ${code}`
}

/** The invite link: Messages, to the Dial8 number, with their first text typed in. */
export function inviteHref(dial8Number: string, displayName: string, code: string): string {
  return smsHref(dial8Number, inviteText(displayName, code))
}

// ── Writes ──────────────────────────────────────────────────────────────────

export type CreateGuestResult =
  | { ok: true; guest: AgentGuest; inviteCode: string }
  | {
      ok: false
      reason:
        | 'bad_name'
        | 'bad_channels'
        | 'bad_phone'
        | 'unsupported_country'
        | 'own_number'
        | 'someones_number'
        | 'already_listed'
        | 'too_many'
        | 'not_configured'
        | 'failed'
    }

export interface CreateGuestInput {
  ownerUserId: string
  workspaceId: string
  displayName: string
  /** Their mobile number: needed for Text, optional for Slack only. */
  phone?: string | null
  /** Where they reach the agent; Text when left out. */
  channels?: readonly string[]
  preset: GuestPresetId
  /** Tools other than the preset's (normalized; the always-on ones are added). */
  tools?: readonly string[]
  /** Needs approval tools other than the preset's (normalized against the tools). */
  askTools?: readonly string[]
  askBefore?: readonly string[]
  notes?: string | null
}

function cleanName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const trimmed = name.trim().replace(/\s+/g, ' ')
  return trimmed.length >= 1 && trimmed.length <= GUEST_NAME_MAX ? trimmed : null
}

function cleanNotes(notes: unknown): string | null | undefined {
  if (notes === undefined) return undefined
  if (notes === null) return null
  if (typeof notes !== 'string') return undefined
  const trimmed = notes.trim()
  return trimmed ? trimmed.slice(0, GUEST_NOTES_MAX) : null
}

/**
 * Why a number can't be a guest's: someone's own verified phone (the owner's
 * too). Every row of the phone counts, on either line (migration 464: a
 * Dial8-line row and any business-line rows): a business line is a Dial8
 * person too. Throws on a failed read.
 */
async function numberIsSomeones(supabase: SupabaseClient, phone: string, ownerUserId: string): Promise<'own_number' | 'someones_number' | null> {
  const { data, error } = await supabase.from('user_phone').select('user_id, verified_at').eq('phone_e164', phone)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<{ user_id: string; verified_at: string | null }>
  if (rows.some((r) => r.user_id === ownerUserId)) return 'own_number'
  return rows.some((r) => r.verified_at !== null) ? 'someones_number' : null
}

/** Whether another owner's guest is active on this number. Throws on a failed read. */
async function numberIsAnotherOwnersGuest(supabase: SupabaseClient, phone: string, ownerUserId: string): Promise<boolean> {
  const { data, error } = await supabase.from('agent_guest').select('owner_user_id').eq('phone_e164', phone).eq('state', 'active').neq('preset', 'customer')
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<{ owner_user_id: string }>).some((r) => r.owner_user_id !== ownerUserId)
}

export async function createGuest(supabase: SupabaseClient, input: CreateGuestInput, now: number = Date.now()): Promise<CreateGuestResult> {
  const displayName = cleanName(input.displayName)
  if (!displayName) return { ok: false, reason: 'bad_name' }
  const channels = normalizeChannels(input.channels ?? ['sms'])
  // Their agent is added by a link request (src/lib/agent-links/store.ts), never here.
  if (channels.length === 0 || channels.includes('dial8')) return { ok: false, reason: 'bad_channels' }
  const given = typeof input.phone === 'string' && input.phone.trim() !== ''
  const phone = given ? normalizeE164(input.phone) : null
  if (given && !phone) return { ok: false, reason: 'bad_phone' }
  if (!phone && channels.includes('sms')) return { ok: false, reason: 'bad_phone' }
  if (phone && !isNanpNumber(phone)) return { ok: false, reason: 'unsupported_country' }
  if (!isGuestPresetId(input.preset)) return { ok: false, reason: 'failed' }
  const key = inviteKey()
  if (!key) return { ok: false, reason: 'not_configured' }

  try {
    if (phone) {
      const someones = await numberIsSomeones(supabase, phone, input.ownerUserId)
      if (someones) return { ok: false, reason: someones }
      if (await numberIsAnotherOwnersGuest(supabase, phone, input.ownerUserId)) return { ok: false, reason: 'someones_number' }
    }

    const { data: listed, error: listedError } = await supabase
      .from('agent_guest')
      .select('id, phone_e164')
      .eq('owner_user_id', input.ownerUserId)
      .neq('state', 'removed')
      .neq('preset', 'customer')
    if (listedError) return { ok: false, reason: 'failed' }
    const rows = (listed ?? []) as Array<{ id: string; phone_e164: string | null }>
    if (phone && rows.some((r) => r.phone_e164 === phone)) return { ok: false, reason: 'already_listed' }
    if (rows.length >= GUESTS_PER_OWNER) return { ok: false, reason: 'too_many' }
  } catch {
    return { ok: false, reason: 'failed' }
  }

  const base = presetSettings(input.preset)
  const tools = input.tools ? normalizeGuestTools(input.tools) : base.tools
  // A tool list of the owner's own with no asks of its own keeps the preset's asks for what it still holds.
  const askBefore = input.askBefore ? normalizeAskBefore(input.askBefore) : base.askBefore
  // The owner's own asks are the truth; with none, the preset's, and each tool beyond the preset's its default.
  const askTools =
    input.askTools !== undefined
      ? normalizeAskTools(input.askTools, tools, askBefore)
      : askToolsWithDefaults(base.askTools, tools.filter((t) => !base.tools.includes(t)), tools, askBefore)
  const id = randomUUID()
  const inviteCode = generateGuestCode()
  const { data, error } = await supabase
    .from('agent_guest')
    .insert({
      id,
      owner_user_id: input.ownerUserId,
      workspace_id: input.workspaceId,
      display_name: displayName,
      phone_e164: phone,
      channels,
      preset: presetOf({ tools, askTools, askBefore }),
      tools,
      ask_tools: askTools,
      ask_before: askBefore,
      notes: cleanNotes(input.notes) ?? null,
      state: 'invited',
      invite_code_hash: hashInviteCode(inviteCode, { guestId: id, phone }, key),
      invite_expires_at: new Date(now + GUEST_INVITE_TTL_MS).toISOString(),
    })
    .select(AGENT_GUEST_SELECT)
    .single()
  if (error || !data) return { ok: false, reason: (error as { code?: string } | null)?.code === '23505' ? 'already_listed' : 'failed' }
  return { ok: true, guest: toGuest(data as AgentGuestRow), inviteCode }
}

export type GuestWriteResult =
  | { ok: true; guest: AgentGuest }
  | {
      ok: false
      reason:
        | 'not_found'
        | 'wrong_state'
        | 'bad_name'
        | 'bad_channels'
        | 'bad_phone'
        | 'bad_calendar_emails'
        | 'unsupported_country'
        | 'own_number'
        | 'someones_number'
        | 'not_configured'
        | 'failed'
    }

/** One of this owner's guests, or null (another owner's reads as null). Throws on a failed read. */
export async function getGuest(supabase: SupabaseClient, ownerUserId: string, guestId: string): Promise<AgentGuest | null> {
  const { data, error } = await supabase.from('agent_guest').select(AGENT_GUEST_SELECT).eq('id', guestId).eq('owner_user_id', ownerUserId).maybeSingle()
  if (error) throw new Error(error.message)
  return data ? toGuest(data as AgentGuestRow) : null
}

/** This owner's people, newest first (removed ones left out unless asked for). Throws on a failed read. */
export async function listGuests(supabase: SupabaseClient, ownerUserId: string, opts: { includeRemoved?: boolean } = {}): Promise<AgentGuest[]> {
  // A business's customers aren't the owner's people (src/lib/customers/): never listed here.
  let query = supabase.from('agent_guest').select(AGENT_GUEST_SELECT).eq('owner_user_id', ownerUserId).neq('preset', 'customer')
  if (!opts.includeRemoved) query = query.neq('state', 'removed')
  const { data, error } = await query.order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return ((data ?? []) as AgentGuestRow[]).map(toGuest)
}

async function writeGuest(supabase: SupabaseClient, ownerUserId: string, guestId: string, patch: Record<string, unknown>, onlyStates?: readonly GuestState[]): Promise<GuestWriteResult> {
  let query = supabase
    .from('agent_guest')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', guestId)
    .eq('owner_user_id', ownerUserId)
  if (onlyStates) query = query.in('state', [...onlyStates])
  const { data, error } = await query.select(AGENT_GUEST_SELECT).maybeSingle()
  if (error) return { ok: false, reason: (error as { code?: string }).code === '23505' ? 'someones_number' : 'failed' }
  return data ? { ok: true, guest: toGuest(data as AgentGuestRow) } : { ok: false, reason: onlyStates ? 'wrong_state' : 'not_found' }
}

export interface GuestPatch {
  displayName?: string
  /** Where they reach the agent. Text needs a number. */
  channels?: readonly string[]
  /** A number for someone added without one (a number already set isn't changed here). */
  phone?: string
  tools?: readonly string[]
  askTools?: readonly string[]
  askBefore?: readonly string[]
  notes?: string | null
  /** The addresses their calendar invites come from (cleanCalendarEmails); the whole list, replaced. */
  calendarEmails?: readonly unknown[]
}

/** Change a listed person's name, tools, asks, notes or calendar addresses. The preset follows what they now are. */
export async function updateGuest(supabase: SupabaseClient, ownerUserId: string, guestId: string, patch: GuestPatch): Promise<GuestWriteResult> {
  let current: AgentGuest | null
  try {
    current = await getGuest(supabase, ownerUserId, guestId)
  } catch {
    return { ok: false, reason: 'failed' }
  }
  if (!current) return { ok: false, reason: 'not_found' }
  if (current.state === 'removed') return { ok: false, reason: 'wrong_state' }
  const row: Record<string, unknown> = {}
  if (patch.displayName !== undefined) {
    const name = cleanName(patch.displayName)
    if (!name) return { ok: false, reason: 'bad_name' }
    row.display_name = name
  }
  let phone = current.phone
  if (patch.phone !== undefined && patch.phone.trim() !== '' && current.phone === null) {
    const next = normalizeE164(patch.phone)
    if (!next) return { ok: false, reason: 'bad_phone' }
    if (!isNanpNumber(next)) return { ok: false, reason: 'unsupported_country' }
    try {
      const someones = await numberIsSomeones(supabase, next, ownerUserId)
      if (someones) return { ok: false, reason: someones }
      if (await numberIsAnotherOwnersGuest(supabase, next, ownerUserId)) return { ok: false, reason: 'someones_number' }
    } catch {
      return { ok: false, reason: 'failed' }
    }
    phone = next
    row.phone_e164 = next
  }
  if (patch.channels !== undefined) {
    // Their agent (dial8) comes and goes with the link only: kept as it is, whatever the patch says.
    const channels = normalizeChannels([...normalizeChannels(patch.channels).filter((c) => c !== 'dial8'), ...(current.channels.includes('dial8') ? ['dial8'] : [])])
    if (channels.length === 0) return { ok: false, reason: 'bad_channels' }
    if (channels.includes('sms') && !phone) return { ok: false, reason: 'bad_phone' }
    row.channels = channels
    // A channel taken away forgets its binding: adding it back needs a new invite.
    if (!channels.includes('sms')) row.phone_bound_at = null
    if (!channels.includes('slack')) {
      row.slack_team_id = null
      row.slack_user_id = null
    }
  }
  const tools = patch.tools !== undefined ? normalizeGuestTools(patch.tools) : current.tools
  // Fewer tools drop their asks with them; more keep the current asks, each new tool on its default.
  const askBefore = patch.askBefore !== undefined ? normalizeAskBefore(patch.askBefore) : current.askBefore
  // Turning "Deleting anything asks you first" on puts every held delete back on Needs approval.
  const deletesNowAsk = (a: readonly string[]) => a.includes('deletes') || a.includes('changes')
  const fresh = [
    ...tools.filter((t) => !current.tools.includes(t)),
    ...(deletesNowAsk(askBefore) && !deletesNowAsk(current.askBefore) ? tools.filter((t) => getToolSideEffect(t) === 'delete') : []),
  ]
  const askTools = patch.askTools !== undefined ? normalizeAskTools(patch.askTools, tools, askBefore) : askToolsWithDefaults(current.askTools, fresh, tools, askBefore)
  const changed = patch.tools !== undefined || patch.askTools !== undefined || patch.askBefore !== undefined
  if (patch.tools !== undefined) row.tools = tools
  if (changed) row.ask_tools = askTools
  if (patch.askBefore !== undefined) row.ask_before = askBefore
  if (changed) row.preset = presetOf({ tools, askTools, askBefore })
  const notes = cleanNotes(patch.notes)
  if (notes !== undefined) row.notes = notes
  if (patch.calendarEmails !== undefined) {
    const emails = cleanCalendarEmails(patch.calendarEmails)
    if (!emails) return { ok: false, reason: 'bad_calendar_emails' }
    row.calendar_emails = emails
  }
  return writeGuest(supabase, ownerUserId, guestId, row, ['invited', 'requested', 'active'])
}

/** A fresh invite code for a channel of theirs not yet bound (the old one stops working). */
export async function renewInvite(supabase: SupabaseClient, ownerUserId: string, guestId: string, now: number = Date.now()): Promise<{ ok: true; guest: AgentGuest; inviteCode: string } | Extract<GuestWriteResult, { ok: false }>> {
  const key = inviteKey()
  if (!key) return { ok: false, reason: 'not_configured' }
  let current: AgentGuest | null
  try {
    current = await getGuest(supabase, ownerUserId, guestId)
  } catch {
    return { ok: false, reason: 'failed' }
  }
  if (!current) return { ok: false, reason: 'not_found' }
  // Someone who hasn't texted yet, or is in on one channel and not yet another.
  const open = current.state === 'invited' || (current.state === 'active' && unboundChannels(current).length > 0)
  if (!open) return { ok: false, reason: 'wrong_state' }
  const inviteCode = generateGuestCode()
  const result = await writeGuest(
    supabase,
    ownerUserId,
    guestId,
    {
      invite_code_hash: hashInviteCode(inviteCode, { guestId, phone: current.phone }, key),
      invite_expires_at: new Date(now + GUEST_INVITE_TTL_MS).toISOString(),
    },
    [current.state],
  )
  return result.ok ? { ...result, inviteCode } : result
}

/** Say yes to someone who asked by text: they become an active guest with this preset's tools. */
export async function approveRequest(supabase: SupabaseClient, ownerUserId: string, guestId: string, preset: GuestPresetId, now: number = Date.now()): Promise<GuestWriteResult> {
  if (!isGuestPresetId(preset)) return { ok: false, reason: 'failed' }
  const { tools, askTools, askBefore } = presetSettings(preset)
  return writeGuest(
    supabase,
    ownerUserId,
    guestId,
    // They asked by text from this number: it's theirs.
    { state: 'active', preset, tools, ask_tools: askTools, ask_before: askBefore, activated_at: new Date(now).toISOString(), phone_bound_at: new Date(now).toISOString() },
    ['requested'],
  )
}

/**
 * No more access: the row stays for the record (state removed, no invite),
 * and what their agent learned about them is deleted. Ignoring a request is
 * the same step.
 */
export async function removeGuest(supabase: SupabaseClient, ownerUserId: string, guestId: string, now: number = Date.now()): Promise<GuestWriteResult> {
  const result = await writeGuest(
    supabase,
    ownerUserId,
    guestId,
    { state: 'removed', removed_at: new Date(now).toISOString(), invite_code_hash: null, invite_expires_at: null },
    ['invited', 'requested', 'active'],
  )
  if (!result.ok) return result
  const { error } = await supabase.from('agent_guest_memory').delete().eq('guest_id', guestId).eq('owner_user_id', ownerUserId)
  if (error) return { ok: false, reason: 'failed' }
  return result
}

// ── The request code ────────────────────────────────────────────────────────

export interface RequestCodeState {
  code: string
  open: boolean
}

/** The owner's request code, made the first time it's asked for (closed until they open it). */
export async function requestCode(supabase: SupabaseClient, ownerUserId: string, workspaceId: string): Promise<RequestCodeState | null> {
  const { data, error } = await supabase.from('agent_guest_request_code').select('code, enabled_at').eq('owner_user_id', ownerUserId).maybeSingle()
  if (error) return null
  if (data) return { code: (data as { code: string }).code, open: (data as { enabled_at: string | null }).enabled_at !== null }
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateGuestCode()
    const { data: made, error: insertError } = await supabase
      .from('agent_guest_request_code')
      .insert({ owner_user_id: ownerUserId, workspace_id: workspaceId, code })
      .select('code, enabled_at')
      .single()
    if (made) return { code: (made as { code: string }).code, open: false }
    // A code another owner holds: try another. Anything else (a race on our own row among them) re-reads.
    if ((insertError as { code?: string } | null)?.code !== '23505') break
    const { data: raced } = await supabase.from('agent_guest_request_code').select('code, enabled_at').eq('owner_user_id', ownerUserId).maybeSingle()
    if (raced) return { code: (raced as { code: string }).code, open: (raced as { enabled_at: string | null }).enabled_at !== null }
  }
  return null
}

/** Turn "Let people ask" on or off. */
export async function setRequestsOpen(supabase: SupabaseClient, ownerUserId: string, workspaceId: string, open: boolean, now: number = Date.now()): Promise<RequestCodeState | null> {
  const current = await requestCode(supabase, ownerUserId, workspaceId)
  if (!current) return null
  const at = new Date(now).toISOString()
  const { data, error } = await supabase
    .from('agent_guest_request_code')
    .update({ enabled_at: open ? at : null, updated_at: at })
    .eq('owner_user_id', ownerUserId)
    .select('code, enabled_at')
    .maybeSingle()
  if (error || !data) return null
  return { code: (data as { code: string }).code, open: (data as { enabled_at: string | null }).enabled_at !== null }
}

// ── Texts in (src/lib/guests/texting.ts) ────────────────────────────────────

/**
 * The guest active on this number who may text (Text in their channels,
 * migration 434; one owner at most: agent_guest_active_phone_key), or null.
 * Throws on a failed read.
 */
export async function findActiveGuestByPhone(supabase: SupabaseClient, phone: string): Promise<AgentGuest | null> {
  const { data, error } = await supabase
    .from('agent_guest')
    .select(AGENT_GUEST_SELECT)
    .eq('phone_e164', phone)
    .eq('state', 'active')
    // A business's customer texts its number, never the Dial8 one (src/lib/customers/texting.ts).
    .neq('preset', 'customer')
    .contains('channels', ['sms'])
    .not('phone_bound_at', 'is', null)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data ? toGuest(data as AgentGuestRow) : null
}

/**
 * Invites to this number, for Text, that still work (not expired), with
 * their stored hash: someone invited, or in on Slack already and not yet on
 * Text. Throws on a failed read.
 */
export async function findOpenInvitesByPhone(supabase: SupabaseClient, phone: string, now: number = Date.now()): Promise<Array<{ guest: AgentGuest; inviteHash: string }>> {
  const { data, error } = await supabase
    .from('agent_guest')
    .select(`${AGENT_GUEST_SELECT}, invite_code_hash`)
    .eq('phone_e164', phone)
    .or('state.eq.invited,and(state.eq.active,phone_bound_at.is.null)')
    .neq('preset', 'customer')
    .contains('channels', ['sms'])
    .gt('invite_expires_at', new Date(now).toISOString())
    .limit(10)
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<AgentGuestRow & { invite_code_hash: string | null }>)
    .filter((row) => typeof row.invite_code_hash === 'string' && row.invite_code_hash.length > 0)
    .map((row) => ({ guest: toGuest(row), inviteHash: row.invite_code_hash as string }))
}

/**
 * The first text with the right invite code: their number is bound and the
 * guest is active (someone already in on Slack stays active). The code is
 * spent unless Slack, also theirs, isn't bound yet (434). 'conflict' when this number is already active for another
 * owner (one Dial8 number, so a phone reaches one agent); 'gone' when the
 * invite was removed or used in the meantime.
 */
export async function activateInvitedGuest(
  supabase: SupabaseClient,
  guest: Pick<AgentGuest, 'id' | 'ownerUserId' | 'state' | 'channels' | 'slackUserId'>,
  now: number = Date.now(),
): Promise<{ ok: true; guest: AgentGuest } | { ok: false; reason: 'conflict' | 'gone' | 'failed' }> {
  const at = new Date(now).toISOString()
  // Their number is theirs now. The code stays alive while Slack, also theirs, isn't bound yet.
  const slackToBind = guest.channels.includes('slack') && guest.slackUserId === null
  const patch: Record<string, unknown> = { state: 'active', phone_bound_at: at, updated_at: at }
  if (guest.state === 'invited') patch.activated_at = at
  if (!slackToBind) {
    patch.invite_code_hash = null
    patch.invite_expires_at = null
  }
  const { data, error } = await supabase
    .from('agent_guest')
    .update(patch)
    .eq('id', guest.id)
    .eq('owner_user_id', guest.ownerUserId)
    .or('state.eq.invited,and(state.eq.active,phone_bound_at.is.null)')
    .select(AGENT_GUEST_SELECT)
    .maybeSingle()
  if (error) return { ok: false, reason: (error as { code?: string }).code === '23505' ? 'conflict' : 'failed' }
  return data ? { ok: true, guest: toGuest(data as AgentGuestRow) } : { ok: false, reason: 'gone' }
}

/** The owner a request code belongs to, when they let people ask; null otherwise. Throws on a failed read. */
export async function findOpenRequestCode(supabase: SupabaseClient, code: string): Promise<{ ownerUserId: string; workspaceId: string } | null> {
  const wanted = code.trim().toUpperCase()
  if (wanted.length !== REPLY_CODE_LENGTH || [...wanted].some((c) => !CODE_ALPHABET.includes(c))) return null
  const { data, error } = await supabase
    .from('agent_guest_request_code')
    .select('owner_user_id, workspace_id, enabled_at')
    .eq('code', wanted)
    .maybeSingle()
  if (error) throw new Error(error.message)
  const row = data as { owner_user_id: string; workspace_id: string; enabled_at: string | null } | null
  return row && row.enabled_at !== null ? { ownerUserId: row.owner_user_id, workspaceId: row.workspace_id } : null
}

export type GuestRequestResult =
  | { ok: true; guest: AgentGuest }
  | { ok: false; reason: 'exists' | 'too_many' | 'someones_number' | 'failed'; guest?: AgentGuest }

/**
 * "JOIN <code> [name]" from a number: a request the owner approves or
 * ignores in the People tab. It starts with the narrowest preset's tools
 * (approveRequest sets the preset the owner picks). Their name is what they
 * texted, else their number.
 */
export async function createGuestRequest(
  supabase: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string; phone: string; name?: string | null },
  now: number = Date.now(),
): Promise<GuestRequestResult> {
  const displayName = cleanName(input.name) ?? input.phone
  try {
    if (await numberIsAnotherOwnersGuest(supabase, input.phone, input.ownerUserId)) return { ok: false, reason: 'someones_number' }
    const { data: listed, error: listedError } = await supabase
      .from('agent_guest')
      .select(AGENT_GUEST_SELECT)
      .eq('owner_user_id', input.ownerUserId)
      .neq('state', 'removed')
      .neq('preset', 'customer')
    if (listedError) return { ok: false, reason: 'failed' }
    const rows = ((listed ?? []) as AgentGuestRow[]).map(toGuest)
    const mine = rows.find((r) => r.phone === input.phone)
    if (mine) return { ok: false, reason: 'exists', guest: mine }
    if (rows.length >= GUESTS_PER_OWNER) return { ok: false, reason: 'too_many' }
  } catch {
    return { ok: false, reason: 'failed' }
  }
  const { tools, askTools, askBefore } = presetSettings('colleague')
  const { data, error } = await supabase
    .from('agent_guest')
    .insert({
      owner_user_id: input.ownerUserId,
      workspace_id: input.workspaceId,
      display_name: displayName,
      phone_e164: input.phone,
      preset: 'colleague',
      tools,
      ask_tools: askTools,
      ask_before: askBefore,
      state: 'requested',
      requested_at: new Date(now).toISOString(),
    })
    .select(AGENT_GUEST_SELECT)
    .single()
  if (error || !data) return { ok: false, reason: (error as { code?: string } | null)?.code === '23505' ? 'exists' : 'failed' }
  return { ok: true, guest: toGuest(data as AgentGuestRow) }
}

/** STOP / START from a guest's number: shown on the People tab (the ledger is what stops the texts). Best-effort. */
export async function setGuestOptOut(supabase: SupabaseClient, phone: string, optedOut: boolean, now: number = Date.now()): Promise<void> {
  const at = new Date(now).toISOString()
  await supabase.from('agent_guest').update({ opted_out_at: optedOut ? at : null, updated_at: at }).eq('phone_e164', phone).neq('state', 'removed')
}

/** A guest texted: when, for the People tab. Best-effort. */
export async function touchGuestInbound(supabase: SupabaseClient, guestId: string, now: number = Date.now()): Promise<void> {
  await supabase.from('agent_guest').update({ last_inbound_at: new Date(now).toISOString() }).eq('id', guestId)
}

/** The invite key, for the inbound check (null: invites can't be checked, so none activates). */
export function guestInviteKey(): string | null {
  return inviteKey()
}

// ── Trusted people (meeting prep, the look-ahead) ───────────────────────────

/** Linked guests whose Dial8 sign-in address is looked up, at most (one admin call each). */
export const TRUSTED_PEER_LOOKUPS_MAX = 3
/** How long those lookups may take together before they're dropped (the listed addresses still count). */
export const TRUSTED_PEER_LOOKUP_MS = 1_500

/**
 * The owner's trusted people, by calendar address (migration 455): each
 * active guest's calendar addresses, plus, for a guest whose agent is linked
 * to the owner's from OUTSIDE their workspaces (their Dial8 user, the link
 * active, sharing no workspace with the owner), their own Dial8 sign-in
 * address, which their calendar invites come from. Lower case.
 *
 * Why: a guest is someone the owner chose (Liam, 2026-10-31: every event of a
 * trip was an invite from his wife). Meeting prep doesn't count them as other
 * people, so an event with only guests on it gets no prep, and the look-ahead
 * treats their invites as the owner's own plans.
 *
 * Never a teammate: an agent link between two members of one workspace is a
 * colleague's, and "Liam / Sam weekly" must keep its prep, so a linked peer
 * who shares a workspace with the owner adds nothing (a membership read that
 * fails adds no peer at all). Callers also never count a workspace member as
 * a guest (meetingAttendance, the look-ahead's read), for an address an owner
 * typed for a guest that is a teammate's.
 *
 * The owner's own connected addresses are never in it, even when typed for a
 * guest: the look-ahead subtracts guests from a count that already left the
 * owner out, so their own address there would hide a stranger.
 *
 * Bounded: at most TRUSTED_PEER_LOOKUPS_MAX admin lookups (there is no table
 * of sign-in addresses to read instead: workspace-member-emails.ts), dropped
 * together after TRUSTED_PEER_LOOKUP_MS. Never throws: a failed read is no
 * one, a failed or slow lookup leaves that peer out, and prep and the
 * look-ahead then act as they did before (the safe side: more preps, fewer
 * texts).
 */
export async function trustedGuestEmails(service: SupabaseClient, ownerUserId: string): Promise<Set<string>> {
  const out = new Set<string>()
  try {
    const [{ data, error }, { data: own, error: ownError }] = await Promise.all([
      service.from('agent_guest').select('calendar_emails, peer_user_id, peer_bound_at').eq('owner_user_id', ownerUserId).eq('state', 'active').neq('preset', 'customer').limit(GUESTS_PER_OWNER),
      service.from('connected_account').select('account_email').eq('user_id', ownerUserId),
    ])
    if (error || ownError) return out
    const rows = (data ?? []) as Array<{ calendar_emails?: unknown; peer_user_id?: unknown; peer_bound_at?: unknown }>
    for (const row of rows) for (const email of storedCalendarEmails(row.calendar_emails)) out.add(email)
    const peers = [...new Set(rows.filter((r) => typeof r.peer_user_id === 'string' && r.peer_user_id && r.peer_bound_at).map((r) => r.peer_user_id as string))].sort()
    for (const email of await outsidePeerEmails(service, ownerUserId, peers)) out.add(email)
    for (const row of (own ?? []) as Array<{ account_email?: unknown }>) {
      if (typeof row.account_email === 'string') out.delete(row.account_email.trim().toLowerCase())
    }
  } catch {
    // No one trusted: as before.
  }
  return out
}

/**
 * The sign-in addresses of the linked peers who share no workspace with the
 * owner (an outside link), at most TRUSTED_PEER_LOOKUPS_MAX of them, within
 * TRUSTED_PEER_LOOKUP_MS. None when the membership read fails. Never throws.
 */
async function outsidePeerEmails(service: SupabaseClient, ownerUserId: string, peers: readonly string[]): Promise<string[]> {
  if (!peers.length) return []
  try {
    const { data, error } = await service.from('member').select('user_id, workspace_id').in('user_id', [ownerUserId, ...peers])
    if (error) return []
    const rows = (data ?? []) as Array<{ user_id?: unknown; workspace_id?: unknown }>
    const ownerWorkspaces = new Set(rows.filter((r) => r.user_id === ownerUserId).map((r) => r.workspace_id))
    const teammates = new Set(rows.filter((r) => r.user_id !== ownerUserId && ownerWorkspaces.has(r.workspace_id)).map((r) => r.user_id))
    const outside = peers.filter((p) => !teammates.has(p)).slice(0, TRUSTED_PEER_LOOKUPS_MAX)
    if (!outside.length) return []
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TRUSTED_PEER_LOOKUP_MS)
      timer.unref?.()
    })
    const lookups = Promise.all(
      outside.map(async (peerUserId) => {
        try {
          const { data: found } = await service.auth.admin.getUserById(peerUserId)
          const email = found?.user?.email?.trim().toLowerCase()
          return email && isPlausibleEmail(email) ? email : null
        } catch {
          return null
        }
      }),
    )
    const emails = await Promise.race([lookups, timedOut]).finally(() => clearTimeout(timer))
    return (emails ?? []).filter((e): e is string => !!e)
  } catch {
    return []
  }
}
