/**
 * The worker's JSON lines restate the launcher's (launcher/launcher.ts runs
 * its main() when bundled, so it is not imported by the workers). These tests
 * hold the two copies together, and pin what a worker does differently.
 */
import { describe, expect, it } from 'vitest'
import * as launcher from '../../launcher/launcher'
import { MANAGER_LIMITS, TEXT_LIMIT, createLineSplitter, isSessionId, managerText, parseInbound, serializeLine, truncateJson, truncateText } from '../lib/protocol'

const LINES = [
  '{"type":"start","request":"look at the README"}',
  '{"type":"start","request":"  "}',
  '{"type":"resume","sessionId":"ses_1","streamIndex":3}',
  '{"type":"resume","sessionId":"ses_1","streamIndex":-1}',
  '{"type":"resume","sessionId":"","streamIndex":0}',
  '{"type":"send","text":"also the tests","policy":"steer"}',
  '{"type":"send","text":"later","policy":"queue"}',
  '{"type":"send","text":"x","policy":"now"}',
  '{"type":"stop"}',
  '{"type":"heartbeat"}',
  'not json',
  '[1,2]',
  'null',
]

describe('the worker protocol and the launcher agree', () => {
  it.each(LINES)('parses %s the same way', (line) => {
    expect(parseInbound(line)).toEqual(launcher.parseInbound(line))
  })

  it('serializes and splits lines the same way', () => {
    const msg = { type: 'event' as const, event: { kind: 'message' as const, text: 'a b c "q"' } }
    expect(serializeLine(msg)).toBe(launcher.serializeLine(msg))
    const ours: string[] = []
    const theirs: string[] = []
    const a = createLineSplitter((l) => ours.push(l))
    const b = launcher.createLineSplitter((l) => theirs.push(l))
    const bytes = new TextEncoder().encode('{"x":"é"}\r\n{"y":1}\nrest')
    for (const s of [a, b]) {
      s.push(bytes.subarray(0, 7)) // splits the é across two chunks
      s.push(bytes.subarray(7))
      s.end()
    }
    expect(ours).toEqual(['{"x":"é"}', '{"y":1}', 'rest'])
    expect(ours).toEqual(theirs)
  })

  it('cuts tool input and output the same way', () => {
    for (const v of ['short', 'x'.repeat(5000), { a: [1, 2, 3] }, undefined]) {
      expect(truncateJson(v, 2048)).toBe(launcher.truncateJson(v, 2048))
    }
  })
})

describe('what a worker reads differently', () => {
  it('takes only a canonical lowercase UUID as a session id (it goes on a command line)', () => {
    expect(isSessionId('aaaaaaaa-1111-4222-8333-444444444444')).toBe(true)
    for (const id of ['-x', '--last', '--settings={}', 'AAAAAAAA-1111-4222-8333-444444444444', 'aaaaaaaa-1111-4222-8333-444444444444 ', 'thr_1', '', 7, null]) expect(isSessionId(id), String(id)).toBe(false)
  })

  it('skips a line past the cap whole, in one chunk or many, and says so once per line', () => {
    const lines: string[] = []
    let tooLong = 0
    const s = createLineSplitter((l) => lines.push(l), { maxBytes: 8, onTooLong: () => (tooLong += 1) })
    const bytes = (t: string) => new TextEncoder().encode(t)
    s.push(bytes('short\n0123456789\nok\n'))
    s.push(bytes('abcdefghij'))
    s.push(bytes('klmnop'))
    s.push(bytes('qr\nafter\n'))
    s.push(bytes('0123456789abc'))
    s.end()
    expect(lines).toEqual(['short', 'ok', 'after'])
    expect(tooLong).toBe(3)
  })

  it('drops a token line without reading its value', () => {
    expect(parseInbound('{"type":"token","modelToken":"la1.secret-value-0123456789"}')).toEqual({ type: 'token' })
    expect(parseInbound('{"type":"token"}')).toEqual({ type: 'token' })
  })

  it("drops C3's prompt answers (a worker asks no prompts)", () => {
    expect(parseInbound('{"type":"prompt_answer","id":"p-1","allow":true}')).toEqual({ type: 'prompt_answer' })
  })

  it('refuses a session id longer than the desktop takes', () => {
    expect(parseInbound(JSON.stringify({ type: 'resume', sessionId: 'x'.repeat(257), streamIndex: 0 }))).toBeNull()
  })

  it('cuts long text by UTF-8 bytes under the desktop event cap, on a character boundary', () => {
    const bytes = (s: string) => new TextEncoder().encode(s).length
    for (const s of ['x'.repeat(40_000), '漢'.repeat(22_000), '😀'.repeat(9000)]) {
      const cut = truncateText(s)
      expect(bytes(cut)).toBeLessThanOrEqual(TEXT_LIMIT)
      expect(cut.endsWith('…')).toBe(true)
      expect(cut).not.toContain('\ufffd') // no character split in half
    }
    expect(truncateText('short')).toBe('short')
  })

  it("holds the manager tools' own limits, then the byte cap", () => {
    expect(managerText('report', 'r'.repeat(5000))).toHaveLength(MANAGER_LIMITS.report)
    expect(managerText('finish', 'ok')).toBe('ok')
    expect(new TextEncoder().encode(managerText('finish', '漢'.repeat(8000))).length).toBeLessThanOrEqual(TEXT_LIMIT)
  })
})
