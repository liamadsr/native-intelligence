/**
 * The onboarding kickoff body → Priming. Tolerant by contract: priming is a
 * nicety folded into the researcher brief, never a gate on starting research,
 * and it switches no feature on or off (every workspace has every feature).
 */
import { describe, it, expect } from 'vitest'
import { parsePriming, splitRoleString } from '@/lib/onboarding/research-priming'
import type { NextRequest } from 'next/server'

/**
 * The kickoff body carries roles TWICE on purpose: `role` is the comma-joined
 * sentence the researcher brief has always read, `roles[]` is the unflattened
 * chips the brief carries as exact picks. The route must persist both, and must
 * degrade to re-splitting when a legacy client sends only the string.
 */
function req(body: unknown): NextRequest {
  return {
    json: async () => {
      if (body === undefined) throw new Error('no body')
      return body
    },
  } as unknown as NextRequest
}

describe('parsePriming — roles array', () => {
  it('keeps the joined `role` string UNCHANGED alongside the array', async () => {
    const p = await parsePriming(req({ role: 'Sales, Marketing', roles: ['Sales', 'Marketing'] }))
    expect(p.role).toBe('Sales, Marketing')
    expect(p.roles).toEqual(['Sales', 'Marketing'])
  })

  it('prefers the client array over re-splitting (a comma-bearing Other survives)', async () => {
    const p = await parsePriming(
      req({ role: 'Sales, Ops, but for lawyers', roles: ['Sales', 'Ops, but for lawyers'] }),
    )
    expect(p.roles).toEqual(['Sales', 'Ops, but for lawyers'])
  })

  it('falls back to splitting `role` when a legacy client sends no array', async () => {
    const p = await parsePriming(req({ role: 'Sales, Engineering' }))
    expect(p.roles).toEqual(['Sales', 'Engineering'])
  })

  it('drops non-strings and blanks inside the array', async () => {
    const p = await parsePriming(req({ role: 'Sales', roles: ['Sales', '', '  ', 7, null] }))
    expect(p.roles).toEqual(['Sales'])
  })

  it('omits `roles` entirely when nothing survives', async () => {
    const p = await parsePriming(req({ focus: 'shipping v2' }))
    expect(p.roles).toBeUndefined()
    expect(p.focus).toBe('shipping v2')
  })

  it('never throws on a malformed body — priming is a nicety, not a gate', async () => {
    await expect(parsePriming(req(undefined))).resolves.toEqual({})
    await expect(parsePriming(req('nope'))).resolves.toEqual({})
  })

  it('caps the array length and each chip', async () => {
    const p = await parsePriming(
      req({ role: 'x', roles: Array.from({ length: 40 }, (_, i) => `role-${i}`) }),
    )
    expect(p.roles!.length).toBeLessThanOrEqual(10)
    const long = await parsePriming(req({ role: 'x', roles: ['a'.repeat(500)] }))
    expect(long.roles![0].length).toBeLessThanOrEqual(60)
  })
})

describe('splitRoleString', () => {
  it('splits the joined chips and trims each', () => {
    expect(splitRoleString('Sales, Marketing')).toEqual(['Sales', 'Marketing'])
    expect(splitRoleString(' Sales ,, Engineering ')).toEqual(['Sales', 'Engineering'])
  })

  it('returns nothing for an empty or missing string', () => {
    expect(splitRoleString('')).toEqual([])
    expect(splitRoleString(undefined)).toEqual([])
    expect(splitRoleString(null)).toEqual([])
  })
})
