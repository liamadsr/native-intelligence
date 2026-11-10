/**
 * Adding, changing and removing the people who text the owner's agent
 * (src/lib/guests/store.ts), over a small in-memory stand-in for the three
 * tables it touches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  GUESTS_PER_OWNER,
  GUEST_CALENDAR_EMAILS_MAX,
  activateInvitedGuest,
  approveRequest,
  cleanCalendarEmails,
  createGuest,
  findActiveGuestByPhone,
  findOpenInvitesByPhone,
  generateGuestCode,
  hashInviteCode,
  inviteCodeMatches,
  inviteHref,
  inviteText,
  listGuests,
  removeGuest,
  renewInvite,
  requestCode,
  setRequestsOpen,
  TRUSTED_PEER_LOOKUPS_MAX,
  TRUSTED_PEER_LOOKUP_MS,
  trustedGuestEmails,
  updateGuest,
} from '../store'
import { CODE_ALPHABET, isYesOrNoWord } from '@/lib/safety/caller'
import { GUEST_CALENDAR_EMAILS_RAW_MAX } from '../people'
import { GUEST_ALWAYS_TOOLS } from '../tools'

type Row = Record<string, unknown>

/** Applies eq / neq / in filters; insert, update and delete write the rows; unique keys answer 23505. */
function fakeDb(tables: Record<string, Row[]>) {
  const unique: Record<string, (a: Row, b: Row) => boolean> = {
    agent_guest: (a, b) => a.owner_user_id === b.owner_user_id && a.phone_e164 === b.phone_e164 && a.state !== 'removed' && b.state !== 'removed',
    agent_guest_request_code: (a, b) => a.code === b.code || a.owner_user_id === b.owner_user_id,
  }
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let op: { kind: 'select' } | { kind: 'insert'; row: Row } | { kind: 'update'; patch: Row } | { kind: 'delete' } = { kind: 'select' }
    const rows = () => (tables[table] ??= [])
    const run = async (): Promise<{ data: Row[] | null; error: { message: string; code?: string } | null }> => {
      if (op.kind === 'insert') {
        const row = { created_at: new Date().toISOString(), opted_out_at: null, last_inbound_at: null, requested_at: null, activated_at: null, removed_at: null, enabled_at: null, ...op.row }
        if (rows().some((r) => unique[table]?.(r, row))) return { data: null, error: { message: 'duplicate', code: '23505' } }
        rows().push(row)
        return { data: [row], error: null }
      }
      const hit = rows().filter((r) => filters.every((f) => f(r)))
      if (op.kind === 'update') {
        for (const r of hit) Object.assign(r, op.patch)
        return { data: hit, error: null }
      }
      if (op.kind === 'delete') {
        tables[table] = rows().filter((r) => !hit.includes(r))
        return { data: hit, error: null }
      }
      return { data: hit, error: null }
    }
    const chain: Record<string, unknown> = {
      select: () => chain,
      insert: (row: Row) => ((op = { kind: 'insert', row }), chain),
      update: (patch: Row) => ((op = { kind: 'update', patch }), chain),
      delete: () => ((op = { kind: 'delete' }), chain),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), chain),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), chain),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), chain),
      gt: (k: string, v: string) => (filters.push((r) => typeof r[k] === 'string' && (r[k] as string) > v), chain),
      limit: () => chain,
      contains: (k: string, vs: unknown[]) => (filters.push((r) => vs.every((v) => ((r[k] as unknown[] | undefined) ?? ['sms']).includes(v))), chain),
      not: (k: string, o: string, v: unknown) => {
        if (o !== 'is' || v !== null) throw new Error(`fake: not ${o}`)
        return filters.push((r) => r[k] != null), chain
      },
      or: (expr: string) => {
        // The one or() the store sends: invited, or active with the number not yet bound.
        if (expr !== 'state.eq.invited,and(state.eq.active,phone_bound_at.is.null)') throw new Error(`fake: or ${expr}`)
        return filters.push((r) => r.state === 'invited' || (r.state === 'active' && r.phone_bound_at == null)), chain
      },
      order: () => chain,
      single: async () => {
        const { data, error } = await run()
        return { data: data?.[0] ?? null, error: error ?? (data?.length ? null : { message: 'no rows' }) }
      },
      maybeSingle: async () => {
        const { data, error } = await run()
        return { data: data?.[0] ?? null, error }
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
    }
    return chain
  }
  return { from } as unknown as SupabaseClient
}

