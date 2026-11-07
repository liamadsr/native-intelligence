/**
 * A bot's follow-through grants (bots v3 Phase 5, ../follow-through.ts): the
 * attended-only writes a bot's CHAT may hold, per system key or per loop it
 * fronts, never per persona category or teammate bounds.
 */
import { describe, it, expect } from 'vitest'
import { composeTeammateChatCeiling, type TeammateChatBounds } from '../chat-ceiling'
import { followThroughFor, resolveFollowThrough } from '../follow-through'
import { ALL_TOOL_NAMES, ATTENDED_ONLY_TOOL_NAMES } from '@/lib/ai/tool-registry'

const FULL = new Set(ALL_TOOL_NAMES)
const bounds = (over: Partial<TeammateChatBounds> = {}): TeammateChatBounds => ({
  allowed_side_effects: ['read', 'internal-write', 'automation-write', 'external-write', 'delete'],
  tool_allowlist: null,
  agentConfig: null,
  ...over,
})

describe('followThroughFor (who is granted what)', () => {
  it('Captures (Triage and Extraction folded in, migration 318): settle_card and undo; a triage loop’s bot: settle_card; Mail and a Correspondent: revise_email_draft', () => {
    expect([...followThroughFor({ systemKey: 'captures' })]).toEqual(['settle_card', 'undo_extraction_pass'])
    expect([...followThroughFor({ frontsTriageLoop: true })]).toEqual(['settle_card'])
    expect([...followThroughFor({ systemKey: 'mail' })]).toEqual(['revise_email_draft'])
    expect([...followThroughFor({ role: 'correspondent' })]).toEqual(['revise_email_draft'])
  })

  it('the folded keys grant nothing any more: no row carries them (migration 318’s CHECK)', () => {
    for (const key of ['triage', 'extraction', 'email_drafts', 'reconciler']) expect(followThroughFor({ systemKey: key }).size).toBe(0)
  })

  it('every other bot gets none (Prospecting, Evals, CRM, the Assistant, a Writer, a work bot fronting a prose loop)', () => {
    for (const key of ['prospecting', 'evals', 'crm', 'assistant']) expect(followThroughFor({ systemKey: key }).size).toBe(0)
    expect(followThroughFor({ role: 'writer' }).size).toBe(0)
    expect(followThroughFor({}).size).toBe(0)
  })
})

describe('composeTeammateChatCeiling with grants', () => {
  it('an attended-only tool never comes from the persona or the bounds: a fully-bounded teammate holds none ungranted', () => {
    const out = composeTeammateChatCeiling(FULL, bounds())
    for (const name of ATTENDED_ONLY_TOOL_NAMES) expect(out.has(name), name).toBe(false)
  })

  it('a granted tool is added after the narrowing: a read-only Triage still settles cards', () => {
    const out = composeTeammateChatCeiling(FULL, bounds({ allowed_side_effects: ['read'] }), ['settle_card'])
    expect(out.has('settle_card')).toBe(true)
    expect(out.has('accept_proposal')).toBe(false)
    expect(out.has('revise_email_draft')).toBe(false)
  })

  it('a work bot (read plus propose-only) fronting a triage loop settles cards, and nothing else is widened', () => {
    const out = composeTeammateChatCeiling(FULL, bounds({ frontsOnly: true }), ['settle_card'])
    expect(out.has('settle_card')).toBe(true)
    expect(out.has('create_action')).toBe(false)
  })

  it('the edition still caps a grant, and a grant can only name an attended-only tool', () => {
    const edition = new Set(['find', 'list_actions'])
    expect(composeTeammateChatCeiling(edition, bounds(), ['settle_card']).has('settle_card')).toBe(false)
    expect(composeTeammateChatCeiling(FULL, bounds({ allowed_side_effects: ['read'] }), ['delete_action']).has('delete_action')).toBe(false)
  })
})

describe('resolveFollowThrough (read live, fails closed)', () => {
  function client(tables: Record<string, unknown>) {
    const chain = (table: string) => {
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.eq = () => c
      c.in = () => c
      c.or = () => c
      c.limit = () => c
      c.maybeSingle = async () => ({ data: tables[table] ?? null, error: null })
      c.then = (resolve: (v: unknown) => void) => resolve({ data: tables[table] ?? [], error: null })
      return c
    }
    return { from: (t: string) => chain(t) } as never
  }

  it('reads the bot’s system key and role', async () => {
    expect([...(await resolveFollowThrough(client({ ai_team_member: { system_key: 'captures', role: null } }), { workspaceId: 'ws', teammateId: 'tm' }))]).toEqual([
      'settle_card',
      'undo_extraction_pass',
    ])
    expect([...(await resolveFollowThrough(client({ ai_team_member: { system_key: 'mail', role: null } }), { workspaceId: 'ws', teammateId: 'tm' }))]).toEqual([
      'revise_email_draft',
    ])
  })

  it('a bot that fronts a loop running a verdict skill settles cards', async () => {
    const c = client({
      ai_team_member: { system_key: null, role: null },
      flow: [{ seed_key: null, actions: [{ type: 'run_skill', config: { skill_id: 'sk-1' } }] }],
      recipe: [{ agent_config: { output_contract: 'verdict' } }],
    })
    expect([...(await resolveFollowThrough(c, { workspaceId: 'ws', teammateId: 'tm' }))]).toEqual(['settle_card'])
  })

  it('the seeded Triage loop’s bot settles cards; the seeded reconciler’s does not, though both are Captures’ loops (S3 review)', async () => {
    const triage = client({ ai_team_member: { system_key: null, role: null }, flow: [{ seed_key: 'seed:triage', actions: [] }], recipe: [] })
    expect([...(await resolveFollowThrough(triage, { workspaceId: 'ws', teammateId: 'tm' }))]).toEqual(['settle_card'])
    const reconcile = client({
      ai_team_member: { system_key: null, role: null },
      flow: [{ seed_key: 'seed:reconcile', actions: [{ type: 'run_skill', config: { skill_id: 'sk-r' } }] }],
      recipe: [{ agent_config: { output_contract: 'prose' } }],
    })
    expect((await resolveFollowThrough(reconcile, { workspaceId: 'ws', teammateId: 'tm' })).size).toBe(0)
  })

  it('no bot, a bot that is gone, or a failed read: nothing', async () => {
    expect((await resolveFollowThrough(client({}), { workspaceId: 'ws', teammateId: null })).size).toBe(0)
    expect((await resolveFollowThrough(client({}), { workspaceId: 'ws', teammateId: 'tm' })).size).toBe(0)
    const broken = { from: () => { throw new Error('db down') } } as never
    expect((await resolveFollowThrough(broken, { workspaceId: 'ws', teammateId: 'tm' })).size).toBe(0)
  })
})
