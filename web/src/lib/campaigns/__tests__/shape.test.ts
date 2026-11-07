import { describe, it, expect } from 'vitest'
import {
  CAMPAIGN_STATUSES,
  CAMPAIGN_STATUS_LABELS,
  isCampaignStatus,
  parseCampaignWrite,
} from '../shape'

/**
 * `parseCampaignWrite` is the whole write-validation surface for BOTH the
 * create (POST) and the edit (PATCH) route, which is only sound because it is
 * partial: a key absent from the body is absent from the result, so a PATCH
 * that mentions one field cannot blank the other eight. That partiality is
 * what these tests defend.
 */

describe('parseCampaignWrite — partiality', () => {
  it('returns nothing for an empty body (so PATCH can refuse it)', () => {
    const res = parseCampaignWrite({})
    expect(res).toEqual({ ok: true, fields: {} })
  })

  it('carries ONLY the keys the body mentioned', () => {
    const res = parseCampaignWrite({ status: 'active' })
    expect(res.ok && Object.keys(res.fields)).toEqual(['status'])
  })

  it('distinguishes "absent" from "explicitly null"', () => {
    const absent = parseCampaignWrite({ name: 'Q3' })
    expect(absent.ok && 'objective' in absent.fields).toBe(false)

    const cleared = parseCampaignWrite({ objective: null })
    expect(cleared).toEqual({ ok: true, fields: { objective: null } })
  })
})

describe('parseCampaignWrite — per-field rules', () => {
  it('trims text and treats a whitespace-only value as a clear', () => {
    expect(parseCampaignWrite({ objective: '  drive demos  ' })).toEqual({
      ok: true,
      fields: { objective: 'drive demos' },
    })
    expect(parseCampaignWrite({ description: '   ' })).toEqual({
      ok: true,
      fields: { description: null },
    })
  })

  it('rejects an empty name instead of writing one (name is NOT NULL)', () => {
    expect(parseCampaignWrite({ name: '   ' })).toEqual({
      ok: false,
      error: 'name cannot be empty',
    })
  })

  it('rejects a status outside the CHECK list', () => {
    const res = parseCampaignWrite({ status: 'launched' })
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.error).toContain('status must be one of')
  })

  it('accepts every status the migration allows', () => {
    for (const status of CAMPAIGN_STATUSES) {
      expect(parseCampaignWrite({ status })).toEqual({ ok: true, fields: { status } })
    }
  })

  it('trims and drops empties from the array columns', () => {
    expect(parseCampaignWrite({ channels: [' email ', '', 'linkedin'] })).toEqual({
      ok: true,
      fields: { channels: ['email', 'linkedin'] },
    })
    expect(parseCampaignWrite({ tags: [] })).toEqual({ ok: true, fields: { tags: [] } })
  })

  it('rejects a non-array or a non-string element on an array column', () => {
    expect(parseCampaignWrite({ channels: 'email' }).ok).toBe(false)
    expect(parseCampaignWrite({ tags: ['a', 7] }).ok).toBe(false)
  })

  it('accepts an ISO calendar date and rejects anything else', () => {
    expect(parseCampaignWrite({ starts_on: '2026-03-01' })).toEqual({
      ok: true,
      fields: { starts_on: '2026-03-01' },
    })
    for (const bad of ['03/01/2026', '2026-3-1', 'tomorrow', 12]) {
      expect(parseCampaignWrite({ ends_on: bad }).ok, String(bad)).toBe(false)
    }
  })

  it('treats an emptied date field as a clear (that is what an empty input means)', () => {
    expect(parseCampaignWrite({ starts_on: '' })).toEqual({
      ok: true,
      fields: { starts_on: null },
    })
    expect(parseCampaignWrite({ ends_on: null })).toEqual({
      ok: true,
      fields: { ends_on: null },
    })
  })

  it('clears the owner on empty string or null, keeps a uuid', () => {
    expect(parseCampaignWrite({ owner_member_id: '' })).toEqual({
      ok: true,
      fields: { owner_member_id: null },
    })
    expect(parseCampaignWrite({ owner_member_id: 'mem-1' })).toEqual({
      ok: true,
      fields: { owner_member_id: 'mem-1' },
    })
    expect(parseCampaignWrite({ owner_member_id: 7 }).ok).toBe(false)
  })

  it('never lets a body key that is not a writable column through', () => {
    // workspace_id, id and the timestamps are the caller's to set, never the
    // body's — a body that names them must not reach the update payload.
    const res = parseCampaignWrite({
      name: 'Q3',
      workspace_id: 'other-ws',
      id: 'someone-elses',
      created_at: '1999-01-01',
      fts: 'nonsense',
    })
    expect(res.ok && Object.keys(res.fields)).toEqual(['name'])
  })
})

