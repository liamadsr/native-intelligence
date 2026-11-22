/**
 * Knowledge and the Library as cards (Liam, 11-21: the Knowledge page split
 * in two). Knowledge: the claims (a dismissed claim is not knowledge). The
 * Library: the packages (only those the person can see: workspace ones,
 * their own, and ones shared with them), and one package. A package asked of
 * Knowledge, and a card saved on its old library tab, open the Library.
 */
import { describe, expect, it } from 'vitest'
import { normalizePageInput } from '../page-validate'
import { buildCardContextEntry, parseCardContext } from '../context'
import { cardFromShowOutput } from '../kinds'
import { openedCardFromPart, OPENED_CARD_PART_TYPE } from '../opened-card'
import { PAGE_KINDS, SHOW_PAGE_KIND_NAMES } from '../pages'
import { ID, ME, OTHER_USER, WS, allText, pageTools, seededWorkspace } from './page-fixtures'

describe('knowledge and the Library: the spec', () => {
  it('are two pages: Knowledge has no tabs and no target, the Library takes a package', () => {
    expect(PAGE_KINDS.knowledge).toMatchObject({ label: 'Knowledge', view: 'knowledge', rootEntity: 'claim' })
    expect(PAGE_KINDS.knowledge.tabs).toBeUndefined()
    expect(PAGE_KINDS.knowledge.target).toBeUndefined()
    // Gated with Knowledge: off exactly when it is.
    expect(PAGE_KINDS.knowledge_library).toMatchObject({ label: 'Library', view: 'knowledge', target: { types: ['package'] } })
    expect(PAGE_KINDS.knowledge_library.tabs).toBeUndefined()
    expect(SHOW_PAGE_KIND_NAMES).toEqual(expect.arrayContaining(['knowledge', 'knowledge_library']))
    // `library` is still Agents & skills.
    expect(PAGE_KINDS.library.label).toBe('Agents & skills')
  })

  it('a package, or the old library tab, asked of Knowledge opens the Library', () => {
    expect(normalizePageInput({ kind: 'knowledge', title: 'K', target: 'Sales playbook' })).toEqual({
      ok: true,
      value: { kind: 'knowledge_library', title: 'K', target: 'Sales playbook' },
    })
    expect(normalizePageInput({ kind: 'knowledge', title: 'Library', tab: 'library' })).toEqual({ ok: true, value: { kind: 'knowledge_library', title: 'Library' } })
    expect(normalizePageInput({ kind: 'knowledge_library', title: 'Playbook', target: 'Sales playbook' })).toMatchObject({ ok: true, value: { kind: 'knowledge_library' } })
    expect(normalizePageInput({ kind: 'knowledge', title: 'K', tab: 'graph' })).toMatchObject({ ok: false, error: expect.stringContaining('knowledge has no tabs') })
    // Its old claims tab is Knowledge itself now: forgiven, never refused.
    expect(normalizePageInput({ kind: 'knowledge', title: 'Claims', tab: 'claims' })).toEqual({ ok: true, value: { kind: 'knowledge', title: 'Claims' } })
  })

  it('a card saved before the split, on the old library tab or a package, opens as the Library', () => {
    const shown = cardFromShowOutput({ success: true, card: { kind: 'knowledge', title: 'Playbook', target: { type: 'package', id: 'p1', label: 'Sales playbook' }, tab: 'library' } })
    expect(shown?.spec).toEqual({ kind: 'knowledge_library', title: 'Playbook', target: { type: 'package', id: 'p1', label: 'Sales playbook' } })
    expect(cardFromShowOutput({ success: true, card: { kind: 'knowledge', title: 'Knowledge', tab: 'library' } })?.spec).toEqual({ kind: 'knowledge_library', title: 'Library' })
    const opened = openedCardFromPart({ type: OPENED_CARD_PART_TYPE, id: 'o1', data: { card: { kind: 'knowledge', title: 'Pricing', target: { type: 'package', id: 'p2' } }, card_number: 2, page: 'knowledge' } })
    expect(opened?.spec).toEqual({ kind: 'knowledge_library', title: 'Pricing', target: { type: 'package', id: 'p2' } })
    // Knowledge itself, and its old claims tab, stay Knowledge (which has no tabs now).
    expect(cardFromShowOutput({ success: true, card: { kind: 'knowledge', title: 'Knowledge' } })?.spec).toEqual({ kind: 'knowledge', title: 'Knowledge' })
    expect(cardFromShowOutput({ success: true, card: { kind: 'knowledge', title: 'Claims', tab: 'claims' } })?.spec).toEqual({ kind: 'knowledge', title: 'Claims' })
    // Anything else on Knowledge is still refused by the checks.
    expect(cardFromShowOutput({ success: true, card: { kind: 'knowledge', title: 'K', tab: 'graph' } })).toBeNull()
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
})

describe('the Library: show and read_card', () => {
  it('lists only the packages the person can see', async () => {
    const out = await pageTools(seededWorkspace()).show({ kind: 'knowledge_library', title: 'Library' })
    expect(out).toMatchObject({ success: true, card: { kind: 'knowledge_library', title: 'Library' } })
    expect((out.items as Array<{ title: string }>).map((i) => i.title).sort()).toEqual(['Board prep', 'Sales playbook'])
    expect(allText(out)).not.toContain('Kenan notes')
  })

  it("never opens or names a package not shared with the person", async () => {
    const out = await pageTools(seededWorkspace()).show({ kind: 'knowledge_library', title: 'x', target: 'Kenan notes' })
    expect(out.success).toBe(false)
    expect(out.error).toContain("no knowledge package named 'Kenan notes' that you can open here")
    expect(out.error).not.toMatch(/Some there: .*Kenan notes/)
    const forged = parseCardContext([buildCardContextEntry({ n: 1, id: 'c', spec: { kind: 'knowledge_library', title: 'L' }, at: { type: 'package', id: ID.pkgPersonal } })])
    const read = await pageTools(seededWorkspace(), forged).readCard({ card: 1 })
    expect(allText(read)).not.toContain('Kenan notes')
    expect(read).toMatchObject({ success: true, showing: 'knowledge packages' })
  })

  it('opens a package and reads what is pinned in it, by kind: asked of the Library, or of Knowledge', async () => {
    for (const kind of ['knowledge_library', 'knowledge']) {
      const out = await pageTools(seededWorkspace()).show({ kind, title: 'Playbook', target: 'sales playbook' })
      expect(out.card, kind).toEqual({ kind: 'knowledge_library', title: 'Playbook', target: { type: 'package', id: ID.pkgOpen, label: 'Sales playbook' } })
      expect((out.items as Array<{ title: string }>).map((i) => i.title).sort()).toEqual(['1 pinned capture', '1 pinned claim'])
    }
  })

  it('reads a Knowledge card for its claims, never a package placed on it', async () => {
    const entry = parseCardContext([buildCardContextEntry({ n: 1, id: 'c', spec: { kind: 'knowledge', title: 'K' }, at: { type: 'package', id: ID.pkgOpen } })])
    const read = await pageTools(seededWorkspace(), entry).readCard({ card: 1 })
    expect(read).toMatchObject({ success: true, showing: 'claims' })
  })
})
