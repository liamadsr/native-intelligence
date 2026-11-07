/**
 * Display-boundary tool-output truncation (2026-08-05 incident: unbounded tool
 * results retained 10–100MB of useChat state over a long directory-scoped
 * session). Pins the contract both transports rely on:
 *  - under/at threshold → the EXACT same value (reference-preserving — the
 *    entity-links cache keys off output identity);
 *  - over threshold → a head + marker + tail string with the real total size;
 *  - non-string outputs are measured by their serialized form and truncate to
 *    a string (downstream readers probe shape defensively);
 *  - unserializable values pass through rather than throw.
 */
import { describe, it, expect } from 'vitest'
import {
  truncateToolOutput,
  TOOL_OUTPUT_MAX_SERIALIZED_CHARS,
  TOOL_OUTPUT_HEAD_CHARS,
  TOOL_OUTPUT_TAIL_CHARS,
} from '../tool-output-truncation'

describe('truncateToolOutput — strings', () => {
  it('returns a string AT the threshold unchanged (same reference)', () => {
    const s = 'a'.repeat(TOOL_OUTPUT_MAX_SERIALIZED_CHARS)
    expect(truncateToolOutput(s)).toBe(s)
  })

  it('truncates a string ONE char over the threshold', () => {
    const s = 'a'.repeat(TOOL_OUTPUT_MAX_SERIALIZED_CHARS + 1)
    const out = truncateToolOutput(s)
    expect(out).not.toBe(s)
    expect(typeof out).toBe('string')
    expect(out).toContain('output truncated for display')
  })

  it('keeps the head and tail and stamps the real total size in the marker', () => {
    // Distinct regions so we can prove WHICH bytes survived.
    const head = 'H'.repeat(TOOL_OUTPUT_HEAD_CHARS)
    const middle = 'M'.repeat(60_000)
    const tail = 'T'.repeat(TOOL_OUTPUT_TAIL_CHARS)
    const s = head + middle + tail
    const out = truncateToolOutput(s)

    expect(out.startsWith(head)).toBe(true)
    expect(out.endsWith(tail)).toBe(true)
    // The middle is gone — the result is a small fraction of the input.
    expect(out.length).toBeLessThan(
      TOOL_OUTPUT_HEAD_CHARS + TOOL_OUTPUT_TAIL_CHARS + 200,
    )
    const expectedKb = Math.round(s.length / 1024)
    expect(out).toContain(`[output truncated for display — ${expectedKb} KB total]`)
  })
})

describe('truncateToolOutput — non-string outputs', () => {
  it('returns a small object unchanged (same reference)', () => {
    const o = { success: true, results: [1, 2, 3] }
    expect(truncateToolOutput(o)).toBe(o)
  })

  it('measures an object by its serialized form and truncates to a string', () => {
    const o = { blob: 'x'.repeat(TOOL_OUTPUT_MAX_SERIALIZED_CHARS + 10_000) }
    const out = truncateToolOutput(o)
    expect(typeof out).toBe('string')
    expect(out as string).toContain('output truncated for display')
    // The head of the serialized JSON survives (the opening of the object).
    expect((out as string).startsWith('{"blob":"xxx')).toBe(true)
  })

  it('an array of content blocks truncates too', () => {
    const blocks = [{ type: 'text', text: 'y'.repeat(TOOL_OUTPUT_MAX_SERIALIZED_CHARS + 5_000) }]
    const out = truncateToolOutput(blocks)
    expect(typeof out).toBe('string')
    expect(out as string).toContain('output truncated for display')
  })

  it('passes through null / undefined / unserializable values untouched', () => {
    expect(truncateToolOutput(null)).toBeNull()
    expect(truncateToolOutput(undefined)).toBeUndefined()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(truncateToolOutput(circular)).toBe(circular)
  })
})
