/**
 * Teams as a card: the teams the person can see (a private team they are not
 * in is not there, even by name), and one team's members.
 */
import { describe, expect, it } from 'vitest'
import { buildCardContextEntry, parseCardContext, renderCardsSection } from '../context'
import { ID, allText, pageTools, seededWorkspace } from './page-fixtures'

describe('teams', () => {
  it('lists the teams the person can see, their own private one included', async () => {
    const out = await pageTools(seededWorkspace()).show({ kind: 'teams', title: 'Teams' })
    expect((out.items as Array<{ title: string }>).map((i) => i.title).sort()).toEqual(['Core', 'Platform'])
    expect(allText(out)).not.toContain('Secret Ops')
  })

  it("opens a team on its members, and never a private team the person is not in", async () => {
    const out = await pageTools(seededWorkspace()).show({ kind: 'teams', title: 'Platform', target: 'Platform' })
    expect(out).toMatchObject({ success: true, card: { target: { type: 'team', id: ID.teamOpen } } })
    const hidden = await pageTools(seededWorkspace()).show({ kind: 'teams', title: 'x', target: 'Secret Ops' })
    expect(hidden.success).toBe(false)
    expect(hidden.error).not.toMatch(/Some there: .*Secret Ops/)
  })

  it('says the person opened a team, and reads its members; a forged hidden team falls back to the teams', async () => {
    const parsed = parseCardContext([buildCardContextEntry({ n: 1, id: 'c', spec: { kind: 'teams', title: 'Teams' }, at: { type: 'team', id: ID.teamCore, label: 'Core' } })])
    expect(renderCardsSection(parsed)).toContain('you opened: team "Core"')
    const read = await pageTools(seededWorkspace(), parsed).readCard({ card: 1 })
    expect(read).toMatchObject({ success: true, at: 'team Core', showing: 'members' })
    const forged = parseCardContext([buildCardContextEntry({ n: 1, id: 'c', spec: { kind: 'teams', title: 'Teams' }, at: { type: 'team', id: ID.teamSecret } })])
    const fallback = await pageTools(seededWorkspace(), forged).readCard({ card: 1 })
    expect(fallback).toMatchObject({ success: true, showing: 'teams' })
    expect(allText(fallback)).not.toContain('Secret Ops')
  })
})
