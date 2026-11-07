/**
 * The pure presence rules (src/lib/presence/presence.ts): the ping parser
 * holds each surface to the states it may write, isPresent's 5-minute window,
 * the desktop's idle and lock mapping, and the page rules for active and read.
 */
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_IDLE_SECONDS,
  KEEPALIVE_MS,
  PRESENT_WINDOW_MS,
  SEEN_INPUT_WINDOW_MS,
  WEB_INPUT_WINDOW_MS,
  desktopState,
  isPresent,
  parsePresencePing,
  readingNow,
  webActive,
} from '../presence'

const CLIENT = 'a1b2c3d4e5f6a7b8'
const CONV = '11111111-2222-4333-8444-555555555555'
const NOW = Date.parse('2026-10-31T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('thresholds', () => {
  it('keeps the keepalive under the present window, so a person at the app never drops out', () => {
    expect(KEEPALIVE_MS).toBeLessThan(PRESENT_WINDOW_MS)
    expect(SEEN_INPUT_WINDOW_MS).toBeLessThanOrEqual(WEB_INPUT_WINDOW_MS)
  })
})

describe('parsePresencePing', () => {
  it('reads a web ping and a desktop ping with a seen', () => {
    expect(parsePresencePing({ clientId: CLIENT, surface: 'web', state: 'active' })).toEqual({
      ok: true,
      ping: { clientId: CLIENT, surface: 'web', state: 'active' },
    })
    expect(
      parsePresencePing({ clientId: CLIENT, surface: 'desktop', state: 'idle', seen: { conversationId: CONV, through: '2026-10-31T11:59:00.000Z' } }),
    ).toEqual({
      ok: true,
      ping: { clientId: CLIENT, surface: 'desktop', state: 'idle', seen: { conversationId: CONV, through: '2026-10-31T11:59:00.000Z' } },
    })
  })

  it('takes an offset time and a null seen', () => {
    expect(parsePresencePing({ clientId: CLIENT, surface: 'ios', state: 'hidden', seen: null }).ok).toBe(true)
    expect(parsePresencePing({ clientId: CLIENT, surface: 'web', state: 'active', seen: { conversationId: CONV, through: '2026-10-31T07:59:00-04:00' } }).ok).toBe(true)
  })

  it('reads a seen-only ping (no state: a desktop window other than main), and refuses one with neither', () => {
    expect(parsePresencePing({ clientId: CLIENT, surface: 'desktop', seen: { conversationId: CONV, through: '2026-10-31T11:59:00.000Z' } })).toEqual({
      ok: true,
      ping: { clientId: CLIENT, surface: 'desktop', seen: { conversationId: CONV, through: '2026-10-31T11:59:00.000Z' } },
    })
    expect(parsePresencePing({ clientId: CLIENT, surface: 'desktop' }).ok).toBe(false)
    expect(parsePresencePing({ clientId: CLIENT, surface: 'desktop', seen: null }).ok).toBe(false)
    expect(parsePresencePing({ clientId: CLIENT, surface: 'desktop', seen: { conversationId: 'x', through: 'y' } }).ok).toBe(false)
  })

  it('refuses a body that is not an object', () => {
    for (const body of [null, undefined, 'x', 42, [], true]) expect(parsePresencePing(body).ok).toBe(false)
  })

  it('refuses an off-shape client id', () => {
    for (const clientId of ['short', 'x'.repeat(65), 'has space1', 'semi;colon1', 'dot.in.it1', 42, undefined]) {
      expect(parsePresencePing({ clientId, surface: 'web', state: 'active' }).ok, String(clientId)).toBe(false)
    }
    expect(parsePresencePing({ clientId: 'A-b_C-d_', surface: 'web', state: 'active' }).ok).toBe(true)
    expect(parsePresencePing({ clientId: 'x'.repeat(64), surface: 'web', state: 'active' }).ok).toBe(true)
  })

  it('refuses an unknown surface or state', () => {
    expect(parsePresencePing({ clientId: CLIENT, surface: 'android', state: 'active' }).ok).toBe(false)
    expect(parsePresencePing({ clientId: CLIENT, surface: 'web', state: 'away' }).ok).toBe(false)
  })

  it('holds each surface to the states it writes: the web only ever says active', () => {
    for (const state of ['idle', 'locked', 'hidden']) expect(parsePresencePing({ clientId: CLIENT, surface: 'web', state }).ok, state).toBe(false)
    expect(parsePresencePing({ clientId: CLIENT, surface: 'desktop', state: 'hidden' }).ok).toBe(false)
    for (const state of ['active', 'idle', 'locked']) expect(parsePresencePing({ clientId: CLIENT, surface: 'desktop', state }).ok, state).toBe(true)
    for (const state of ['idle', 'locked']) expect(parsePresencePing({ clientId: CLIENT, surface: 'ios', state }).ok, state).toBe(false)
  })

  it('refuses the whole ping for an off-shape seen', () => {
    const base = { clientId: CLIENT, surface: 'web', state: 'active' }
    for (const seen of [
      'x',
      [],
      { conversationId: 'not-a-uuid', through: '2026-10-31T11:59:00Z' },
      { conversationId: CONV },
      { conversationId: CONV, through: '2026-10-31' },
      { conversationId: CONV, through: '2026-10-31T11:59:00' },
      { conversationId: CONV, through: 'yesterday' },
      { conversationId: CONV, through: '2026-13-45T99:99:00Z' },
    ]) {
      expect(parsePresencePing({ ...base, seen }).ok, JSON.stringify(seen)).toBe(false)
    }
  })
})

