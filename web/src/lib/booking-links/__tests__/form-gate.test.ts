import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { FormSubmitDeps } from '@/lib/forms/submit'
import type { DataForm } from '@/lib/forms/types'
import type { DataColumn } from '@/lib/tables/types'
import { conditionMet, DEFAULT_FORM_REFUSAL, FORM_PASS_TTL_MS, gateForm, handleQualify, issuePass, passKey, readFormRule, rulePasses, ruleProblem, verifyPass } from '../form-gate'
import { linkOf } from './fixtures'

const SECRET = 'test-secret'
const NOW = Date.parse('2026-11-20T15:00:00Z')
const ROW = '12345678-1234-4234-8234-123456789012'

const col = (key: string, field_type: string, options: string[] = []) => ({ id: key, key, label: key, field_type, options, deleted_at: null }) as unknown as DataColumn
const COLUMNS = [col('budget', 'currency'), col('team_size', 'number'), col('plan', 'select', ['Starter', 'Business']), col('needs', 'multi_select', ['Sales', 'Support']), col('agree', 'checkbox'), col('company', 'text'), col('email', 'email')]

const form = (over: Partial<DataForm> = {}): DataForm => ({
  id: 'form-1',
  workspaceId: 'ws-fernhill',
  tableId: 'table-1',
  name: 'Before you book',
  fields: [
    { key: '$title', label: 'Your name', required: true },
    { key: 'email', label: 'Email', required: true },
    { key: 'budget', label: 'Budget', required: false },
    { key: 'team_size', label: 'Team size', required: false },
    { key: 'plan', label: 'Plan', required: false },
    { key: 'needs', label: 'Needs', required: false },
    { key: 'agree', label: 'Agree', required: false },
  ],
  access: 'public',
  allowedOrigins: [],
  thanks: null,
  description: null,
  submitLabel: null,
  botCheck: false,
  active: true,
  keyPrefix: 'fk_abc',
  createdBy: 'user-ava',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  lastSubmittedAt: null,
  ...over,
})

describe('the rule', () => {
  it('reads what may be stored, and nothing else', () => {
    expect(readFormRule({ all: [{ field: 'plan', op: 'equals', value: 'Business' }] })).toEqual({ all: [{ field: 'plan', op: 'equals', value: 'Business' }] })
    expect(readFormRule({ all: [{ field: 'plan', op: 'regex', value: '.*' }] })).toBeNull()
    expect(readFormRule([])).toBeNull()
    expect(readFormRule(null)).toBeNull()
  })

  it('must name the form’s own fields, with ops and values their types take', () => {
    const f = form()
    expect(ruleProblem({ all: [{ field: 'budget', op: 'gte', value: 1000 }, { field: 'plan', op: 'in', value: ['Business'] }, { field: 'agree', op: 'is_true' }] }, f, COLUMNS)).toBeNull()
    expect(ruleProblem({ all: [{ field: 'company', op: 'equals', value: 'x' }] }, f, COLUMNS)).toMatch(/no field "company"/)
    expect(ruleProblem({ all: [{ field: 'agree', op: 'gte', value: 1 }] }, f, COLUMNS)).toMatch(/takes is_true, is_false/)
    expect(ruleProblem({ all: [{ field: 'plan', op: 'equals', value: 'Enterprise' }] }, f, COLUMNS)).toMatch(/no choice "Enterprise"/)
    expect(ruleProblem({ all: [{ field: 'budget', op: 'gte', value: 'lots' }] }, f, COLUMNS)).toMatch(/is a number/)
    expect(ruleProblem({ all: [{ field: 'plan', op: 'in', value: [] }] }, f, COLUMNS)).toMatch(/list/)
    expect(ruleProblem({ all: [{ field: 'email', op: 'contains' }] }, f, COLUMNS)).toMatch(/one value/)
  })

  it('checks each answer by its type', () => {
    expect(conditionMet({ field: 'budget', op: 'gte', value: 1000 }, { amount: 2500, currency: 'USD' })).toBe(true)
    expect(conditionMet({ field: 'budget', op: 'gte', value: 1000 }, { amount: 500, currency: 'USD' })).toBe(false)
    expect(conditionMet({ field: 'budget', op: 'gte', value: 1000 }, null)).toBe(false)
    expect(conditionMet({ field: 'team_size', op: 'lte', value: '50' }, 12)).toBe(true)
    expect(conditionMet({ field: 'team_size', op: 'equals', value: 12 }, 12)).toBe(true)
    expect(conditionMet({ field: 'plan', op: 'equals', value: 'business' }, 'Business')).toBe(true)
    expect(conditionMet({ field: 'plan', op: 'not_equals', value: 'Business' }, undefined)).toBe(true)
    expect(conditionMet({ field: 'plan', op: 'in', value: ['Starter', 'Business'] }, 'Starter')).toBe(true)
    expect(conditionMet({ field: 'needs', op: 'contains', value: 'Sales' }, ['Support', 'Sales'])).toBe(true)
    expect(conditionMet({ field: 'needs', op: 'in', value: ['Sales'] }, ['Support'])).toBe(false)
    expect(conditionMet({ field: 'email', op: 'contains', value: '@fernhill.example' }, 'dana@FERNHILL.example')).toBe(true)
    expect(conditionMet({ field: 'agree', op: 'is_true' }, true)).toBe(true)
    expect(conditionMet({ field: 'agree', op: 'is_false' }, undefined)).toBe(true)
    expect(conditionMet({ field: 'd', op: 'gte', value: '2026-12-01' }, '2026-12-15')).toBe(true)
  })

  it('passes only when every condition holds; no rule passes everyone', () => {
    const rule = { all: [{ field: 'budget', op: 'gte' as const, value: 1000 }, { field: '$title', op: 'contains' as const, value: 'dana' }] }
    expect(rulePasses(rule, { title: 'Dana Wu', values: { budget: { amount: 5000, currency: 'USD' } } })).toBe(true)
    expect(rulePasses(rule, { title: 'Eli Park', values: { budget: { amount: 5000, currency: 'USD' } } })).toBe(false)
    expect(rulePasses(null, { title: '', values: {} })).toBe(true)
    expect(rulePasses({ all: [] }, { title: '', values: {} })).toBe(true)
  })
})

