/**
 * A form put in front of a link through the account API (booking insights
 * phase 4): the form's own rules are ./form-gate.ts formGateRefusal's
 * (form-gate.test.ts); here, that a link asks them on every change of its
 * form or rule, takes a different form's rule away, and clears the rule
 * with the form. Made-up people.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const gate = vi.hoisted(() => ({ refusal: vi.fn(async (..._args: unknown[]) => null as string | null) }))
vi.mock('../form-gate', () => ({ formGateRefusal: gate.refusal }))

import { bookingDb } from '@/test/booking-db'
import { handleCreateLink, handlePatchLink, type AccountDeps } from '../account'
import { WS } from './fixtures'

type Row = Record<string, unknown>
const AVA = 'a0000000-0000-4000-8000-00000000000a'
const FORM = 'f0000000-0000-4000-8000-00000000000f'
const OTHER_FORM = 'f0000000-0000-4000-8000-0000000000ff'
let tables: Record<string, Row[]>
let deps: AccountDeps

beforeEach(() => {
  gate.refusal.mockReset()
  gate.refusal.mockResolvedValue(null)
  tables = {
    workspace: [{ id: WS, name: 'Fernhill Studio' }],
    member: [{ id: 'm-ava', workspace_id: WS, user_id: AVA, display_name: 'Ava Lin', role: 'owner', availability_sharing: 'busy_only' }],
    booking_profile: [],
    booking_link: [],
    booking_link_host: [],
  }
  deps = { supabase: bookingDb(tables), origin: 'https://app.example' }
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const req = (body: unknown, method = 'POST') => new Request('https://app.example/api/account/booking-links', { method, body: JSON.stringify(body) })
const me = { workspaceId: WS, userId: AVA }
const RULE = { all: [{ field: 'budget', op: 'gte', value: 1000 }] }

describe('a form in front of a link', () => {
  it('is checked when it is set, and stored with its rule and line', async () => {
    const res = await handleCreateLink(req({ title: 'Intro call', form_id: FORM, form_rule: RULE, form_refusal: 'Teams of 10 or more.' }), me, deps)
    expect(res.status).toBe(201)
    expect(gate.refusal).toHaveBeenCalledWith(deps.supabase, me, FORM, RULE)
    const link = (await res.json()).link
    expect(link).toMatchObject({ form_id: FORM, form_rule: RULE, form_refusal: 'Teams of 10 or more.' })
  })

  it('a refusal is the change refused, and nothing is written', async () => {
    gate.refusal.mockResolvedValue('Only a form anyone can fill in can be in front of a booking link.')
    const res = await handleCreateLink(req({ title: 'Intro call', form_id: FORM }), me, deps)
    expect(res.status).toBe(400)
    expect(tables.booking_link).toHaveLength(0)
  })

  it('a new rule on the same form is checked against it; a different form drops the old rule; no form clears it', async () => {
    const made = (await (await handleCreateLink(req({ title: 'Intro call', form_id: FORM, form_rule: RULE }), me, deps)).json()).link
    gate.refusal.mockClear()
    const ruleOnly = { all: [{ field: 'plan', op: 'equals', value: 'Business' }] }
    expect((await handlePatchLink(req({ form_rule: ruleOnly }, 'PATCH'), made.id, me, deps)).status).toBe(200)
    expect(gate.refusal).toHaveBeenLastCalledWith(deps.supabase, me, FORM, ruleOnly)
    const moved = await (await handlePatchLink(req({ form_id: OTHER_FORM }, 'PATCH'), made.id, me, deps)).json()
    expect(gate.refusal).toHaveBeenLastCalledWith(deps.supabase, me, OTHER_FORM, null)
    expect(moved.link).toMatchObject({ form_id: OTHER_FORM, form_rule: null })
    const gone = await (await handlePatchLink(req({ form_id: null }, 'PATCH'), made.id, me, deps)).json()
    expect(gone.link).toMatchObject({ form_id: null, form_rule: null })
    // A title change asks nothing of the form.
    gate.refusal.mockClear()
    expect((await handlePatchLink(req({ title: 'Intro' }, 'PATCH'), made.id, me, deps)).status).toBe(200)
    expect(gate.refusal).not.toHaveBeenCalled()
  })

  it('a rule needs a form', async () => {
    const res = await handleCreateLink(req({ title: 'Intro call', form_rule: RULE }), me, deps)
    expect(res.status).toBe(400)
  })
})
