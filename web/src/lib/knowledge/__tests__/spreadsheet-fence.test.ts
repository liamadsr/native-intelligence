/**
 * A spreadsheet in the graph (migration 675): a workspace one is every
 * member's, a private one its maker's alone, and nobody's from outside the
 * workspace or with no user. The app-side fence mirrors spreadsheet_select;
 * 675's restrictive entity_link policies are the database's half.
 */
import { describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { LINK_FENCED_KINDS, PRIVATE_KIND_LABEL, hiddenPrivateRefs, isPrivateGraphKind, visiblePrivateKindIds } from '../entity-fences'
import { LINKABLE_ENTITY_TYPES, entityDescriptor } from '../entity-registry'
import { ENTITY_ACTIONS } from '@/lib/entities/entity-actions-registry'
import { entityOpenTarget } from '@/lib/entity-links/open-entity'
import { cardForTarget } from '@/lib/chat-cards/open-card'

const WS = '11111111-1111-4111-8111-111111111111'
const FAR = '11111111-1111-4111-8111-999999999999'
const ANA = 'user-ana'
const BEN = 'user-ben'
const OUTSIDER = 'user-out'
const S_OPEN = '33333333-3333-4333-8333-000000000001'
const S_ANA = '33333333-3333-4333-8333-000000000002'
const S_BEN = '33333333-3333-4333-8333-000000000003'
const S_FAR = '33333333-3333-4333-8333-000000000004'
const ALL = [S_OPEN, S_ANA, S_BEN, S_FAR]

const tables = () => ({
  member: [
    { id: 'm-ana', workspace_id: WS, user_id: ANA },
    { id: 'm-ben', workspace_id: WS, user_id: BEN },
    { id: 'm-out', workspace_id: FAR, user_id: OUTSIDER },
  ],
  spreadsheet: [
    { id: S_OPEN, workspace_id: WS, title: 'Hiring plan', visibility: 'workspace', created_by: 'm-ben' },
    { id: S_ANA, workspace_id: WS, title: 'Ana’s budget', visibility: 'private', created_by: 'm-ana' },
    { id: S_BEN, workspace_id: WS, title: 'Ben’s notes', visibility: 'private', created_by: 'm-ben' },
    { id: S_FAR, workspace_id: FAR, title: 'Elsewhere', visibility: 'workspace', created_by: 'm-out' },
  ],
})
const sorted = (s: Set<string>) => [...s].sort()

describe('the spreadsheet fence', () => {
  it('is a private graph kind with a fenced edge and a placeholder label', () => {
    expect(isPrivateGraphKind('spreadsheet')).toBe(true)
    expect(LINK_FENCED_KINDS as readonly string[]).toContain('spreadsheet')
    expect(PRIVATE_KIND_LABEL.spreadsheet).toBe('Spreadsheet (private)')
    expect(LINKABLE_ENTITY_TYPES as readonly string[]).toContain('spreadsheet')
    // The row carries the whole workbook: never on the shared realtime channel. No activity triggers in 675.
    expect(entityDescriptor('spreadsheet')).toMatchObject({ table: 'spreadsheet', realtime: false, activity: false, citable: false })
  })

  it('shows a member the workspace’s and their own private ones', async () => {
    expect(sorted(await visiblePrivateKindIds(memoryDb(tables()), 'spreadsheet', ANA, ALL, WS))).toEqual([S_OPEN, S_ANA])
    expect(sorted(await visiblePrivateKindIds(memoryDb(tables()), 'spreadsheet', BEN, ALL, WS))).toEqual([S_OPEN, S_BEN])
  })

  it('shows nothing to someone outside the workspace, or to no one', async () => {
    expect(sorted(await visiblePrivateKindIds(memoryDb(tables()), 'spreadsheet', OUTSIDER, ALL, WS))).toEqual([])
    expect(sorted(await visiblePrivateKindIds(memoryDb(tables()), 'spreadsheet', null, ALL, WS))).toEqual([])
    // With no workspace named, each row is judged in its own.
    expect(sorted(await visiblePrivateKindIds(memoryDb(tables()), 'spreadsheet', ANA, ALL))).toEqual([S_OPEN, S_ANA])
    expect(sorted(await visiblePrivateKindIds(memoryDb(tables()), 'spreadsheet', OUTSIDER, ALL))).toEqual([S_FAR])
  })

  it('hides another person’s private spreadsheet from a graph walk', async () => {
    const refs = ALL.map((id) => ({ type: 'spreadsheet', id }))
    expect(sorted(await hiddenPrivateRefs(memoryDb(tables()), refs, ANA, WS))).toEqual([`spreadsheet:${S_BEN}`, `spreadsheet:${S_FAR}`].sort())
  })
})

describe('a spreadsheet in the actions menu', () => {
  it('opens the Spreadsheets page’s card on it', () => {
    const target = entityOpenTarget('spreadsheet', S_OPEN, 'Hiring plan')
    expect(target).toEqual({ type: 'spreadsheet', id: S_OPEN, title: 'Hiring plan' })
    expect(cardForTarget(target!)?.spec).toEqual({ kind: 'spreadsheets', title: 'Hiring plan', target: { type: 'spreadsheet', id: S_OPEN, label: 'Hiring plan' } })
  })

  it('is renamed and archived through its own route, and is not shared to a channel', () => {
    expect(ENTITY_ACTIONS.spreadsheet).toMatchObject({
      rename: { route: 'spreadsheets', field: 'title' },
      archive: { kind: 'status', route: 'spreadsheets', via: 'patch', archived: 'archived', restore: 'active' },
      share: false,
    })
  })
})
