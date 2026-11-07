/**
 * The team board as a card: show checks it, finds its team among the teams the
 * person can see, and reads the board's first actions; read_card reads the
 * team the card is on now, with the person's own filters; the note says when
 * they switched teams. A private team they are not in is not there at all.
 */
import { describe, expect, it } from 'vitest'
import { normalizePageInput } from '../page-validate'
import { buildCardContextEntry, parseCardContext, renderCardsSection } from '../context'
import { ID, allText, pageTools, seededWorkspace } from './page-fixtures'

describe('team board: the spec', () => {
  it('needs its team, and names where to find it', () => {
    const out = normalizePageInput({ kind: 'team_board', title: 'Board' })
    expect(out).toEqual({ ok: false, error: expect.stringContaining('needs its team: give its name or id (get_workspace lists the teams)') })
  })

  it('checks its filters against the actions fields, naming the valid ones', () => {
    const out = normalizePageInput({ kind: 'team_board', title: 'Board', target: 'Platform', filters: [{ field: 'stage', operator: 'is', value: 'x' }] })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(/filters\[0\]: 'stage' is not a field of action\. Use one of these exactly: .*assignee_id/)
  })

  it('refuses a tab, since the board has none', () => {
    expect(normalizePageInput({ kind: 'team_board', title: 'B', target: 'Platform', tab: 'runs' })).toEqual({ ok: false, error: 'tab: team_board has no tabs. Leave tab out' })
  })
})

describe('team board: show', () => {
  it('finds the team by name and reads its actions, the count and the first rows', async () => {
    const out = await pageTools(seededWorkspace()).show({ kind: 'team_board', title: 'Platform board', target: 'platform' })
    expect(out.success).toBe(true)
    expect(out.card).toEqual({ kind: 'team_board', title: 'Platform board', target: { type: 'team', id: ID.teamOpen, label: 'Platform' } })
    expect(out.count).toBe(2)
    expect((out.items as Array<{ identifier: string }>).map((i) => i.identifier).sort()).toEqual(['GEN-1', 'GEN-2'])
  })

  it('keeps the agent filters on the card and applies them', async () => {
    const out = await pageTools(seededWorkspace()).show({
      kind: 'team_board',
      title: 'Urgent',
      target: ID.teamOpen,
      filters: [{ field: 'priority', operator: 'is', value: 'high' }],
    })
    expect(out.success).toBe(true)
    expect((out.card as { filters: unknown[] }).filters).toEqual([{ field: 'priority', operator: 'is', value: 'high' }])
    expect(out.count).toBe(1)
  })

  it('shows a private team the person is in', async () => {
    const out = await pageTools(seededWorkspace()).show({ kind: 'team_board', title: 'Core', target: 'Core' })
    expect(out.success).toBe(true)
    expect(out.count).toBe(1)
  })

  it('never finds, lists or reads a private team the person is not in', async () => {
    const db = seededWorkspace()
    const byName = await pageTools(db).show({ kind: 'team_board', title: 'x', target: 'Secret Ops' })
    expect(byName.success).toBe(false)
    expect(byName.error).toContain("no team named 'Secret Ops' that you can open here")
    expect(byName.error).toContain('Platform')
    expect(allText(byName)).not.toContain('Secret Ops board')
    // The refusal's list of teams leaves it out too.
    const partial = await pageTools(db).show({ kind: 'team_board', title: 'x', target: 'Ops' })
    expect(allText(partial)).not.toMatch(/Secret Ops'?[,.]/)
    const byId = await pageTools(db).show({ kind: 'team_board', title: 'x', target: ID.teamSecret })
    expect(byId.success).toBe(false)
    expect(allText(byId)).not.toContain('Acquisition memo')
  })
})

describe('team board: read_card and the note', () => {
  it('reads the team the person switched to, with their filter, and the note says what they did', async () => {
    const db = seededWorkspace()
    const entry = buildCardContextEntry({
      n: 1,
      id: 'call-1',
      spec: { kind: 'team_board', title: 'Platform board', target: { type: 'team', id: ID.teamOpen, label: 'Platform' }, entity: 'action', base: { filters: [], layout: 'board' } },
      at: { type: 'team', id: ID.teamCore, label: 'Core' },
      cur: { filters: [{ field: 'title', operator: 'contains', value: 'refactor' }], layout: 'board' },
      count: 1,
      rows: [{ identifier: 'GEN-4', title: 'Core refactor' }],
    })
    const [parsed] = parseCardContext(JSON.parse(JSON.stringify([entry])))
    expect(parsed.at).toEqual({ type: 'team', id: ID.teamCore, label: 'Core' })
    const note = renderCardsSection([parsed])!
    expect(note).toContain('card 1 · "Platform board" (team board)')
    expect(note).toContain('you opened: team "Core"')
    expect(note).toContain('you changed: no filters → title~refactor · 1 row')
    const read = await pageTools(db, [parsed]).readCard({ card: 1, fields: ['priority'] })
    expect(read).toMatchObject({ success: true, card: 1, at: 'team Core', total: 1 })
    expect(read.rows).toEqual([{ id: expect.any(String), identifier: 'GEN-4', title: 'Core refactor', priority: 'medium' }])
  })

  it('an untouched board adds nothing to the note', () => {
    const entry = buildCardContextEntry({
      n: 1,
      id: 'call-1',
      spec: { kind: 'team_board', title: 'Platform board', target: { type: 'team', id: ID.teamOpen, label: 'Platform' }, entity: 'action', base: { filters: [], layout: 'board' } },
    })
    expect(renderCardsSection(parseCardContext([entry]))).toBeNull()
  })

  it('refuses to read a forged private team the person is not in', async () => {
    const forged = parseCardContext([
      { n: 1, id: 'c', kind: 'team_board', title: 'x', at: { type: 'team', id: ID.teamSecret }, entity: 'action', cur: { filters: [] } },
    ])
    const read = await pageTools(seededWorkspace(), forged).readCard({ card: 1 })
    expect(read.success).toBe(false)
    expect(allText(read)).not.toContain('Acquisition memo')
  })
})
