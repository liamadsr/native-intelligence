/**
 * Scoped instances must ignore any restored crm_scope / capture_scope.
 *
 * A UnifiedViewLayout with scopeFilters (Company → People, Contact → Actions,
 * Contact → Captures) hides the built-in scope pills, but a scope can still
 * arrive through a RESTORED config — a stale localStorage draft or a
 * saved-view config carrying 'companies' (which would flip Company → People
 * into a list of ALL companies in the workspace), 'internal'/'external'
 * (which would silently drop rows), or a capture 'mine'/'shared' (which would
 * partition a parent-pinned capture list by ownership). sanitizeScopedConfig
 * is the source-level guard: under a scope, any non-default crm_scope
 * collapses to 'contacts' and any non-default capture_scope collapses to
 * 'all', so both effectiveEntityType and the query request see the scopes as
 * unset.
 */
import { describe, it, expect } from 'vitest'
import { sanitizeScopedConfig } from '../unified-view-layout'
import type { CrmScope } from '@/lib/views/types'

type CaptureScope = 'all' | 'mine' | 'shared'

const config = (crm_scope: CrmScope, capture_scope: CaptureScope = 'all') =>
  ({ crm_scope, capture_scope, layout: 'list' as const })

describe('sanitizeScopedConfig', () => {
  it.each(['companies', 'internal', 'external'] as const)(
    'neutralizes a restored crm_scope=%s in a scoped instance',
    (scope) => {
      expect(sanitizeScopedConfig(config(scope), true).crm_scope).toBe('contacts')
    },
  )

  it.each(['mine', 'shared'] as const)(
    'neutralizes a restored capture_scope=%s in a scoped instance',
    (scope) => {
      expect(sanitizeScopedConfig(config('contacts', scope), true).capture_scope).toBe('all')
    },
  )

  it("keeps the effective entity type 'contact' — the Companies flip can never fire under a scope", () => {
    const sanitized = sanitizeScopedConfig(config('companies'), true)
    // Mirrors the effectiveEntityType derivation in unified-view-layout /
    // view-toolbar: contact + crm_scope 'companies' → 'company'.
    const effectiveEntityType = sanitized.crm_scope === 'companies' ? 'company' : 'contact'
    expect(effectiveEntityType).toBe('contact')
  })

  it('leaves an UNSCOPED instance alone — the global CRM and Captures pages keep their scope tabs working', () => {
    expect(sanitizeScopedConfig(config('companies'), false).crm_scope).toBe('companies')
    expect(sanitizeScopedConfig(config('internal'), false).crm_scope).toBe('internal')
    expect(sanitizeScopedConfig(config('contacts', 'mine'), false).capture_scope).toBe('mine')
    expect(sanitizeScopedConfig(config('contacts', 'shared'), false).capture_scope).toBe('shared')
  })

  it('is identity (same reference) when there is nothing to neutralize', () => {
    const scopedDefault = config('contacts')
    expect(sanitizeScopedConfig(scopedDefault, true)).toBe(scopedDefault)
    const unscoped = config('companies', 'mine')
    expect(sanitizeScopedConfig(unscoped, false)).toBe(unscoped)
  })

  it('does not mutate the input and preserves the rest of the config', () => {
    const original = config('companies', 'shared')
    const sanitized = sanitizeScopedConfig(original, true)
    expect(original.crm_scope).toBe('companies')
    expect(original.capture_scope).toBe('shared')
    expect(sanitized.capture_scope).toBe('all')
    expect(sanitized.layout).toBe('list')
  })
})
