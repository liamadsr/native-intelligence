import { describe, it, expect } from 'vitest'
import { CREATE_TYPES, CREATE_TYPE_GROUPS, availableCreateTypes, isCreateTypeId } from '../create-types'
import { CARD_PAGES, pagesFor } from '@/lib/chat-cards/page-menu'
import { getEdition } from '@/lib/editions/manifest'

describe('create types', () => {
  it('keeps the dialog’s six forms, always offered, and the types with no page of their own', () => {
    const forms = CREATE_TYPES.filter((t) => t.mode === 'form').map((t) => t.id)
    expect(forms.sort()).toEqual(['action', 'contact', 'email', 'event', 'initiative', 'project'])
    const always = CREATE_TYPES.filter((t) => t.always).map((t) => t.id)
    expect(always).toEqual(['snippet'])
    expect(availableCreateTypes([]).map((t) => t.id).sort()).toEqual([...forms, ...always].sort())
  })

  it('names a real `/` page for every other type, and a group the picker draws', () => {
    const slugs = new Set(CARD_PAGES.map((p) => p.slug))
    const groups = new Set(CREATE_TYPE_GROUPS.map((g) => g.id))
    for (const t of CREATE_TYPES) {
      expect(groups.has(t.group), t.id).toBe(true)
      if (t.mode !== 'form' && !t.always) expect(slugs.has(t.page!), `${t.id} → ${t.page}`).toBe(true)
      if (t.always) expect(t.page, `${t.id} has no page`).toBeUndefined()
      expect(t.opensPage === true, t.id).toBe(t.mode === 'page')
    }
  })

  it('offers a type only while the workspace has its page (a guest: no Studio)', () => {
    const full = getEdition('full')
    const member = availableCreateTypes(pagesFor(full, { desktop: false }).map((p) => p.slug)).map((t) => t.id)
    expect(member).toEqual(expect.arrayContaining(['company', 'document', 'table', 'agent', 'flow', 'studio_project', 'studio_video', 'channel']))
    const guest = availableCreateTypes(pagesFor(full, { desktop: false, guest: true }).map((p) => p.slug)).map((t) => t.id)
    expect(guest).not.toContain('studio_project')
    expect(guest).not.toContain('studio_video')
  })

  it('knows its ids', () => {
    expect(isCreateTypeId('company')).toBe(true)
    expect(isCreateTypeId('label')).toBe(false)
    expect(isCreateTypeId(undefined)).toBe(false)
  })
})