const OWNER = 'user-owner'
const OTHER_OWNER = 'user-other'
const WS = 'ws-1'
const SAM = '+14155550123'
const KEY = 'test-secret'

let tables: Record<string, Row[]>
let db: SupabaseClient
const saved = process.env.RUN_SKILL_INTERNAL_SECRET

beforeEach(() => {
  process.env.RUN_SKILL_INTERNAL_SECRET = KEY
  tables = { user_phone: [{ user_id: OWNER, phone_e164: '+14155550100', verified_at: '2026-10-01T00:00:00Z' }], agent_guest: [], agent_guest_memory: [], agent_guest_request_code: [] }
  db = fakeDb(tables)
})
afterEach(() => {
  if (saved === undefined) delete process.env.RUN_SKILL_INTERNAL_SECRET
  else process.env.RUN_SKILL_INTERNAL_SECRET = saved
})

const add = (over: Partial<Parameters<typeof createGuest>[1]> = {}) =>
  createGuest(db, { ownerUserId: OWNER, workspaceId: WS, displayName: 'Sam Rivera', phone: '(415) 555-0123', preset: 'household', ...over })

describe('codes', () => {
  it('six characters of the unambiguous alphabet, never a yes or no word', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateGuestCode()
      expect(code).toHaveLength(6)
      expect([...code].every((ch) => CODE_ALPHABET.includes(ch))).toBe(true)
      expect(isYesOrNoWord(code)).toBe(false)
    }
  })

  it('an invite code matches only its own guest and number, in any case', () => {
    const hash = hashInviteCode('K7Q4MX', { guestId: 'g1', phone: SAM }, KEY)
    expect(inviteCodeMatches('k7q4mx', { guestId: 'g1', phone: SAM }, hash, KEY)).toBe(true)
    expect(inviteCodeMatches('K7Q4MX', { guestId: 'g2', phone: SAM }, hash, KEY)).toBe(false)
    expect(inviteCodeMatches('K7Q4MX', { guestId: 'g1', phone: '+14155550999' }, hash, KEY)).toBe(false)
    expect(inviteCodeMatches('K7Q4MX', { guestId: 'g1', phone: SAM }, null, KEY)).toBe(false)
  })

  it('the invite link opens Messages with their first text typed in', () => {
    expect(inviteText('Sam Rivera', 'K7Q4MX')).toBe("Hi, it's Sam · K7Q4MX")
    expect(inviteHref('+14155550000', 'Sam', 'K7Q4MX')).toBe(`sms:+14155550000?&body=${encodeURIComponent("Hi, it's Sam · K7Q4MX")}`)
  })
})

describe('createGuest', () => {
  it('adds an invited person with the preset’s tools and a hashed one-time code', async () => {
    const result = await add()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.guest).toMatchObject({ displayName: 'Sam Rivera', phone: SAM, state: 'invited', preset: 'household', askBefore: ['payments', 'deletes'] })
    expect(result.guest.tools).toContain('run_browser_task')
    const row = tables.agent_guest[0]
    expect(row.invite_code_hash).toBe(hashInviteCode(result.inviteCode, { guestId: row.id as string, phone: SAM }, KEY))
    expect(JSON.stringify(row)).not.toContain(result.inviteCode)
  })

  it('a changed tool list is custom, cleaned, and can always reach the owner', async () => {
    const result = await add({ preset: 'colleague', tools: ['get_free_busy', 'create_flow'] })
    expect(result.ok && result.guest.tools).toEqual(['get_free_busy', ...GUEST_ALWAYS_TOOLS])
    expect(result.ok && result.guest.preset).toBe('custom')
  })

  it('refuses a bad name or number, and outside North America', async () => {
    expect(await add({ displayName: '  ' })).toEqual({ ok: false, reason: 'bad_name' })
    expect(await add({ phone: '12' })).toEqual({ ok: false, reason: 'bad_phone' })
    expect(await add({ phone: '+442071838750' })).toEqual({ ok: false, reason: 'unsupported_country' })
  })

  it('refuses the owner’s own number, anyone’s verified number, and another owner’s active guest', async () => {
    expect(await add({ phone: '+14155550100' })).toEqual({ ok: false, reason: 'own_number' })
    tables.user_phone.push({ user_id: 'user-x', phone_e164: SAM, verified_at: '2026-10-01T00:00:00Z' })
    expect(await add()).toEqual({ ok: false, reason: 'someones_number' })
    tables.user_phone.pop()
    tables.agent_guest.push({ id: 'g-other', owner_user_id: OTHER_OWNER, phone_e164: SAM, state: 'active' })
    expect(await add()).toEqual({ ok: false, reason: 'someones_number' })
  })

  it('refuses listing someone twice, and past the cap', async () => {
    expect((await add()).ok).toBe(true)
    expect(await add()).toEqual({ ok: false, reason: 'already_listed' })
    for (let i = 1; i < GUESTS_PER_OWNER; i++) tables.agent_guest.push({ id: `g${i}`, owner_user_id: OWNER, phone_e164: `+1415555${String(1000 + i)}`, state: 'active' })
    expect(await add({ phone: '+14155559999' })).toEqual({ ok: false, reason: 'too_many' })
  })

  it('does nothing without the code key', async () => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    expect(await add()).toEqual({ ok: false, reason: 'not_configured' })
    expect(tables.agent_guest).toHaveLength(0)
  })
})

