/**
 * Agents & skills as a card: system items, the workspace's shared ones and the
 * person's own; never a teammate's personal skill, and never a feature's
 * system skill while the feature is off (/create-eval without Evals).
 */
import { describe, expect, it } from 'vitest'
import { normalizePageInput } from '../page-validate'
import { buildCardContextEntry, parseCardContext, renderCardsSection } from '../context'
import { ID, allText, pageTools, seededWorkspace } from './page-fixtures'

const titles = (out: Record<string, unknown>) => (out.items as Array<{ title: string }>).map((i) => i.title).sort()

describe('library: the spec', () => {
  it('takes agents or skills as its tab, forgiving the singular', () => {
    expect(normalizePageInput({ kind: 'library', title: 'L', tab: 'skill' })).toMatchObject({ ok: true, value: { tab: 'skills' } })
    expect(normalizePageInput({ kind: 'library', title: 'L', tab: 'tools' })).toMatchObject({ ok: false, error: expect.stringContaining('library has the tabs agents, skills') })
  })
})

describe('library: show', () => {
  it('lists the agents', async () => {
    const out = await pageTools(seededWorkspace()).show({ kind: 'library', title: 'Agents' })
    expect(titles(out)).toEqual(['Note taker'])
  })

  it("lists the skills the person can see, never a teammate's personal one or a gated system one", async () => {
    const out = await pageTools(seededWorkspace({ evals: 'off' })).show({ kind: 'library', title: 'Skills', tab: 'skills' })
    expect(titles(out)).toEqual(['Follow-up writer', 'My tone'])
    expect(allText(out)).not.toContain('Kenan secret skill')
    expect(allText(out)).not.toContain('Create eval')
    // No overrides: Evals is on, like every feature, and its skill is listed.
    const withEvals = await pageTools(seededWorkspace()).show({ kind: 'library', title: 'Skills', tab: 'skills' })
    expect(titles(withEvals)).toContain('Create eval')
  })

  it('opens one item by name on its own tab, and refuses one the person cannot see without naming it', async () => {
    const out = await pageTools(seededWorkspace()).show({ kind: 'library', title: 'Tone', target: 'my tone' })
    expect(out.card).toEqual({ kind: 'library', title: 'Tone', target: { type: 'skill', id: ID.skillMine, label: 'My tone' }, tab: 'skills' })
    const hidden = await pageTools(seededWorkspace()).show({ kind: 'library', title: 'x', target: 'Kenan secret skill' })
    expect(hidden.success).toBe(false)
    expect(hidden.error).not.toMatch(/Some there: .*Kenan secret skill/)
  })
})

describe('library: the note and read_card', () => {
  it('says the person switched to skills, and reads them', async () => {
    const parsed = parseCardContext([buildCardContextEntry({ n: 1, id: 'c', spec: { kind: 'library', title: 'Agents' }, tab: 'skills' })])
    expect(renderCardsSection(parsed)).toContain('you switched to: skills')
    const read = await pageTools(seededWorkspace(), parsed).readCard({ card: 1 })
    // Follow-up writer, My tone and Create eval (Evals is on by default).
    expect(read).toMatchObject({ success: true, showing: 'skills', total: 3 })
  })

  it("never reads a teammate's personal skill opened by a forged id, nor a gated system skill", async () => {
    for (const id of [ID.skillTheirs, ID.createEval]) {
      const forged = parseCardContext([buildCardContextEntry({ n: 1, id: 'c', spec: { kind: 'library', title: 'L', tab: 'skills' }, at: { type: 'skill', id } })])
      const read = await pageTools(seededWorkspace({ evals: 'off' }), forged).readCard({ card: 1 })
      expect(read).toMatchObject({ success: true, showing: 'skills' })
      expect(allText(read)).not.toMatch(/Kenan secret skill|Create eval/)
    }
  })
})
