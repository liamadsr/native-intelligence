import { describe, expect, it } from 'vitest'
import { parseWatchReadResult, WATCH_READ_MAX_CHARS } from '../watch-read'

describe('parseWatchReadResult', () => {
  it('reads a page read, cutting text past the cap', () => {
    expect(parseWatchReadResult({ ok: true, url: 'https://app.example.com/orders', text: 'Orders' })).toEqual({ ok: true, url: 'https://app.example.com/orders', text: 'Orders' })
    const long = parseWatchReadResult({ ok: true, url: 'https://app.example.com/', text: 'x'.repeat(WATCH_READ_MAX_CHARS + 50) })
    expect(long).toMatchObject({ ok: true })
    expect(long && long.ok && long.text.length).toBe(WATCH_READ_MAX_CHARS)
  })

  it('reads a stop with its site', () => {
    expect(parseWatchReadResult({ ok: false, code: 'site_blocked', site: 'example.com' })).toEqual({ ok: false, code: 'site_blocked', site: 'example.com' })
    expect(parseWatchReadResult({ ok: false, code: 'taken_over' })).toEqual({ ok: false, code: 'taken_over' })
  })

  it('is null for anything else: another command\'s result, an unknown stop, a malformed read', () => {
    for (const raw of [null, 'text', [], { url: 'https://example.com/', text: 'Hi' }, { ok: true, url: 'https://example.com/' }, { ok: false, code: 'exploded' }, { ok: false }]) {
      expect(parseWatchReadResult(raw)).toBeNull()
    }
  })
})
