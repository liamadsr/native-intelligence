/**
 * A person's agent's own number (agent-number.ts): the pool is the messaging
 * service's numbers of Native Intelligence's names that nobody holds; getting one takes the
 * spare longest in the service and never buys; a held number is the sender
 * until carriers refuse it; the balance (one at a time) dates freed numbers,
 * buys up to the target under the cap, and releases only never-held spares or
 * once-held ones past their quarantine; the daily pass takes back idle
 * numbers. Production only. Twilio is a fake routed by URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import {
  DIAL8_FALLBACK_MS,
  FREE_PREFIX,
  HELD_NAME,
  IDLE_RECLAIM_MS,
  MAX_AGENT_NUMBERS,
  RELEASE_QUARANTINE_MS,
  SPARE_NAME,
  agentNumbersAvailable,
  agentSender,
  balanceSpares,
  getAgentNumber,
  holdAgentNumber,
  reclaimIdleAgentNumbers,
} from '../agent-number'

const pn = (n: number) => `PN${String(n).padStart(32, '0')}`
const DIAL8 = '+19287698774'
const SIGNUP = '+19287690000'
const config = { accountSid: 'AC1', authToken: 't', fromNumber: DIAL8, messagingServiceSid: 'MG1' }
const NOW = Date.parse('2026-11-02T12:00:00Z')
const DAY = 24 * 60 * 60_000
const TODAY = '2026-11-02'

type Row = Record<string, unknown>
type Pooled = { sid: string; phone_number: string; date_created: string; name?: string }
let tables: Record<string, Row[]>
let pool: Pooled[]
let addToServiceOk: boolean
let available: string[]
let bought: number
const calls: Array<{ method: string; url: string; form: URLSearchParams }> = []
const requestBalance = vi.fn(async () => {})

const fetchFake = vi.fn(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET'
  const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
  calls.push({ method, url, form })
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  if (url.startsWith('https://messaging.twilio.com/v1/Services/MG1/PhoneNumbers')) {
    if (method === 'GET') return json({ phone_numbers: pool.map(({ sid, phone_number, date_created }) => ({ sid, phone_number, date_created })) })
    if (!addToServiceOk) return json({ code: 21712 }, 400)
    const sid = form.get('PhoneNumberSid')!
    const added = pool.find((p) => p.sid === sid)!
    added.date_created = new Date(NOW).toISOString()
    return json({ sid }, 201)
  }
  if (url.endsWith('/IncomingPhoneNumbers.json?PageSize=1000')) return json({ incoming_phone_numbers: pool.map((p) => ({ sid: p.sid, friendly_name: p.name ?? 'Bought by hand' })) })
  if (url.includes('/IncomingPhoneNumbers.json?PhoneNumber=')) return json({ incoming_phone_numbers: [{ sid: pn(1), trunk_sid: 'TK1' }] })
  if (url.includes('/AvailablePhoneNumbers/US/Local.json')) return json({ available_phone_numbers: available.slice(0, 1).map((phone_number) => ({ phone_number })) })
  if (url.endsWith('/IncomingPhoneNumbers.json') && method === 'POST') {
    const sid = pn(900 + bought++)
    // In the account, not yet in the service (its date is set when it's added).
    pool.push({ sid, phone_number: available.shift()!, date_created: '', name: form.get('FriendlyName')! })
    return json({ sid }, 201)
  }
  const one = /\/IncomingPhoneNumbers\/(PN\d+)\.json$/.exec(url)
  if (one && method === 'DELETE') {
    pool = pool.filter((p) => p.sid !== one[1])
    return new Response(null, { status: 204 })
  }
  if (one && method === 'POST') {
    const p = pool.find((x) => x.sid === one[1])
    if (p && form.get('FriendlyName')) p.name = form.get('FriendlyName')!
    return json({ sid: one[1] })
  }
  return json({ message: 'not found' }, 404)
})

const deps = () => ({ fetch: fetchFake as never, config, now: () => NOW, webhookUrl: 'https://dial8.ai/api/twilio/sms', production: true, requestBalance })
const db = () => memoryDb(tables, { agent_phone_number: (a, b) => a.user_id === b.user_id || a.phone_e164 === b.phone_e164 })
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const day = (msAgo: number) => at(msAgo).slice(0, 10)
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.url.endsWith(path))

beforeEach(() => {
  vi.stubEnv('TWILIO_SIGNUP_NUMBER', SIGNUP)
  tables = { agent_phone_number: [], business_phone_number: [], user_phone: [], sms_message: [] }
  pool = [
    { sid: pn(1), phone_number: DIAL8, date_created: at(90 * DAY), name: 'Native Intelligence' },
    { sid: pn(2), phone_number: SIGNUP, date_created: at(80 * DAY), name: SPARE_NAME },
    { sid: pn(3), phone_number: '+16465550103', date_created: at(2 * DAY), name: SPARE_NAME },
    { sid: pn(4), phone_number: '+16465550104', date_created: at(5 * DAY), name: SPARE_NAME },
    // Added to the service by hand: never Native Intelligence's to give or release.
    { sid: pn(5), phone_number: '+16465550105', date_created: at(60 * DAY) },
  ]
  addToServiceOk = true
  available = ['+16465550900', '+16465550901', '+16465550902']
  bought = 0
  calls.length = 0
  fetchFake.mockClear()
  requestBalance.mockClear()
})
afterEach(() => vi.unstubAllEnvs())

describe('where there is a pool', () => {
  it('production only, with a messaging service and the Native Intelligence number', () => {
    expect(agentNumbersAvailable(deps())).toBe(true)
    expect(agentNumbersAvailable({ ...deps(), production: false })).toBe(false)
    expect(agentNumbersAvailable({ ...deps(), config: { ...config, messagingServiceSid: null } })).toBe(false)
    expect(agentNumbersAvailable({ ...deps(), config: { ...config, fromNumber: null } })).toBe(false)
  })
})

describe('getAgentNumber', () => {
  it('off production, nothing is read or handed out (the Twilio account is shared)', async () => {
    expect(await getAgentNumber(db(), { userId: 'u1' }, { ...deps(), production: false })).toEqual({ ok: false, reason: 'not_configured' })
    expect(fetchFake).not.toHaveBeenCalled()
  })

  it('the number it has, without asking Twilio', async () => {
    tables.agent_phone_number.push({ user_id: 'u1', phone_e164: '+16465550103', twilio_sid: pn(3), dial8_until: null, created_at: at(DAY) })
    expect(await getAgentNumber(db(), { userId: 'u1' }, deps())).toMatchObject({ ok: true, fresh: false, number: { phone: '+16465550103' } })
    expect(fetchFake).not.toHaveBeenCalled()
  })

  it('the spare longest in the service, of Native Intelligence’s names only: never the Native Intelligence, sign-up or hand-added number', async () => {
    const got = await getAgentNumber(db(), { userId: 'u1' }, deps())
    expect(got).toMatchObject({ ok: true, fresh: true, number: { phone: '+16465550104', twilioSid: pn(4), userId: 'u1' } })
    expect(tables.agent_phone_number).toHaveLength(1)
  })

  it('names it held and gives it the Native Intelligence number’s webhooks, its trunk too; asks for a replacement; never buys', async () => {
    await getAgentNumber(db(), { userId: 'u1' }, deps())
    expect(Object.fromEntries(posts(`/IncomingPhoneNumbers/${pn(4)}.json`)[0].form)).toEqual({ FriendlyName: HELD_NAME, SmsUrl: 'https://dial8.ai/api/twilio/sms', SmsMethod: 'POST', TrunkSid: 'TK1' })
    expect(requestBalance).toHaveBeenCalledTimes(1)
    expect(posts('/IncomingPhoneNumbers.json')).toHaveLength(0)
  })

  it('skips numbers people or businesses hold; a spare someone took first is skipped too', async () => {
    tables.agent_phone_number.push({ user_id: 'u2', phone_e164: '+16465550104', twilio_sid: pn(4), dial8_until: null, created_at: at(DAY) })
    expect(await getAgentNumber(db(), { userId: 'u1' }, deps())).toMatchObject({ ok: true, number: { phone: '+16465550103' } })
    tables.business_phone_number.push({ phone_e164: '+16465550103', state: 'active' })
    tables.agent_phone_number = tables.agent_phone_number.filter((r) => r.user_id !== 'u1')
    expect(await getAgentNumber(db(), { userId: 'u1' }, deps())).toEqual({ ok: false, reason: 'none_ready' })
  })

  it('a spare taken between the read and the claim: the next one', async () => {
    const shared = db()
    const from = shared.from.bind(shared)
    let raced = false
    ;(shared as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      // u2 takes +16465550104 just as u1's claim is written.
      if (t === 'agent_phone_number' && !raced && calls.some((c) => c.url.endsWith('/IncomingPhoneNumbers.json?PageSize=1000')) && tables.agent_phone_number.length === 0) {
        raced = true
        tables.agent_phone_number.push({ user_id: 'u2', phone_e164: '+16465550104', twilio_sid: pn(4), dial8_until: null, created_at: at(0) })
      }
      return from(t)
    }
    expect(await getAgentNumber(shared, { userId: 'u1' }, deps())).toMatchObject({ ok: true, fresh: true, number: { phone: '+16465550103' } })
  })

  it('no spare: asks for one and says none is ready, buying nothing itself', async () => {
    pool = pool.filter((p) => p.name !== SPARE_NAME || p.phone_number === SIGNUP)
    expect(await getAgentNumber(db(), { userId: 'u1' }, deps())).toEqual({ ok: false, reason: 'none_ready' })
    expect(requestBalance).toHaveBeenCalledTimes(1)
    expect(calls.some((c) => c.url.includes('AvailablePhoneNumbers'))).toBe(false)
  })

  it('a service without the Native Intelligence number hands nothing out (every other text is pinned to it)', async () => {
    pool = pool.filter((p) => p.phone_number !== DIAL8)
    expect(await getAgentNumber(db(), { userId: 'u1' }, deps())).toEqual({ ok: false, reason: 'twilio_refused' })
    expect(tables.agent_phone_number).toHaveLength(0)
  })

  it(`refuses at ${MAX_AGENT_NUMBERS} numbers held`, async () => {
    for (let i = 0; i < MAX_AGENT_NUMBERS; i++) tables.agent_phone_number.push({ user_id: `x${i}`, phone_e164: `+1212555${String(i).padStart(4, '0')}`, twilio_sid: pn(i + 100), created_at: at(DAY) })
    expect(await getAgentNumber(db(), { userId: 'u1' }, deps())).toEqual({ ok: false, reason: 'limit' })
  })
})

describe('agentSender', () => {
  it('the number while carriers take it; the Native Intelligence number (null) for a while after they refused it', async () => {
    tables.agent_phone_number.push({ user_id: 'u1', phone_e164: '+16465550104', twilio_sid: pn(4), dial8_until: null, created_at: at(DAY) })
    expect(await agentSender(db(), 'u1', NOW)).toBe('+16465550104')
    expect(await holdAgentNumber(db(), '+16465550104', NOW)).toBe(true)
    expect(tables.agent_phone_number[0].dial8_until).toBe(new Date(NOW + DIAL8_FALLBACK_MS).toISOString())
    expect(await agentSender(db(), 'u1', NOW + 1000)).toBeNull()
    expect(await agentSender(db(), 'u1', NOW + DIAL8_FALLBACK_MS + 1)).toBe('+16465550104')
  })

  it('none, or a failed read: the Native Intelligence number', async () => {
    expect(await agentSender(db(), 'u1', NOW)).toBeNull()
    const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }) }) }) }
    expect(await agentSender(broken as never, 'u1', NOW)).toBeNull()
  })

  it('holding a number nobody holds says so', async () => {
    expect(await holdAgentNumber(db(), '+16465550104', NOW)).toBe(false)
  })
})

describe('reclaimIdleAgentNumbers', () => {
  const held = (user: string, phone: string, ageMs: number) => tables.agent_phone_number.push({ user_id: user, phone_e164: phone, twilio_sid: pn(Number(phone.slice(-3))), dial8_until: null, created_at: at(ageMs) })
  const texted = (phone: string, agoMs: number) => tables.sms_message.push({ direction: 'in', phone_e164: phone, created_at: at(agoMs) })

  it('takes back a number not texted in 30 days, or never; keeps one texted lately, or got lately', async () => {
    held('quiet', '+16465550101', 40 * DAY)
    tables.user_phone.push({ user_id: 'quiet', phone_e164: '+14155550001', verified_at: at(40 * DAY) })
    texted('+14155550001', 31 * DAY)
    held('never-linked', '+16465550102', 31 * DAY)
    held('busy', '+16465550103', 60 * DAY)
    tables.user_phone.push({ user_id: 'busy', phone_e164: '+14155550003', verified_at: at(60 * DAY) })
    texted('+14155550003', 2 * DAY)
    held('new', '+16465550104', IDLE_RECLAIM_MS - DAY)
    expect((await reclaimIdleAgentNumbers(db(), { now: () => NOW })).sort()).toEqual(['never-linked', 'quiet'])
    expect(tables.agent_phone_number.map((r) => r.user_id).sort()).toEqual(['busy', 'new'])
  })

  it('their own texts only: another number texting in, or texts out, keep nothing alive', async () => {
    held('quiet', '+16465550101', 40 * DAY)
    tables.user_phone.push({ user_id: 'quiet', phone_e164: '+14155550001', verified_at: at(40 * DAY) })
    texted('+14155559999', DAY)
    tables.sms_message.push({ direction: 'out', phone_e164: '+14155550001', created_at: at(DAY) })
    expect(await reclaimIdleAgentNumbers(db(), { now: () => NOW })).toEqual(['quiet'])
  })
})

describe('balanceSpares', () => {
  it('off production, nothing at all', async () => {
    expect(await balanceSpares(db(), { release: true }, { ...deps(), production: false })).toEqual({ spares: 0, bought: 0, released: 0 })
    expect(fetchFake).not.toHaveBeenCalled()
  })

  it('short of the target: buys spares, named as never held, into the service', async () => {
    pool = pool.filter((p) => p.sid !== pn(3) && p.sid !== pn(4))
    expect(await balanceSpares(db(), { release: false }, deps())).toEqual({ spares: 2, bought: 2, released: 0 })
    expect(posts('/IncomingPhoneNumbers.json').map((c) => [c.form.get('FriendlyName'), c.form.get('TrunkSid')])).toEqual([
      [SPARE_NAME, 'TK1'],
      [SPARE_NAME, 'TK1'],
    ])
    expect(calls.filter((c) => c.method === 'POST' && c.url.includes('messaging.twilio.com')).map((c) => c.form.get('PhoneNumberSid'))).toEqual([pn(900), pn(901)])
  })

  it('never grows the pool past the numbers cap and the target', async () => {
    pool = pool.filter((p) => p.sid !== pn(3) && p.sid !== pn(4))
    for (let i = 0; i < MAX_AGENT_NUMBERS + 1; i++) {
      const phone = `+1212555${String(i).padStart(4, '0')}`
      pool.push({ sid: pn(i + 100), phone_number: phone, date_created: at(DAY), name: HELD_NAME })
      tables.agent_phone_number.push({ user_id: `x${i}`, phone_e164: phone, twilio_sid: pn(i + 100), created_at: at(DAY) })
    }
    expect((await balanceSpares(db(), { release: false }, deps())).bought).toBe(1)
  })

  it('a number bought but refused by the service is released: one outside the pool can’t send', async () => {
    pool = pool.filter((p) => p.sid !== pn(3) && p.sid !== pn(4))
    addToServiceOk = false
    expect((await balanceSpares(db(), { release: false }, deps())).bought).toBe(0)
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([expect.stringContaining(`/IncomingPhoneNumbers/${pn(900)}.json`)])
  })

  it('a spare named held belongs to nobody now: dated as freed today', async () => {
    pool[3].name = HELD_NAME
    await balanceSpares(db(), { release: true }, deps())
    expect(pool.find((p) => p.sid === pn(4))!.name).toBe(`${FREE_PREFIX}${TODAY}`)
  })

  it('handed out, taken back, and never released inside its quarantine (its old holder may still text it)', async () => {
    // u1 gets +16465550104, goes quiet, and it is taken back.
    await getAgentNumber(db(), { userId: 'u1' }, deps())
    tables.agent_phone_number[0].created_at = at(40 * DAY)
    expect(await reclaimIdleAgentNumbers(db(), { now: () => NOW })).toEqual(['u1'])
    pool.push({ sid: pn(6), phone_number: '+16465550106', date_created: at(DAY), name: SPARE_NAME }, { sid: pn(7), phone_number: '+16465550107', date_created: at(DAY / 2), name: SPARE_NAME })
    // Spares: pn(4) (longest), pn(3), pn(6), pn(7). The two longest stay; the newest never-held go.
    expect(await balanceSpares(db(), { release: true }, deps())).toEqual({ spares: 2, bought: 0, released: 2 })
    expect(pool.find((p) => p.sid === pn(4))!.name).toBe(`${FREE_PREFIX}${TODAY}`)
    // Past the target and once held, but freed lately: kept.
    pool.find((p) => p.sid === pn(3))!.date_created = at(30 * DAY)
    pool.push({ sid: pn(8), phone_number: '+16465550108', date_created: at(DAY), name: `${FREE_PREFIX}${day(10 * DAY)}` })
    expect((await balanceSpares(db(), { release: true }, deps())).released).toBe(0)
    // Freed longer ago than the quarantine: released.
    pool.find((p) => p.sid === pn(8))!.name = `${FREE_PREFIX}${day(RELEASE_QUARANTINE_MS + DAY)}`
    expect((await balanceSpares(db(), { release: true }, deps())).released).toBe(1)
    expect(pool.some((p) => p.sid === pn(8))).toBe(false)
    // The hand-added number was never touched.
    expect(calls.some((c) => c.url.includes(pn(5)))).toBe(false)
  })

  it('a rename that failed at hand-out is put right, so the held number never reads as releasable', async () => {
    const failRename = fetchFake.getMockImplementation()!
    fetchFake.mockImplementationOnce(failRename) // the service list
    fetchFake.mockImplementationOnce(failRename) // the account's names
    fetchFake.mockImplementationOnce(failRename) // the Native Intelligence number's voice
    fetchFake.mockImplementationOnce(async () => new Response('{}', { status: 503 })) // the rename to held
    expect(await getAgentNumber(db(), { userId: 'u1' }, deps())).toMatchObject({ ok: true, number: { phone: '+16465550104' } })
    expect(pool.find((p) => p.sid === pn(4))!.name).toBe(SPARE_NAME)
    await balanceSpares(db(), { release: true }, deps())
    expect(pool.find((p) => p.sid === pn(4))!.name).toBe(HELD_NAME)
    expect(pool.some((p) => p.sid === pn(4))).toBe(true)
  })

  it('a spare named held but claimed since the pool was read is not dated as freed', async () => {
    pool[3].name = HELD_NAME
    const shared = db()
    const from = shared.from.bind(shared)
    ;(shared as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      if (t === 'agent_phone_number' && calls.some((c) => c.url.endsWith('/IncomingPhoneNumbers.json?PageSize=1000')) && tables.agent_phone_number.length === 0) {
        tables.agent_phone_number.push({ user_id: 'u9', phone_e164: '+16465550104', twilio_sid: pn(4), created_at: at(0) })
      }
      return from(t)
    }
    await balanceSpares(shared, { release: true }, deps())
    expect(pool.find((p) => p.sid === pn(4))!.name).toBe(HELD_NAME)
  })

  it('never releases a number someone took since the pool was read', async () => {
    pool.push({ sid: pn(6), phone_number: '+16465550106', date_created: at(DAY), name: SPARE_NAME })
    const shared = db()
    const from = shared.from.bind(shared)
    ;(shared as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      // u9 claims +16465550106 after the pool read, before the release.
      if (t === 'agent_phone_number' && calls.some((c) => c.url.endsWith('/IncomingPhoneNumbers.json?PageSize=1000')) && tables.agent_phone_number.length === 0) {
        tables.agent_phone_number.push({ user_id: 'u9', phone_e164: '+16465550106', twilio_sid: pn(6), created_at: at(0) })
      }
      return from(t)
    }
    expect((await balanceSpares(shared, { release: true }, deps())).released).toBe(0)
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('without release (after a claim): nothing given back', async () => {
    pool.push({ sid: pn(6), phone_number: '+16465550106', date_created: at(DAY), name: SPARE_NAME })
    expect(await balanceSpares(db(), { release: false }, deps())).toEqual({ spares: 3, bought: 0, released: 0 })
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })
})
