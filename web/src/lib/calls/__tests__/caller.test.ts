import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  linked: null as null | { id: string; userId: string; workspaceId: string; phone: string; optedOut: boolean },
  member: true,
  lookups: [] as string[],
}))

vi.mock('@/lib/sms/store', () => ({
  findLinkedPhone: async (_s: unknown, phone: string) => {
    h.lookups.push(phone)
    return h.linked
  },
  isWorkspaceMember: async () => h.member,
}))

import { callerIdAttested, callerNumberOfSipHeaders, devSkipsAttestation, resolveCallCaller, sipHeaderNames, trunkSecretCheck } from '../caller'

const supabase = {} as SupabaseClient
const DEV = { NODE_ENV: 'development', GPT_LIVE_DEV_CALLER_PHONE: '+1 (415) 555-0100', GPT_LIVE_DEV_USER_ID: 'u-dev', GPT_LIVE_DEV_WORKSPACE_ID: 'w-dev' }

beforeEach(() => {
  h.linked = null
  h.member = true
  h.lookups = []
})

describe('callerNumberOfSipHeaders', () => {
  it('reads the E.164 number from a sip: or tel: From', () => {
    expect(callerNumberOfSipHeaders([{ name: 'From', value: '"Liam" <sip:+14155550100@sip.twilio.com>;tag=abc' }])).toBe('+14155550100')
    expect(callerNumberOfSipHeaders([{ name: 'from', value: '<sips:+447700900123@example.com>' }])).toBe('+447700900123')
    expect(callerNumberOfSipHeaders([{ name: 'From', value: '<tel:+14155550100>;tag=1' }])).toBe('+14155550100')
    expect(callerNumberOfSipHeaders([{ name: 'From', value: '<sip:%2B14155550100@host>' }])).toBe('+14155550100')
  })

  it('is null without a From, or with no number in it', () => {
    expect(callerNumberOfSipHeaders([{ name: 'To', value: '<sip:+14155550100@host>' }])).toBeNull()
    expect(callerNumberOfSipHeaders([{ name: 'From', value: '<sip:alice@example.com>' }])).toBeNull()
    expect(callerNumberOfSipHeaders([{ name: 'From', value: '<sip:%E0%A4%A@host>' }])).toBeNull()
    expect(callerNumberOfSipHeaders([])).toBeNull()
  })
})

describe('callerIdAttested (STIR/SHAKEN)', () => {
  const from = { name: 'From', value: '<sip:+14155550100@sip.twilio.com>;tag=1' }
  it("is true only for Twilio's full attestation, by header or a verstat parameter", () => {
    expect(callerIdAttested([from, { name: 'X-Twilio-VerStat', value: 'TN-Validation-Passed-A' }])).toBe(true)
    expect(callerIdAttested([from, { name: 'x-twilio-verstat', value: ' tn-validation-passed-a ' }])).toBe(true)
    expect(callerIdAttested([{ name: 'From', value: '<sip:+14155550100;verstat=TN-Validation-Passed-A@host>' }])).toBe(true)
    expect(callerIdAttested([from, { name: 'P-Asserted-Identity', value: '<sip:+14155550100@host;verstat=TN-Validation-Passed-A>' }])).toBe(true)
  })

  it('is false for partial attestation, a failed or missing check', () => {
    for (const value of ['TN-Validation-Passed-B', 'TN-Validation-Passed-C', 'TN-Validation-Failed-A', 'No-TN-Validation', 'TN-Validation-Passed', 'TN-Validation-Passed-AB']) {
      expect(callerIdAttested([from, { name: 'X-Twilio-VerStat', value }])).toBe(false)
    }
    expect(callerIdAttested([from])).toBe(false)
    // A display name is the caller's own words, never the carrier's.
    expect(callerIdAttested([{ name: 'From', value: '"x;verstat=TN-Validation-Passed-A" <sip:+14155550100@host>;tag=1' }])).toBe(false)
  })

  it('logs header names only, and skips attestation only in local dev when asked', () => {
    expect(sipHeaderNames([from, { name: 'X-Twilio-VerStat', value: 'secret-ish' }, { name: 'from', value: 'x' }])).toBe('from,x-twilio-verstat')
    expect(devSkipsAttestation({ NODE_ENV: 'development', GPT_LIVE_DEV_SKIP_ATTESTATION: '1' })).toBe(true)
    expect(devSkipsAttestation({ NODE_ENV: 'development', GPT_LIVE_DEV_SKIP_ATTESTATION: '1', VERCEL_ENV: 'preview' })).toBe(false)
    expect(devSkipsAttestation({ NODE_ENV: 'production', GPT_LIVE_DEV_SKIP_ATTESTATION: '1' })).toBe(false)
    expect(devSkipsAttestation({ NODE_ENV: 'development' })).toBe(false)
  })
})

describe('trunkSecretCheck', () => {
  const from = { name: 'From', value: '<sip:+14155550100@sip.twilio.com>' }
  it('passes only the exact secret our trunk adds (header name in any case)', () => {
    const env = { GPT_LIVE_TRUNK_SECRET: 's3cret-value' }
    expect(trunkSecretCheck([from, { name: 'X-Dial8-Trunk', value: 's3cret-value' }], env)).toBe('ok')
    expect(trunkSecretCheck([from, { name: 'x-dial8-trunk', value: ' s3cret-value ' }], env)).toBe('ok')
    expect(trunkSecretCheck([from, { name: 'X-Dial8-Trunk', value: 's3cret-valu' }], env)).toBe('mismatch')
    expect(trunkSecretCheck([from, { name: 'X-Dial8-Trunk', value: 's3cret-value2' }], env)).toBe('mismatch')
    expect(trunkSecretCheck([from], env)).toBe('mismatch')
  })

  it('without the secret set, every call is refused, local dev included', () => {
    expect(trunkSecretCheck([from], {})).toBe('not_configured')
    expect(trunkSecretCheck([from], { NODE_ENV: 'production' })).toBe('not_configured')
    expect(trunkSecretCheck([from, { name: 'X-Dial8-Trunk', value: 'anything' }], { NODE_ENV: 'development' })).toBe('not_configured')
  })
})

describe('resolveCallCaller', () => {
  it('is the person whose verified phone it is', async () => {
    h.linked = { id: 'p1', userId: 'u1', workspaceId: 'w1', phone: '+14155550100', optedOut: false }
    expect(await resolveCallCaller(supabase, '+14155550100', {})).toEqual({ userId: 'u1', workspaceId: 'w1', via: 'verified_phone' })
    expect(h.lookups).toEqual(['+14155550100'])
  })

  it('is nobody for an unlinked number outside local dev, whatever the dev mapping says', async () => {
    expect(await resolveCallCaller(supabase, '+14155550100', {})).toBeNull()
    expect(await resolveCallCaller(supabase, '+14155550100', { ...DEV, NODE_ENV: 'production' })).toBeNull()
    // Any Vercel deployment, preview or not.
    expect(await resolveCallCaller(supabase, '+14155550100', { ...DEV, VERCEL_ENV: 'preview' })).toBeNull()
  })

  it('in local dev, maps the one configured number to its member', async () => {
    expect(await resolveCallCaller(supabase, '+14155550100', DEV)).toEqual({ userId: 'u-dev', workspaceId: 'w-dev', via: 'dev_mapping' })
    expect(await resolveCallCaller(supabase, '+14155550199', DEV)).toBeNull()
    h.member = false
    expect(await resolveCallCaller(supabase, '+14155550100', DEV)).toBeNull()
  })
})
