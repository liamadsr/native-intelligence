/**
 * Campaigns as a card: the workspace's campaigns, never another workspace's.
 */
import { describe, expect, it } from 'vitest'
import { normalizePageInput } from '../page-validate'
import { buildCardContextEntry, parseCardContext, renderCardsSection } from '../context'
import { allText, pageTools, seededWorkspace } from './page-fixtures'

describe('campaigns', () => {
  it('takes no target or tab, naming the fix', () => {
    expect(normalizePageInput({ kind: 'campaigns', title: 'C', target: 'Launch week' })).toMatchObject({ ok: false, error: expect.stringContaining('Leave target out') })
    expect(normalizePageInput({ kind: 'campaigns', title: 'C', tab: 'active' })).toEqual({ ok: false, error: 'tab: campaigns has no tabs. Leave tab out' })
  })

  it("shows this workspace's campaigns with the count", async () => {
    const out = await pageTools(seededWorkspace()).show({ kind: 'campaigns', title: 'Campaigns' })
    expect(out).toMatchObject({ success: true, count: 1, items: [{ title: 'Launch week' }] })
    expect(allText(out)).not.toContain('Other workspace campaign')
  })

  it('adds nothing to the note, and read_card reads them with their fields', async () => {
    const parsed = parseCardContext([buildCardContextEntry({ n: 5, id: 'c', spec: { kind: 'campaigns', title: 'Campaigns' } })])
    expect(renderCardsSection(parsed)).toBeNull()
    const read = await pageTools(seededWorkspace(), parsed).readCard({ card: 5, fields: ['status'] })
    expect(read).toMatchObject({ success: true, showing: 'campaigns', total: 1, rows: [{ title: 'Launch week', status: 'active' }] })
    const bad = await pageTools(seededWorkspace(), parsed).readCard({ card: 5, fields: ['budget'] })
    expect(bad).toMatchObject({ success: false, code: 'INPUT_INVALID', error: expect.stringContaining('campaigns rows have no budget. Fields: id, name, status') })
  })

  it('is off where Campaigns is off', async () => {
    const out = await pageTools(seededWorkspace({ campaigns: 'off' })).show({ kind: 'campaigns', title: 'C' })
    expect(out.error).toContain('Campaigns is off in this workspace')
  })
})
