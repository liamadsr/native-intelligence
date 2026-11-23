/**
 * A private spreadsheet or canvas shared with someone (migration 688,
 * docs/plans/record-sharing.md, Phase 2): the agent's graph fences let the
 * grantee see it, as 688's spreadsheet_visible_to / canvas_visible_to do,
 * and never on a guest's or a linked agent's turn (grants: false, 519's
 * rule; 688's *_visible_ungranted). Nobody else gains anything.
 */
import { describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { hiddenPrivateRefs, visiblePrivateKindIds } from '../entity-fences'

const WS = '11111111-1111-4111-8111-111111111111'
const FAR = '11111111-1111-4111-8111-999999999999'
const ANA = 'user-ana'
const BEN = 'user-ben'
const CAL = 'user-cal'
const DEE = 'user-dee'
const OUTSIDER = 'user-out'
const S_ANA = '33333333-3333-4333-8333-000000000002'
const S_OPEN = '33333333-3333-4333-8333-000000000001'
const C_ANA = '44444444-4444-4444-8444-000000000002'
const C_OPEN = '44444444-4444-4444-8444-000000000001'
const TEAM = '55555555-5555-4555-8555-000000000001'

const grant = (id: string, entity_type: string, entity_id: string, grantee: Record<string, string>, workspace_id = WS) => ({
  id,
  workspace_id,
  entity_type,
  entity_id,
  grantee_kind: grantee.grantee_member_id ? 'member' : 'team',
  grantee_member_id: grantee.grantee_member_id ?? null,
  grantee_team_id: grantee.grantee_team_id ?? null,
  grantee_channel_id: null,
  level: 'view',
})

const tables = () => ({
  member: [
    { id: 'm-ana', workspace_id: WS, user_id: ANA, role: 'member' },
    { id: 'm-ben', workspace_id: WS, user_id: BEN, role: 'member' },
    { id: 'm-cal', workspace_id: WS, user_id: CAL, role: 'member' },
    { id: 'm-dee', workspace_id: WS, user_id: DEE, role: 'member' },
    { id: 'm-out', workspace_id: FAR, user_id: OUTSIDER, role: 'member' },
  ],
  team: [{ id: TEAM, workspace_id: WS }],
  team_member: [{ team_id: TEAM, member_id: 'm-dee' }],
  spreadsheet: [
    { id: S_OPEN, workspace_id: WS, visibility: 'workspace', created_by: 'm-cal' },
    { id: S_ANA, workspace_id: WS, visibility: 'private', created_by: 'm-ana' },
  ],
  canvas: [
    { id: C_OPEN, workspace_id: WS, visibility: 'workspace', owner_member_id: 'm-cal' },
    { id: C_ANA, workspace_id: WS, visibility: 'private', owner_member_id: 'm-ana' },
  ],
  entity_access: [
    grant('g1', 'spreadsheet', S_ANA, { grantee_member_id: 'm-ben' }),
    grant('g2', 'canvas', C_ANA, { grantee_member_id: 'm-ben' }),
    grant('g3', 'canvas', C_ANA, { grantee_team_id: TEAM }),
    // A forged row naming the outsider's member in another workspace reaches no one here.
    grant('g4', 'spreadsheet', S_ANA, { grantee_member_id: 'm-out' }, FAR),
  ],
})
const sorted = (s: Set<string>) => [...s].sort()

describe('the spreadsheet and canvas fences follow grants (688)', () => {
  it('a member a spreadsheet is shared with sees it; nobody else gains it', async () => {
    const db = memoryDb(tables())
    expect(sorted(await visiblePrivateKindIds(db, 'spreadsheet', BEN, [S_OPEN, S_ANA], WS))).toEqual([S_OPEN, S_ANA])
    expect(sorted(await visiblePrivateKindIds(db, 'spreadsheet', CAL, [S_OPEN, S_ANA], WS))).toEqual([S_OPEN])
    expect(sorted(await visiblePrivateKindIds(db, 'spreadsheet', OUTSIDER, [S_OPEN, S_ANA]))).toEqual([])
    expect(sorted(await visiblePrivateKindIds(db, 'spreadsheet', ANA, [S_ANA], WS))).toEqual([S_ANA])
  })

  it('a canvas shared with a member, or with a team they are in', async () => {
    const db = memoryDb(tables())
    expect(sorted(await visiblePrivateKindIds(db, 'canvas', BEN, [C_OPEN, C_ANA], WS))).toEqual([C_OPEN, C_ANA].sort())
    expect(sorted(await visiblePrivateKindIds(db, 'canvas', DEE, [C_OPEN, C_ANA], WS))).toEqual([C_OPEN, C_ANA].sort())
    expect(sorted(await visiblePrivateKindIds(db, 'canvas', CAL, [C_OPEN, C_ANA], WS))).toEqual([C_OPEN])
  })

  it('never on a guest’s or a linked agent’s turn (grants: false)', async () => {
    const db = memoryDb(tables())
    expect(sorted(await visiblePrivateKindIds(db, 'spreadsheet', BEN, [S_OPEN, S_ANA], WS, { grants: false }))).toEqual([S_OPEN])
    expect(sorted(await visiblePrivateKindIds(db, 'canvas', BEN, [C_OPEN, C_ANA], WS, { grants: false }))).toEqual([C_OPEN])
  })

  it('a graph walk hides them from whoever has no grant', async () => {
    const refs = [{ type: 'spreadsheet', id: S_ANA }, { type: 'canvas', id: C_ANA }]
    expect(sorted(await hiddenPrivateRefs(memoryDb(tables()), refs, BEN, WS))).toEqual([])
    expect(sorted(await hiddenPrivateRefs(memoryDb(tables()), refs, CAL, WS))).toEqual([`canvas:${C_ANA}`, `spreadsheet:${S_ANA}`])
  })
})
