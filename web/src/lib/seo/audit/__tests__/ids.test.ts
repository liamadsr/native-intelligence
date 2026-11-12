/**
 * Row ids derived from what a row is about (../ids.ts): a retried crawl step
 * must write the same ids again, distinct things must never share one, and
 * every id must be a UUID Postgres accepts.
 */
import { describe, expect, it } from 'vitest'
import { issueRowId, pageRowId, sha256Hex } from '../ids'

const UUID_V8 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const AUDIT = '6f1c2d3e-4b5a-4c6d-8e7f-1a2b3c4d5e6f'

describe('sha256Hex', () => {
  it('is the SHA-256 of the text, in hex', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('pageRowId', () => {
  it('is stable for the same audit and URL', () => {
    expect(pageRowId(AUDIT, 'https://example.com/a')).toBe(
      pageRowId(AUDIT, 'https://example.com/a'),
    )
  })

  it('differs when the audit or the URL differs', () => {
    const id = pageRowId(AUDIT, 'https://example.com/a')
    expect(pageRowId(AUDIT, 'https://example.com/b')).not.toBe(id)
    expect(pageRowId('another-audit', 'https://example.com/a')).not.toBe(id)
  })

  it('keeps the parts apart: ("a", "bc") is not ("ab", "c")', () => {
    expect(pageRowId('a', 'bc')).not.toBe(pageRowId('ab', 'c'))
  })

  it('is a valid UUID (version 8, RFC 9562 variant)', () => {
    for (let i = 0; i < 200; i++) {
      expect(pageRowId(AUDIT, `https://example.com/${i}`)).toMatch(UUID_V8)
    }
  })
})

describe('issueRowId', () => {
  it('is stable, and an absent key is the empty key', () => {
    const id = issueRowId(AUDIT, 'broken-page', 'https://example.com/a')
    expect(issueRowId(AUDIT, 'broken-page', 'https://example.com/a')).toBe(id)
    expect(issueRowId(AUDIT, 'broken-page', 'https://example.com/a', '')).toBe(
      id,
    )
    expect(id).toMatch(UUID_V8)
  })

  it('differs when any part differs', () => {
    const id = issueRowId(AUDIT, 'broken-page', 'https://example.com/a', 'k')
    expect(
      issueRowId('another-audit', 'broken-page', 'https://example.com/a', 'k'),
    ).not.toBe(id)
    expect(
      issueRowId(AUDIT, 'server-error', 'https://example.com/a', 'k'),
    ).not.toBe(id)
    expect(
      issueRowId(AUDIT, 'broken-page', 'https://example.com/b', 'k'),
    ).not.toBe(id)
    expect(
      issueRowId(AUDIT, 'broken-page', 'https://example.com/a', 'other'),
    ).not.toBe(id)
  })

  it('keeps the parts apart across every boundary', () => {
    expect(issueRowId('a', 'bc', 'd')).not.toBe(issueRowId('ab', 'c', 'd'))
    expect(issueRowId('a', 'b', 'cd')).not.toBe(issueRowId('a', 'bc', 'd'))
    expect(issueRowId('a', 'b', 'c', 'd')).not.toBe(issueRowId('a', 'b', 'cd'))
  })

  it('never collides with a page id built from the same strings', () => {
    expect(issueRowId(AUDIT, 'https://example.com/a', '')).not.toBe(
      pageRowId(AUDIT, 'https://example.com/a'),
    )
  })
})