describe('changing and removing', () => {
  it('updateGuest changes the tools and asks, and the preset follows', async () => {
    const made = await add()
    if (!made.ok) throw new Error('setup')
    const turnedOff = await updateGuest(db, OWNER, made.guest.id, { askBefore: ['payments'] })
    expect(turnedOff.ok && turnedOff.guest).toMatchObject({ askBefore: ['payments'], preset: 'custom' })
    const back = await updateGuest(db, OWNER, made.guest.id, { askBefore: ['payments', 'deletes'], notes: '  Prefers texts after 6pm  ' })
    expect(back.ok && back.guest).toMatchObject({ preset: 'household', notes: 'Prefers texts after 6pm' })
  })

  it('another owner can’t touch them', async () => {
    const made = await add()
    if (!made.ok) throw new Error('setup')
    expect(await updateGuest(db, OTHER_OWNER, made.guest.id, { displayName: 'X' })).toEqual({ ok: false, reason: 'not_found' })
    expect(await removeGuest(db, OTHER_OWNER, made.guest.id)).toEqual({ ok: false, reason: 'wrong_state' })
    expect(tables.agent_guest[0].state).toBe('invited')
  })

  it('renewInvite replaces the code while they haven’t texted yet', async () => {
    const made = await add()
    if (!made.ok) throw new Error('setup')
    const renewed = await renewInvite(db, OWNER, made.guest.id)
    expect(renewed.ok).toBe(true)
    if (!renewed.ok) return
    const row = tables.agent_guest[0]
    expect(inviteCodeMatches(renewed.inviteCode, { guestId: made.guest.id, phone: SAM }, row.invite_code_hash as string, KEY)).toBe(true)
    if (renewed.inviteCode !== made.inviteCode) {
      expect(inviteCodeMatches(made.inviteCode, { guestId: made.guest.id, phone: SAM }, row.invite_code_hash as string, KEY)).toBe(false)
    }
    // Active with every channel bound: nothing left to invite to.
    row.state = 'active'
    row.phone_bound_at = '2026-10-24T00:00:00Z'
    expect(await renewInvite(db, OWNER, made.guest.id)).toEqual({ ok: false, reason: 'wrong_state' })
  })

  it('approveRequest makes a request active with the preset, and only a request', async () => {
    tables.agent_guest.push({ id: 'g-req', owner_user_id: OWNER, workspace_id: WS, display_name: 'Jason', phone_e164: '+14155550188', preset: 'custom', tools: [], ask_before: ['payments', 'deletes', 'changes'], state: 'requested', created_at: '2026-10-24T00:00:00Z', opted_out_at: null })
    const approved = await approveRequest(db, OWNER, 'g-req', 'colleague')
    expect(approved.ok && approved.guest).toMatchObject({ state: 'active', preset: 'colleague', tools: ['get_free_busy', 'create_calendar_event', ...GUEST_ALWAYS_TOOLS] })
    expect(await approveRequest(db, OWNER, 'g-req', 'household')).toEqual({ ok: false, reason: 'wrong_state' })
  })

  it('removeGuest ends access, clears the invite and deletes what their agent learned', async () => {
    const made = await add()
    if (!made.ok) throw new Error('setup')
    tables.agent_guest_memory.push({ id: 'm1', guest_id: made.guest.id, owner_user_id: OWNER, kind: 'preference', text: 'Likes window seats' })
    tables.agent_guest_memory.push({ id: 'm2', guest_id: 'someone-else', owner_user_id: OWNER, kind: 'fact', text: 'Other' })
    const removed = await removeGuest(db, OWNER, made.guest.id)
    expect(removed.ok && removed.guest.state).toBe('removed')
    expect(tables.agent_guest[0].invite_code_hash).toBeNull()
    expect(tables.agent_guest_memory.map((m) => m.id)).toEqual(['m2'])
    expect(await listGuests(db, OWNER)).toEqual([])
    expect(await listGuests(db, OWNER, { includeRemoved: true })).toHaveLength(1)
    // They can be added again later.
    expect((await add()).ok).toBe(true)
  })
})

