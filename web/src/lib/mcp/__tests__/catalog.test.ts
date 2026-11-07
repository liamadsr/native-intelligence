/**
 * The catalog stamp. Its whole job is to change when the tool list changes and
 * not otherwise — it is what tells an agent holding a stale list that it is
 * holding a stale list.
 */
import { describe, it, expect } from 'vitest'
import { catalogFingerprint, describeCatalog, staleCatalogHint } from '../catalog'

describe('catalogFingerprint', () => {
  it('is stable and independent of order and duplicates', () => {
    const a = catalogFingerprint(['dial8_b', 'dial8_a', 'dial8_c'])
    expect(catalogFingerprint(['dial8_a', 'dial8_b', 'dial8_c'])).toBe(a)
    expect(catalogFingerprint(['dial8_c', 'dial8_c', 'dial8_b', 'dial8_a'])).toBe(a)
    expect(a).toMatch(/^[0-9a-f]{8}$/)
  })

  it('changes when a tool is added or removed', () => {
    const before = catalogFingerprint(['dial8_a', 'dial8_b'])
    expect(catalogFingerprint(['dial8_a', 'dial8_b', 'dial8_c'])).not.toBe(before)
    expect(catalogFingerprint(['dial8_a'])).not.toBe(before)
  })
})

describe('describeCatalog', () => {
  it('counts unique names', () => {
    expect(describeCatalog(['dial8_a', 'dial8_a', 'dial8_b'])).toEqual({
      version: catalogFingerprint(['dial8_a', 'dial8_b']),
      tool_count: 2,
    })
  })
})

describe('staleCatalogHint', () => {
  it('names the count, the version, and both ways out', () => {
    const hint = staleCatalogHint({ version: 'ab12cd34', tool_count: 165 })
    expect(hint).toContain('165 tools')
    expect(hint).toContain('ab12cd34')
    expect(hint).toContain('dial8_call_tool')
    expect(hint).toContain('reconnect')
  })
})