describe('status vocabulary', () => {
  it('isCampaignStatus narrows only the real statuses', () => {
    for (const s of CAMPAIGN_STATUSES) expect(isCampaignStatus(s)).toBe(true)
    for (const s of ['', 'draft', null, 7, undefined]) expect(isCampaignStatus(s)).toBe(false)
  })

  it('labels every status (the picker renders from this map)', () => {
    expect(Object.keys(CAMPAIGN_STATUS_LABELS).sort()).toEqual([...CAMPAIGN_STATUSES].sort())
  })
})

// The status vocabulary exists twice on purpose (the server tool module must not
// import a UI-facing one), which makes divergence a silent half-surface failure.
// Pin the two copies to each other and to migration 267's CHECK.
import { CAMPAIGN_STATUSES as TOOL_STATUSES } from '@/lib/ai/tools/campaigns'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('campaign status vocabulary stays in lockstep', () => {
  it('tool enum matches shape enum exactly', () => {
    expect([...TOOL_STATUSES]).toEqual([...CAMPAIGN_STATUSES])
  })

  it('migration 267 CHECK lists the same statuses', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/267_campaigns.sql'),
      'utf8',
    )
    for (const status of CAMPAIGN_STATUSES) {
      expect(sql).toMatch(new RegExp(`'${status}'`))
    }
  })
})

// ──────────────────────────────────────────────────────────────────
// Roadmap D2: a campaign that sends (audience, sequence, rolling)
// ──────────────────────────────────────────────────────────────────
import { describeAudience, parseAudience, parseCampaignWrite as parseWrite } from '@/lib/campaigns/shape'

describe('parseAudience', () => {
  it('keeps the known parts, dedupes, and drops unknown keys', () => {
    expect(parseAudience({ relationship_types: ['customer', 'customer'], last_contacted_more_than_days: 180, extra: 1 })).toEqual({
      ok: true,
      audience: { relationship_types: ['customer'], last_contacted_more_than_days: 180 },
    })
    expect(parseAudience({ tags_any: [' rugs ', '', 'rugs'] })).toEqual({ ok: true, audience: { tags_any: ['rugs'] } })
  })

  it('refuses what would match by accident: no narrowing part, a bad type, a fractional or huge day count, a non-uuid id', () => {
    for (const bad of [{}, { include_never_contacted: true }, { relationship_types: ['investor'] }, { relationship_types: [] }, { last_contacted_more_than_days: 1.5 }, { last_contacted_more_than_days: 99999 }, { contact_ids: ['not-a-uuid'] }, [], 'customers', null]) {
      expect(parseAudience(bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('caps a chosen group', () => {
    const ids = Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    expect(parseAudience({ contact_ids: ids }).ok).toBe(false)
  })
})

describe('describeAudience', () => {
  it('says the audience in the person\'s words', () => {
    expect(describeAudience({ relationship_types: ['customer'], last_contacted_more_than_days: 180 })).toBe('Customers last in touch more than 6 months ago')
    expect(describeAudience({ last_contacted_more_than_days: 45 })).toBe('Customers last in touch more than 45 days ago')
    expect(describeAudience({ relationship_types: ['customer', 'lead'], last_contacted_more_than_days: 365, include_never_contacted: true })).toBe(
      'Customers and leads last in touch more than 1 year ago (or never)',
    )
    expect(describeAudience({ tags_any: ['persian', 'wool'] })).toBe('Contacts, tagged persian or wool')
    expect(describeAudience({ contact_ids: ['a', 'b'] })).toBe('2 chosen contacts')
    expect(describeAudience(null)).toBe('No audience yet')
  })
})

describe('parseCampaignWrite: the sending fields', () => {
  it('reads sequence_id, audience and rolling, and clears with null', () => {
    const id = '11111111-2222-4333-8444-555555555555'
    expect(parseWrite({ sequence_id: id, audience: { last_contacted_more_than_days: 30 }, rolling: true })).toEqual({
      ok: true,
      fields: { sequence_id: id, audience: { last_contacted_more_than_days: 30 }, rolling: true },
    })
    expect(parseWrite({ sequence_id: null, audience: null })).toEqual({ ok: true, fields: { sequence_id: null, audience: null } })
  })

  it('refuses a bad sequence id, audience or rolling', () => {
    expect(parseWrite({ sequence_id: 'seq-1' }).ok).toBe(false)
    expect(parseWrite({ audience: {} }).ok).toBe(false)
    expect(parseWrite({ rolling: 'yes' }).ok).toBe(false)
  })
})