describe('the request code', () => {
  it('is made once, closed until opened, and toggles', async () => {
    const first = await requestCode(db, OWNER, WS)
    expect(first?.open).toBe(false)
    expect(first?.code).toMatch(/^[ACDEFGHJKMNPQRTUVWXY34679]{6}$/)
    expect((await requestCode(db, OWNER, WS))?.code).toBe(first?.code)
    expect(await setRequestsOpen(db, OWNER, WS, true)).toEqual({ code: first?.code, open: true })
    expect(await setRequestsOpen(db, OWNER, WS, false)).toEqual({ code: first?.code, open: false })
    expect(tables.agent_guest_request_code).toHaveLength(1)
  })
})

describe('channels (migration 434)', () => {
  it('Text by default; Slack only needs no number; Text needs one; at least one channel', async () => {
    const text = await add()
    expect(text.ok && text.guest.channels).toEqual(['sms'])
    const slack = await add({ displayName: 'Priya', phone: null, channels: ['slack'] })
    expect(slack.ok && slack.guest).toMatchObject({ channels: ['slack'], phone: null })
    expect(await add({ displayName: 'Marco', phone: '', channels: ['sms', 'slack'] })).toEqual({ ok: false, reason: 'bad_phone' })
    expect(await add({ displayName: 'Marco', phone: '(415) 555-0124', channels: ['dial8'] })).toEqual({ ok: false, reason: 'bad_channels' })
  })

  it('a text reaches only a guest on Text whose number is proven theirs', async () => {
    tables.agent_guest.push({ id: 'g1', owner_user_id: OWNER, workspace_id: WS, display_name: 'Sam', phone_e164: SAM, channels: ['sms'], state: 'active', phone_bound_at: null, created_at: '' })
    expect(await findActiveGuestByPhone(db, SAM)).toBeNull()
    tables.agent_guest[0].phone_bound_at = '2026-10-24T00:00:00Z'
    expect((await findActiveGuestByPhone(db, SAM))?.id).toBe('g1')
    tables.agent_guest[0].channels = ['slack']
    expect(await findActiveGuestByPhone(db, SAM)).toBeNull()
  })

  it('on both: the first text binds the number and keeps the code for Slack; the code is spent once both are bound', async () => {
    const made = await add({ channels: ['sms', 'slack'] })
    if (!made.ok) throw new Error('setup')
    const open = await findOpenInvitesByPhone(db, SAM)
    expect(open.map((o) => o.guest.id)).toEqual([made.guest.id])
    const activated = await activateInvitedGuest(db, made.guest)
    expect(activated.ok && activated.guest).toMatchObject({ state: 'active' })
    expect(tables.agent_guest[0].phone_bound_at).toBeTruthy()
    expect(tables.agent_guest[0].invite_code_hash).toBeTruthy()
    // Number bound: no more invites to it.
    expect(await findOpenInvitesByPhone(db, SAM)).toEqual([])

    const textOnly = await add({ displayName: 'Marco', phone: '(415) 555-0124' })
    if (!textOnly.ok) throw new Error('setup')
    await activateInvitedGuest(db, textOnly.guest)
    expect(tables.agent_guest[1].invite_code_hash).toBeNull()
  })

  it('in on Slack first: their number still binds with the code', async () => {
    const made = await add({ channels: ['sms', 'slack'] })
    if (!made.ok) throw new Error('setup')
    Object.assign(tables.agent_guest[0], { state: 'active', slack_team_id: 'T1', slack_user_id: 'U1', activated_at: '2026-10-24T00:00:00Z' })
    expect((await findOpenInvitesByPhone(db, SAM)).map((o) => o.guest.id)).toEqual([made.guest.id])
    const bound = await activateInvitedGuest(db, { ...made.guest, state: 'active', slackUserId: 'U1' })
    expect(bound.ok).toBe(true)
    expect(tables.agent_guest[0].invite_code_hash).toBeNull()
    expect(tables.agent_guest[0].activated_at).toBe('2026-10-24T00:00:00Z')
  })

  it('updateGuest: Text needs a number; taking a channel away forgets its binding', async () => {
    const made = await add({ displayName: 'Priya', phone: null, channels: ['slack'] })
    if (!made.ok) throw new Error('setup')
    expect(await updateGuest(db, OWNER, made.guest.id, { channels: ['sms', 'slack'] })).toEqual({ ok: false, reason: 'bad_phone' })
    const both = await updateGuest(db, OWNER, made.guest.id, { channels: ['sms', 'slack'], phone: '(415) 555-0125' })
    expect(both.ok && both.guest).toMatchObject({ channels: ['sms', 'slack'], phone: '+14155550125' })
    Object.assign(tables.agent_guest[0], { slack_team_id: 'T1', slack_user_id: 'U1', phone_bound_at: '2026-10-24T00:00:00Z' })
    const textOnly = await updateGuest(db, OWNER, made.guest.id, { channels: ['sms'] })
    expect(textOnly.ok && textOnly.guest).toMatchObject({ channels: ['sms'], slackUserId: null, slackTeamId: null })
    const slackOnly = await updateGuest(db, OWNER, made.guest.id, { channels: ['slack'] })
    expect(slackOnly.ok && slackOnly.guest.phoneBoundAt).toBeNull()
    expect(await updateGuest(db, OWNER, made.guest.id, { channels: [] })).toEqual({ ok: false, reason: 'bad_channels' })
  })
})

