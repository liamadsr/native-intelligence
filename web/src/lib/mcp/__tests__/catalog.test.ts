/**
 * The catalog stamp. Its whole job is to change when the tool list changes and
 * not otherwise — it is what tells an agent holding a stale list that it is
 * holding a stale list.
 */
import { describe, it, expect } from 'vitest'
import { catalogFingerprint, describeCatalog, staleCatalogHint } from '../catalog'

describe('catalogFingerprint', () => {
  it('is stable and independent of order and duplicates', () => {
    const a = catalogFingerprint(['ni_b', 'ni_a', 'ni_c'])
    expect(catalogFingerprint(['ni_a', 'ni_b', 'ni_c'])).toBe(a)
    expect(catalogFingerprint(['ni_c', 'ni_c', 'ni_b', 'ni_a'])).toBe(a)
    expect(a).toMatch(/^[0-9a-f]{8}$/)
  })

  it('changes when a tool is added or removed', () => {
    const before = catalogFingerprint(['ni_a', 'ni_b'])
    expect(catalogFingerprint(['ni_a', 'ni_b', 'ni_c'])).not.toBe(before)
    expect(catalogFingerprint(['ni_a'])).not.toBe(before)
  })
})

describe('describeCatalog', () => {
  it('counts unique names', () => {
    expect(describeCatalog(['ni_a', 'ni_a', 'ni_b'])).toEqual({
      version: catalogFingerprint(['ni_a', 'ni_b']),
      tool_count: 2,
    })
  })
})

describe('staleCatalogHint', () => {
  it('names the count, the version, and both ways out', () => {
    const hint = staleCatalogHint({ version: 'ab12cd34', tool_count: 165 })
    expect(hint).toContain('165 tools')
    expect(hint).toContain('ab12cd34')
    expect(hint).toContain('ni_call_tool')
    expect(hint).toContain('reconnect')
  })
})
