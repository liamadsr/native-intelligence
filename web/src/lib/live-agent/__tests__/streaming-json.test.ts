import { describe, it, expect } from 'vitest'
import { extractStreamingStringValue } from '../streaming-json'

describe('extractStreamingStringValue', () => {
  it('returns empty when the key has not arrived yet', () => {
    expect(extractStreamingStringValue('{"ai_su', 'ai_summary')).toBe('')
    expect(extractStreamingStringValue('{"other":"x"}', 'ai_summary')).toBe('')
  })

  it('returns empty when the opening quote of the value has not arrived', () => {
    expect(extractStreamingStringValue('{"ai_summary":', 'ai_summary')).toBe('')
    expect(extractStreamingStringValue('{"ai_summary": ', 'ai_summary')).toBe('')
  })

  it('extracts a partial value mid-stream', () => {
    expect(extractStreamingStringValue('{"ai_summary":"## Summ', 'ai_summary')).toBe('## Summ')
  })

  it('grows as more deltas arrive', () => {
    const a = extractStreamingStringValue('{"ai_summary":"## Summary', 'ai_summary')
    const b = extractStreamingStringValue('{"ai_summary":"## Summary\\n- point', 'ai_summary')
    expect(a).toBe('## Summary')
    expect(b).toBe('## Summary\n- point')
  })

  it('decodes common escapes', () => {
    expect(extractStreamingStringValue('{"ai_summary":"line1\\nline2\\ttab\\"q\\\\b"', 'ai_summary'))
      .toBe('line1\nline2\ttab"q\\b')
  })

  it('stops at the closing quote (ignores trailing JSON)', () => {
    expect(extractStreamingStringValue('{"ai_summary":"done","x":1}', 'ai_summary')).toBe('done')
  })

  it('handles a half-written escape at the end (drops it until next delta)', () => {
    // trailing lone backslash — should not crash, should not emit garbage
    expect(extractStreamingStringValue('{"ai_summary":"abc\\', 'ai_summary')).toBe('abc')
  })

  it('handles an incomplete unicode escape gracefully', () => {
    expect(extractStreamingStringValue('{"ai_summary":"abc\\u00', 'ai_summary')).toBe('abc')
  })

  it('decodes a complete unicode escape', () => {
    expect(extractStreamingStringValue('{"ai_summary":"a\\u0041b"', 'ai_summary')).toBe('aAb')
  })

  it('works for the update_summary new_text key too', () => {
    expect(extractStreamingStringValue('{"operation":"replace","find_text":"x","new_text":"hello', 'new_text'))
      .toBe('hello')
  })

  it('tolerates whitespace around the colon', () => {
    expect(extractStreamingStringValue('{"ai_summary"  :  "value', 'ai_summary')).toBe('value')
  })

  it('caps the extracted value length (unbounded-memory safety net)', () => {
    // An enormous unclosed string must not produce an unbounded result.
    const huge = '{"ai_summary":"' + 'x'.repeat(2_000_000)
    const out = extractStreamingStringValue(huge, 'ai_summary')
    expect(out.length).toBeLessThanOrEqual(1_000_000)
    expect(out.length).toBeGreaterThan(0)
  })
})