describe('calendar emails (migration 455)', () => {
  it('cleanCalendarEmails: trimmed, lower case, each once, empty entries dropped; a non-address or a sixth is refused', () => {
    expect(cleanCalendarEmails(['  Jess@Gmail.com ', 'jess@gmail.com', '', 'jess.work@acme.co.uk'])).toEqual(['jess@gmail.com', 'jess.work@acme.co.uk'])
    expect(cleanCalendarEmails([])).toEqual([])
    for (const bad of ['jess', 'jess@', '@gmail.com', 'jess@gmail', 'jess @gmail.com', 'a,b@x.com', 'jess@gmail.com>']) expect(cleanCalendarEmails([bad]), bad).toBeNull()
    expect(cleanCalendarEmails([7])).toBeNull()
    const six = Array.from({ length: GUEST_CALENDAR_EMAILS_MAX + 1 }, (_, i) => `k${i}@x.com`)
    expect(cleanCalendarEmails(six)).toBeNull()
    expect(cleanCalendarEmails([...six.slice(0, GUEST_CALENDAR_EMAILS_MAX), six[0].toUpperCase()])).toHaveLength(GUEST_CALENDAR_EMAILS_MAX)
  })

  it('cleanCalendarEmails stops the moment the list passes the cap, refuses an oversized raw list unread, and an entry too long to be an address', () => {
    // A sixth address, then junk: refused at the sixth, the junk never read.
    const reads: number[] = []
    const watched = new Proxy([...Array.from({ length: 6 }, (_, i) => `k${i}@x.com`), 'not an address'], {
      get: (target, key, receiver) => {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads.push(Number(key))
        return Reflect.get(target, key, receiver)
      },
    })
    expect(cleanCalendarEmails(watched)).toBeNull()
    expect(Math.max(...reads)).toBe(GUEST_CALENDAR_EMAILS_MAX)
    // Blanks and repeats a paste carries are fine within the raw cap; past it, nothing is read.
    expect(cleanCalendarEmails(['jess@gmail.com', ...Array(GUEST_CALENDAR_EMAILS_RAW_MAX - 1).fill('')])).toEqual(['jess@gmail.com'])
    const huge = new Proxy(Array(GUEST_CALENDAR_EMAILS_RAW_MAX + 1).fill('jess@gmail.com'), {
      get: (target, key, receiver) => {
        if (typeof key === 'string' && /^\d+$/.test(key)) throw new Error('read an entry')
        return Reflect.get(target, key, receiver)
      },
    })
    expect(cleanCalendarEmails(huge)).toBeNull()
    expect(cleanCalendarEmails([`${'a'.repeat(400)}@x.com`])).toBeNull()
  })

  it('updateGuest stores the cleaned list and reads it back; a bad one changes nothing', async () => {
    const made = await add()
    if (!made.ok) throw new Error('setup')
    expect(made.guest.calendarEmails).toEqual([])
    const saved = await updateGuest(db, OWNER, made.guest.id, { calendarEmails: [' Jess@Gmail.com', 'jess@gmail.com'] })
    expect(saved.ok && saved.guest.calendarEmails).toEqual(['jess@gmail.com'])
    expect(tables.agent_guest[0].calendar_emails).toEqual(['jess@gmail.com'])
    expect(await updateGuest(db, OWNER, made.guest.id, { calendarEmails: ['not an address'] })).toEqual({ ok: false, reason: 'bad_calendar_emails' })
    expect(tables.agent_guest[0].calendar_emails).toEqual(['jess@gmail.com'])
    const cleared = await updateGuest(db, OWNER, made.guest.id, { calendarEmails: [] })
    expect(cleared.ok && cleared.guest.calendarEmails).toEqual([])
    // A patch without them leaves them alone.
    await updateGuest(db, OWNER, made.guest.id, { calendarEmails: ['jess@gmail.com'] })
    await updateGuest(db, OWNER, made.guest.id, { notes: 'My wife' })
    expect(tables.agent_guest[0].calendar_emails).toEqual(['jess@gmail.com'])
  })

  it('a stored list is read cleaned (strings, addresses, each once)', async () => {
    tables.agent_guest.push({ id: 'g-old', owner_user_id: OWNER, workspace_id: WS, display_name: 'Jess', phone_e164: null, channels: ['slack'], preset: 'household', tools: [], ask_tools: [], ask_before: [], notes: null, state: 'active', calendar_emails: ['JESS@gmail.com', 3, 'nope', 'jess@gmail.com'] })
    const [jess] = await listGuests(db, OWNER)
    expect(jess.calendarEmails).toEqual(['jess@gmail.com'])
  })
})