describe('the pass', () => {
  it('is good for its link and row until it lapses, and can’t be forged', () => {
    const pass = issuePass('link-1', ROW, NOW, SECRET)
    expect(verifyPass(pass, 'link-1', NOW + 1000, SECRET)).toBe(ROW)
    expect(verifyPass(pass, 'link-2', NOW, SECRET)).toBeNull()
    expect(verifyPass(pass, 'link-1', NOW + FORM_PASS_TTL_MS + 1, SECRET)).toBeNull()
    expect(verifyPass(pass, 'link-1', NOW, 'another-secret')).toBeNull()
    const [, , exp, mac] = pass.split('.')
    expect(verifyPass(`bp1.${'0'.repeat(8)}-1234-4234-8234-123456789012.${exp}.${mac}`, 'link-1', NOW, SECRET)).toBeNull()
    expect(verifyPass('nonsense', 'link-1', NOW, SECRET)).toBeNull()
    expect(verifyPass(undefined, 'link-1', NOW, SECRET)).toBeNull()
  })

  it('is keyed by its own key, derived from the secret under its purpose label: never the secret itself', async () => {
    const { createHmac } = await import('node:crypto')
    const pass = issuePass('link-1', ROW, NOW, SECRET)
    const [, row, exp, mac] = pass.split('.')
    const raw = createHmac('sha256', SECRET).update(`link-1:${row}:${exp}`).digest('base64url')
    expect(mac).not.toBe(raw)
    const hex = (k: Uint8Array) => Buffer.from(k).toString('hex')
    expect(hex(passKey(SECRET))).toBe(hex(passKey(SECRET)))
    expect(hex(passKey(SECRET))).not.toBe(hex(passKey('another-secret')))
  })
})

describe('gateForm', () => {
  const db = {} as SupabaseClient
  it('none, open with its shape, or closed when it can’t be answered now', async () => {
    expect(await gateForm({ formId: null, workspaceId: 'ws-fernhill' }, { supabase: db })).toEqual({ kind: 'none' })
    const open = await gateForm({ formId: 'form-1', workspaceId: 'ws-fernhill' }, { supabase: db, findForm: async () => form(), columns: async () => COLUMNS })
    expect(open.kind).toBe('open')
    if (open.kind === 'open') expect(open.shape.fields.map((f) => f.label)).toContain('Budget')
    for (const over of [{ active: false }, { access: 'members' as const }, { workspaceId: 'ws-other' }, { fields: [{ key: '$files', label: 'Files', required: false }] }]) {
      expect((await gateForm({ formId: 'form-1', workspaceId: 'ws-fernhill' }, { supabase: db, findForm: async () => form(over), columns: async () => COLUMNS })).kind).toBe('closed')
    }
    expect((await gateForm({ formId: 'form-1', workspaceId: 'ws-fernhill' }, { supabase: db, findForm: async () => form(), columns: async () => null })).kind).toBe('closed')
  })
})

