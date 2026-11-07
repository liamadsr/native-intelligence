/**
 * Knowledge as a card: the claims (a dismissed claim is not knowledge), the
 * library's packages (only those the person can see: workspace ones, their
 * own, and ones shared with them), and one package.
 */
import { describe, expect, it } from 'vitest'
import { normalizePageInput } from '../page-validate'
import { buildCardContextEntry, parseCardContext } from '../context'
import { ID, ME, OTHER_USER, WS, allText, pageTools, seededWorkspace } from './page-fixtures'

describe('knowledge: the spec', () => {
  it('a package target opens the library tab', () => {
    expect(normalizePageInput({ kind: 'knowledge', title: 'K', target: 'Sales playbook' })).toMatchObject({ ok: true, value: { tab: 'library', target: 'Sales playbook' } })
    expect(normalizePageInput({ kind: 'knowledge', title: 'K', tab: 'graph' })).toMatchObject({ ok: false, error: expect.stringContaining('knowledge has the tabs claims, library') })
  })
})

describe('knowledge: show and read_card', () => {
  it('shows the claims, the dismissed one left out', async () => {
    const out = await pageTools(seededWorkspace()).show({ kind: 'knowledge', title: 'Knowledge' })
    expect(out).toMatchObject({ success: true, count: 1, items: [{ title: 'Pricing moves to $99' }] })
  })

  it("never lists a claim known only from someone else's chat or from mail (341, 353)", async () => {
    const db = seededWorkspace()
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    db.seed('claim', [
      { id: id(861), text: 'Kenan is negotiating his salary', status: 'active', confirmation: 'confirmed', workspace_id: WS, created_at: '2026-10-03' },
      { id: id(862), text: 'My own chat claim', status: 'active', confirmation: 'confirmed', workspace_id: WS, created_at: '2026-10-04' },
      { id: id(863), text: 'Learned from an email', status: 'active', confirmation: 'confirmed', workspace_id: WS, created_at: '2026-10-05' },
    ])
    db.seed('claim_source', [
      { id: id(871), claim_id: id(861), workspace_id: WS, source_type: 'conversation', source_id: id(881) },
      { id: id(872), claim_id: id(862), workspace_id: WS, source_type: 'conversation', source_id: id(882) },
      { id: id(873), claim_id: id(863), workspace_id: WS, source_type: 'email', source_id: id(883) },
    ])
    db.seed('chat_conversations', [
      { id: id(881), workspace_id: WS, user_id: OTHER_USER, title: 'Salary' },
      { id: id(882), workspace_id: WS, user_id: ME, title: 'Mine' },
    ])
    const out = await pageTools(db).show({ kind: 'knowledge', title: 'Knowledge' })
    expect((out.items as Array<{ title: string }>).map((i) => i.title).sort()).toEqual(['My own chat claim', 'Pricing moves to $99'])
    expect(out.count).toBe(2)
    expect(allText(out)).not.toMatch(/salary|email/i)
  })

  it('lists only the packages the person can see', async () => {
    const out = await pageTools(seededWorkspace()).show({ kind: 'knowledge', title: 'Library', tab: 'library' })
    expect((out.items as Array<{ title: string }>).map((i) => i.title).sort()).toEqual(['Board prep', 'Sales playbook'])
    expect(allText(out)).not.toContain('Kenan notes')
  })

  it("never opens or names a package not shared with the person", async () => {
    const out = await pageTools(seededWorkspace()).show({ kind: 'knowledge', title: 'x', target: 'Kenan notes' })
    expect(out.success).toBe(false)
    expect(out.error).toContain("no knowledge package named 'Kenan notes' that you can open here")
    expect(out.error).not.toMatch(/Some there: .*Kenan notes/)
    const forged = parseCardContext([buildCardContextEntry({ n: 1, id: 'c', spec: { kind: 'knowledge', title: 'K', tab: 'library' }, at: { type: 'package', id: ID.pkgPersonal } })])
    const read = await pageTools(seededWorkspace(), forged).readCard({ card: 1 })
    expect(allText(read)).not.toContain('Kenan notes')
    expect(read).toMatchObject({ success: true, showing: 'knowledge packages' })
  })

  it("opens a package and reads what is pinned in it, by kind", async () => {
    const out = await pageTools(seededWorkspace()).show({ kind: 'knowledge', title: 'Playbook', target: 'sales playbook' })
    expect(out.card).toEqual({ kind: 'knowledge', title: 'Playbook', target: { type: 'package', id: ID.pkgOpen, label: 'Sales playbook' }, tab: 'library' })
    expect((out.items as Array<{ title: string }>).map((i) => i.title).sort()).toEqual(['1 pinned capture', '1 pinned claim'])
  })
})