describe('trustedGuestEmails', () => {
  const withAuth = (users: Record<string, string | null>, fail: Set<string> = new Set()) =>
    ({
      from: (db as unknown as { from: unknown }).from,
      auth: {
        admin: {
          getUserById: async (id: string) => {
            if (fail.has(id)) throw new Error('auth down')
            return { data: { user: id in users ? { id, email: users[id] } : null }, error: null }
          },
        },
      },
    }) as unknown as SupabaseClient
  const guestRow = (over: Row) => ({ owner_user_id: OWNER, workspace_id: WS, display_name: 'G', channels: ['sms'], preset: 'household', state: 'active', calendar_emails: [], ...over })

  it('a linked peer who shares a workspace with the owner (a teammate) adds nothing: only an outside link’s sign-in address counts', async () => {
    tables.connected_account = []
    tables.member = [
      { user_id: OWNER, workspace_id: WS },
      { user_id: 'user-sam', workspace_id: WS },
      { user_id: 'user-jess', workspace_id: 'ws-jess' },
    ]
    tables.agent_guest.push(
      guestRow({ id: 'sam', peer_user_id: 'user-sam', peer_bound_at: '2026-10-25T00:00:00Z', channels: ['dial8'] }),
      guestRow({ id: 'jess', peer_user_id: 'user-jess', peer_bound_at: '2026-10-25T00:00:00Z', channels: ['dial8'] }),
    )
    const lookedUp: string[] = []
    const client = withAuth({ 'user-sam': 'sam@dial8.ai', 'user-jess': 'jess@gmail.com' })
    const getUserById = (client as unknown as { auth: { admin: { getUserById: (id: string) => Promise<unknown> } } }).auth.admin.getUserById
    ;(client as unknown as { auth: { admin: { getUserById: (id: string) => Promise<unknown> } } }).auth.admin.getUserById = (id) => (lookedUp.push(id), getUserById(id))
    expect([...(await trustedGuestEmails(client, OWNER))]).toEqual(['jess@gmail.com'])
    // The teammate's address is never even looked up.
    expect(lookedUp).toEqual(['user-jess'])
  })

  it('a failed membership read adds no linked peer; lookups are bounded in number and in time', async () => {
    tables.connected_account = []
    tables.agent_guest.push(
      guestRow({ id: 'jess', calendar_emails: ['jess@gmail.com'] }),
      ...Array.from({ length: 5 }, (_, i) => guestRow({ id: `p${i}`, peer_user_id: `user-p${i}`, peer_bound_at: '2026-10-25T00:00:00Z', channels: ['dial8'] })),
    )
    const users = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`user-p${i}`, `p${i}@outside.example`]))
    const broken = {
      from: (table: string) => (table === 'member' ? { select: () => ({ in: async () => ({ data: null, error: { message: 'down' } }) }) } : (db as unknown as { from: (t: string) => unknown }).from(table)),
      auth: (withAuth(users) as unknown as { auth: unknown }).auth,
    } as unknown as SupabaseClient
    expect([...(await trustedGuestEmails(broken, OWNER))]).toEqual(['jess@gmail.com'])
    tables.member = [{ user_id: OWNER, workspace_id: WS }]
    const got = await trustedGuestEmails(withAuth(users), OWNER)
    expect([...got].filter((e) => e.endsWith('@outside.example'))).toHaveLength(TRUSTED_PEER_LOOKUPS_MAX)
    // Lookups that hang are dropped together; the listed addresses still count.
    vi.useFakeTimers()
    try {
      const hanging = {
        from: (db as unknown as { from: unknown }).from,
        auth: { admin: { getUserById: () => new Promise(() => {}) } },
      } as unknown as SupabaseClient
      const pending = trustedGuestEmails(hanging, OWNER)
      await vi.advanceTimersByTimeAsync(TRUSTED_PEER_LOOKUP_MS + 10)
      expect([...(await pending)]).toEqual(['jess@gmail.com'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('active guests’ calendar addresses, plus a linked guest’s own Native Intelligence address; never an invited or removed one’s, another owner’s, or the owner’s own', async () => {
    tables.connected_account = [{ user_id: OWNER, account_email: 'Liam@Dial8.ai' }]
    tables.member = [{ user_id: OWNER, workspace_id: WS }, { user_id: 'user-sam', workspace_id: 'ws-elsewhere' }]
    tables.agent_guest.push(
      guestRow({ id: 'jess', calendar_emails: ['jess@gmail.com', 'JESS@work.example'] }),
      guestRow({ id: 'linked', peer_user_id: 'user-sam', peer_bound_at: '2026-10-25T00:00:00Z', channels: ['dial8'] }),
      guestRow({ id: 'pending-link', peer_user_id: 'user-pending', peer_bound_at: null, channels: ['dial8'] }),
      guestRow({ id: 'invited', state: 'invited', calendar_emails: ['invited@x.com'] }),
      guestRow({ id: 'removed', state: 'removed', calendar_emails: ['removed@x.com'] }),
      guestRow({ id: 'other', owner_user_id: OTHER_OWNER, calendar_emails: ['other@x.com'] }),
      guestRow({ id: 'me-typed', calendar_emails: ['liam@dial8.ai'] }),
    )
    const got = await trustedGuestEmails(withAuth({ 'user-sam': 'Sam@Example.com', 'user-pending': 'pending@example.com' }), OWNER)
    expect([...got].sort()).toEqual(['jess@gmail.com', 'jess@work.example', 'sam@example.com'])
  })

  it('a failed sign-in lookup keeps the listed addresses; a failed guest read is no one', async () => {
    tables.connected_account = []
    tables.member = [{ user_id: OWNER, workspace_id: WS }]
    tables.agent_guest.push(guestRow({ id: 'jess', calendar_emails: ['jess@gmail.com'], peer_user_id: 'user-jess', peer_bound_at: '2026-10-25T00:00:00Z' }))
    expect([...(await trustedGuestEmails(withAuth({}, new Set(['user-jess'])), OWNER))]).toEqual(['jess@gmail.com'])
    const broken = {
      from: () => ({
        select: () => {
          throw new Error('down')
        },
      }),
    } as unknown as SupabaseClient
    expect((await trustedGuestEmails(broken, OWNER)).size).toBe(0)
  })
})
