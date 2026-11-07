import { describe, it, expect } from 'vitest'
import { classifyToolAccess, isReadOnlyToken } from '../guard'

/**
 * The guard is the single enforcement point for token scopes over MCP. The
 * invariants locked in here:
 *   - classification FAILS CLOSED: anything not recognizably a read is a write
 *   - read-only tokens keep workspace navigation (set_workspace)
 *   - legacy tokens (empty scopes) keep full access
 */

describe('classifyToolAccess', () => {
  it('classifies read-shaped tools as read', () => {
    for (const name of [
      'get_claim',
      'get_context_bundle',
      'list_claims',
      'list_packages',
      'find',
      'search',
      'search_claims',
      'deep_search',
      'read_email',
      'traverse',
    ]) {
      expect(classifyToolAccess(name), name).toBe('read')
    }
  })

  it('classifies the primary retrieval tool `find` as read (not fail-closed to write)', () => {
    // `find` is the front-door retrieval tool — a read-only MCP token MUST be
    // able to call it. Regression guard: the READ_PATTERNS regexes (/^search/,
    // /^get_/, …) don't match the bare word "find", so without an explicit
    // /^find$/ pattern it fell closed to 'write' and read-only tokens were
    // blocked from the primary retrieval path.
    expect(classifyToolAccess('find')).toBe('read')
    expect(classifyToolAccess('dial8_find')).toBe('read')
  })

  it('strips the dial8_ prefix MCP names carry', () => {
    expect(classifyToolAccess('dial8_list_claims')).toBe('read')
    expect(classifyToolAccess('dial8_create_claim')).toBe('write')
  })

  it('classifies mutating tools as write', () => {
    for (const name of [
      'create_claim',
      'update_action',
      'delete_skill',
      'confirm_claim',
      'dismiss_decision',
      'supersede_claim',
      'link_entities',
      'ingest_source',
      'create_package',
      'add_to_package',
      'publish_draft',
      'send_imessage',
    ]) {
      expect(classifyToolAccess(name), name).toBe('write')
    }
  })

  it('fails closed on unknown shapes', () => {
    expect(classifyToolAccess('frobnicate_workspace')).toBe('write')
    expect(classifyToolAccess('')).toBe('write')
  })

  it('allows workspace navigation under read-only (session scope, not data)', () => {
    expect(classifyToolAccess('set_workspace')).toBe('read')
    expect(classifyToolAccess('dial8_set_workspace')).toBe('read')
  })
})

describe('isReadOnlyToken', () => {
  it('treats empty/missing scopes as full access (legacy tokens)', () => {
    expect(isReadOnlyToken([])).toBe(false)
    expect(isReadOnlyToken(null)).toBe(false)
    expect(isReadOnlyToken(undefined)).toBe(false)
  })

  it('read without write is read-only', () => {
    expect(isReadOnlyToken(['read'])).toBe(true)
  })

  it('write grants full access', () => {
    expect(isReadOnlyToken(['read', 'write'])).toBe(false)
    expect(isReadOnlyToken(['write'])).toBe(false)
  })
})
