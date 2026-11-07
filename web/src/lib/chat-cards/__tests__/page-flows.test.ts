/**
 * Flows as a card: the list. A flow on a private team the person is not in
 * is still listed (flows are workspace-wide under RLS), but its team's name is
 * not: the embed comes back empty, as it would under RLS.
 */
import { describe, expect, it } from 'vitest'
import { normalizePageInput } from '../page-validate'
import { buildCardContextEntry, parseCardContext, renderCardsSection } from '../context'
import { allText, pageTools, seededWorkspace } from './page-fixtures'

describe('flows: the spec', () => {
  it('takes no target, naming the fix', () => {
    expect(normalizePageInput({ kind: 'flows', title: 'F', target: 'Notify on done' })).toEqual({
      ok: false,
      error: 'target: flows opens the whole Flows page and takes no target. Leave target out',
    })
  })
})

describe('flows: show and read_card', () => {
  it('lists the flows with their count', async () => {
    const out = await pageTools(seededWorkspace()).show({ kind: 'flows', title: 'Flows' })
    expect(out).toMatchObject({ success: true, card: { kind: 'flows', title: 'Flows' }, count: 3 })
  })

  it("never names a private team the person is not in", async () => {
    const entry = buildCardContextEntry({ n: 1, id: 'c', spec: { kind: 'flows', title: 'Flows', entity: 'flow', base: { filters: [] } } })
    const parsed = parseCardContext([entry])
    expect(renderCardsSection(parsed)).toBeNull()
    const read = await pageTools(seededWorkspace(), parsed).readCard({ card: 1, fields: ['team'] })
    expect(read.success).toBe(true)
    const byName = Object.fromEntries((read.rows as Array<{ title: string; team: unknown }>).map((r) => [r.title, r.team]))
    expect(byName).toEqual({ 'Notify on done': 'Platform', 'Secret hook': null, 'Triage loop': 'Platform' })
    expect(allText(read)).not.toContain('Secret Ops')
  })

  it("never names a bot on a private team the person is not on; a system bot is everyone's", async () => {
    const entry = buildCardContextEntry({ n: 1, id: 'c', spec: { kind: 'flows', title: 'Flows', entity: 'flow', base: { filters: [] } } })
    const read = await pageTools(seededWorkspace(), parseCardContext([entry])).readCard({ card: 1, fields: ['bot'] })
    const byName = Object.fromEntries((read.rows as Array<{ title: string; bot: unknown }>).map((r) => [r.title, r.bot]))
    expect(byName).toEqual({ 'Notify on done': 'Pat', 'Secret hook': null, 'Triage loop': 'Triage' })
    expect(allText(read)).not.toContain('Shadow bot')
  })
})