describe('isPresent', () => {
  it('is an active row at most 5 minutes old', () => {
    expect(isPresent([{ state: 'active', active_at: ago(0) }], NOW)).toBe(true)
    expect(isPresent([{ state: 'active', active_at: ago(PRESENT_WINDOW_MS) }], NOW)).toBe(true)
    expect(isPresent([{ state: 'active', active_at: ago(PRESENT_WINDOW_MS + 1) }], NOW)).toBe(false)
  })

  it('ignores idle, locked and hidden rows however fresh their active_at', () => {
    for (const state of ['idle', 'locked', 'hidden'] as const) expect(isPresent([{ state, active_at: ago(1_000) }], NOW)).toBe(false)
  })

  it('ignores an active row with no active_at or an unreadable one', () => {
    expect(isPresent([{ state: 'active', active_at: null }], NOW)).toBe(false)
    expect(isPresent([{ state: 'active', active_at: 'soon' }], NOW)).toBe(false)
  })

  it('any one fresh active row is enough; none is absent', () => {
    expect(isPresent([], NOW)).toBe(false)
    expect(
      isPresent(
        [
          { state: 'locked', active_at: ago(60_000) },
          { state: 'active', active_at: ago(PRESENT_WINDOW_MS * 3) },
          { state: 'active', active_at: ago(30_000) },
        ],
        NOW,
      ),
    ).toBe(true)
  })
})

describe('desktopState', () => {
  it('a locked screen is locked, whatever the idle time', () => {
    expect(desktopState({ idleSeconds: 0, locked: true })).toBe('locked')
    expect(desktopState({ idleSeconds: 9_999, locked: true })).toBe('locked')
  })

  it('idle only past 180 s without input', () => {
    expect(desktopState({ idleSeconds: DESKTOP_IDLE_SECONDS, locked: false })).toBe('active')
    expect(desktopState({ idleSeconds: DESKTOP_IDLE_SECONDS + 0.5, locked: false })).toBe('idle')
    expect(desktopState({ idleSeconds: 3, locked: false })).toBe('active')
  })
})

describe('the page rules', () => {
  const page = (over: Partial<{ visible: boolean; focused: boolean; lastInputAt: number }> = {}) => ({
    visible: true,
    focused: true,
    lastInputAt: NOW - 1_000,
    ...over,
  })

  it('webActive: visible, focused, input in the last 4 minutes', () => {
    expect(webActive(page(), NOW)).toBe(true)
    expect(webActive(page({ lastInputAt: NOW - WEB_INPUT_WINDOW_MS }), NOW)).toBe(true)
    expect(webActive(page({ lastInputAt: NOW - WEB_INPUT_WINDOW_MS - 1 }), NOW)).toBe(false)
    expect(webActive(page({ visible: false }), NOW)).toBe(false)
    expect(webActive(page({ focused: false }), NOW)).toBe(false)
    expect(webActive(page({ lastInputAt: 0 }), NOW)).toBe(false)
  })

  it('readingNow: the same, with input in the last 2 minutes', () => {
    expect(readingNow(page({ lastInputAt: NOW - SEEN_INPUT_WINDOW_MS }), NOW)).toBe(true)
    expect(readingNow(page({ lastInputAt: NOW - SEEN_INPUT_WINDOW_MS - 1 }), NOW)).toBe(false)
    expect(readingNow(page({ focused: false }), NOW)).toBe(false)
    expect(readingNow(page({ visible: false }), NOW)).toBe(false)
  })
})
