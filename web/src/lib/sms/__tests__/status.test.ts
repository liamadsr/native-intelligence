/**
 * A text's outcome (status.ts): one carriers refused from an agent number as
 * not yet registered holds the number and is resent from the Native Intelligence number,
 * once; anything else is left alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { NI_FALLBACK_MS } from '../agent-number'
import { handleSmsStatus } from '../status'
import type { SendSmsDeps, SendSmsResult } from '@/lib/twilio/client'

const AGENT = '+16465550104'
const PERSON = '+14155551234'
const NOW = Date.parse('2026-11-02T12:00:00Z')
const config = { accountSid: 'AC1', authToken: 't', fromNumber: '+19287698774', messagingServiceSid: 'MG1' }

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let bodyOk: boolean
const fetchFake = vi.fn(async (url: string) =>
  bodyOk && url.endsWith('/Messages/SM1.json') ? new Response(JSON.stringify({ sid: 'SM1', body: 'You have 3 meetings today.' })) : new Response('{}', { status: 404 }),
)
const send = vi.fn(async (_to: string, _body: string, _deps?: SendSmsDeps): Promise<SendSmsResult> => ({ ok: true, sid: 'SM2' }))
const db = () => memoryDb(tables, { sms_message: (a, b) => a.resend_of != null && a.resend_of === b.resend_of })
const deps = () => ({ fetch: fetchFake as never, config, send, now: () => NOW })
const refused = { sid: 'SM1', status: 'failed', errorCode: 30035, from: AGENT, to: PERSON }

beforeEach(() => {
  tables = {
    agent_phone_number: [{ user_id: 'u1', phone_e164: AGENT, twilio_sid: 'PN1', dial8_until: null }],
    sms_message: [{ direction: 'out', kind: 'reply', phone_e164: PERSON, user_id: 'u1', twilio_sid: 'SM1' }],
  }
  bodyOk = true
  fetchFake.mockClear()
  send.mockClear()
})

describe('handleSmsStatus', () => {
  it('a text carriers refused as from an unregistered number: held, and resent from the Native Intelligence number once', async () => {
    expect(await handleSmsStatus(db(), refused, deps())).toBe('resent')
    expect(tables.agent_phone_number[0].dial8_until).toBe(new Date(NOW + NI_FALLBACK_MS).toISOString())
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]).toEqual([PERSON, 'You have 3 meetings today.', expect.objectContaining({ config })])
    expect(send.mock.calls[0][2]).not.toHaveProperty('sender')
    expect(tables.sms_message.find((r) => r.resend_of === 'SM1')).toMatchObject({ direction: 'out', kind: 'reply', user_id: 'u1', phone_e164: PERSON, twilio_sid: 'SM2' })
  })

  it('30034 too; a second callback for the same text sends nothing', async () => {
    expect(await handleSmsStatus(db(), { ...refused, errorCode: 30034 }, deps())).toBe('resent')
    expect(await handleSmsStatus(db(), { ...refused, status: 'undelivered', errorCode: 30034 }, deps())).toBe('already_resent')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('any other outcome is left alone', async () => {
    for (const input of [
      { ...refused, status: 'delivered', errorCode: null },
      { ...refused, status: 'sent', errorCode: null },
      { ...refused, errorCode: 30007 },
      { ...refused, errorCode: null },
    ]) {
      expect(await handleSmsStatus(db(), input, deps())).toBe('ignored')
    }
    expect(send).not.toHaveBeenCalled()
    expect(tables.agent_phone_number[0].dial8_until).toBeNull()
  })

  it('from a number nobody holds: nothing resent', async () => {
    expect(await handleSmsStatus(db(), { ...refused, from: '+16465550999' }, deps())).toBe('not_agent_number')
    expect(send).not.toHaveBeenCalled()
  })

  it('before its ledger row was written: still resent, as a notice', async () => {
    tables.sms_message = []
    expect(await handleSmsStatus(db(), refused, deps())).toBe('resent')
    expect(tables.sms_message[0]).toMatchObject({ kind: 'notice', user_id: null, resend_of: 'SM1' })
  })

  it('words not read back: not resent, and never tried again', async () => {
    bodyOk = false
    expect(await handleSmsStatus(db(), refused, deps())).toBe('resend_failed')
    bodyOk = true
    expect(await handleSmsStatus(db(), refused, deps())).toBe('already_resent')
    expect(send).not.toHaveBeenCalled()
  })
})