describe('handleQualify', () => {
  const gated = linkOf({ formId: 'form-1', formRule: { all: [{ field: 'budget', op: 'gte', value: 1000 }] }, formRefusal: null })

  function submitDeps(rows: Array<{ id: string; title: string; values: Record<string, unknown> }>): FormSubmitDeps {
    return {
      findForm: async () => null,
      clientKey: () => 'client-1',
      memberOf: async () => 'member',
      countFormAttempts: async () => 0,
      countClientAttempts: async () => 0,
      columns: async () => COLUMNS,
      openAttempt: async () => 'attempt-1',
      claimAttempt: async () => ({ kind: 'new' }),
      canWrite: async () => true,
      markStored: async () => {},
      releaseAttempt: async () => {},
      upsertContact: async () => null,
      writeRow: async (_f, row) => {
        rows.push(row as never)
        return { ok: true }
      },
      newId: () => ROW,
      now: () => NOW,
    }
  }

  const post = (body: Record<string, unknown>) =>
    new Request('https://app.example/api/public/booking-links/ava-lin/intro/qualify', { method: 'POST', headers: { 'Content-Type': 'application/json', host: 'app.example', origin: 'https://app.example' }, body: JSON.stringify(body) })

  const deps = (rows: Array<{ id: string; title: string; values: Record<string, unknown> }>, over: Record<string, unknown> = {}) => ({
    supabase: {} as SupabaseClient,
    now: () => NOW,
    liveLink: async () => gated,
    findForm: async () => form(),
    columns: async () => COLUMNS,
    submit: submitDeps(rows),
    secret: SECRET,
    ...over,
  })

  it('writes the answers to the form’s table and hands a qualified guest a pass', async () => {
    const rows: Array<{ id: string; title: string; values: Record<string, unknown> }> = []
    const res = await handleQualify(post({ submission_id: 's-1', your_name: 'Dana Wu', email: 'dana@example.com', budget: 5000 }), 'ava-lin', 'intro', deps(rows))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, qualified: true })
    expect(verifyPass(body.pass, gated.id, NOW, SECRET)).toBe(ROW)
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('Dana Wu')
  })

  it('a guest who doesn’t qualify is still a row, and reads the polite line', async () => {
    const rows: Array<{ id: string; title: string; values: Record<string, unknown> }> = []
    const res = await handleQualify(post({ submission_id: 's-2', your_name: 'Eli Park', email: 'eli@example.com', budget: 50 }), 'ava-lin', 'intro', deps(rows))
    expect(await res.json()).toEqual({ ok: true, qualified: false, message: DEFAULT_FORM_REFUSAL })
    expect(rows).toHaveLength(1)
    const own = await handleQualify(post({ submission_id: 's-3', your_name: 'Eli Park', email: 'eli@example.com' }), 'ava-lin', 'intro', deps([], { liveLink: async () => ({ ...gated, formRefusal: 'We work with teams of 10 or more.' }) }))
    expect((await own.json()).message).toBe('We work with teams of 10 or more.')
  })

  it('the intake’s refusals pass straight through: a required field left empty is 400, and nothing is written', async () => {
    const rows: Array<{ id: string; title: string; values: Record<string, unknown> }> = []
    const res = await handleQualify(post({ submission_id: 's-4', budget: 5000 }), 'ava-lin', 'intro', deps(rows))
    expect(res.status).toBe(400)
    expect(rows).toHaveLength(0)
  })

  it('a honeypot hit is answered as stored but never qualifies', async () => {
    const res = await handleQualify(post({ submission_id: 's-5', your_name: 'Bot', email: 'bot@example.com', budget: 5000, _gotcha: 'filled' }), 'ava-lin', 'intro', deps([], { rowValues: vi.fn(async () => null) }))
    expect(await res.json()).toMatchObject({ ok: true, qualified: false })
  })

  it('no form, a closed one, or no such page', async () => {
    expect((await handleQualify(post({}), 'ava-lin', 'intro', deps([], { liveLink: async () => linkOf() }))).status).toBe(404)
    expect((await handleQualify(post({}), 'ava-lin', 'intro', deps([], { findForm: async () => form({ active: false }) }))).status).toBe(410)
    expect((await handleQualify(post({}), 'ava-lin', 'intro', deps([], { liveLink: async () => null }))).status).toBe(404)
  })
})
