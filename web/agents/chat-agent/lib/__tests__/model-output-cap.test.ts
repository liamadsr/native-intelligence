import { describe, expect, it } from 'vitest'
import { toolOutput, toolOutputPart } from 'eve/tools'
import {
  TOOL_RESULT_MODEL_HEAD_CHARS,
  TOOL_RESULT_MODEL_MAX_CHARS,
  TOOL_RESULT_MODEL_TAIL_CHARS,
  capToolModelOutput,
} from '../model-output-cap'
import { expertiseModelOutput } from '../expertise'

describe('capToolModelOutput', () => {
  it('passes a result that fits through untouched (the same object)', () => {
    const small = toolOutput.json({ rows: [1, 2, 3] })
    expect(capToolModelOutput(small)).toBe(small)
    const text = toolOutput.text('x'.repeat(TOOL_RESULT_MODEL_MAX_CHARS))
    expect(capToolModelOutput(text)).toBe(text)
  })

  it('keeps a whole transcript page (80K characters of text, as JSON)', () => {
    const page = toolOutput.json({ transcript: 'word "quoted"\n'.repeat(80_000 / 14), next_offset: 80_000 })
    expect(capToolModelOutput(page)).toBe(page)
  })

  it('cuts an oversized result to its head and tail around a note the model can act on', () => {
    const big = 'H'.repeat(TOOL_RESULT_MODEL_HEAD_CHARS) + 'M'.repeat(200_000) + 'T'.repeat(TOOL_RESULT_MODEL_TAIL_CHARS)
    const out = capToolModelOutput(toolOutput.text(big))
    expect(out.type).toBe('text')
    const value = (out as { value: string }).value
    expect(value.startsWith('H'.repeat(TOOL_RESULT_MODEL_HEAD_CHARS))).toBe(true)
    expect(value.endsWith('T'.repeat(TOOL_RESULT_MODEL_TAIL_CHARS))).toBe(true)
    expect(value).not.toContain('M')
    expect(value).toContain(`it was ${big.length} characters`)
    expect(value).toContain('call the tool again for a narrower page')
    expect(value.length).toBeLessThan(TOOL_RESULT_MODEL_MAX_CHARS)
  })

  it('cuts an oversized JSON result as its serialized text', () => {
    const rows = Array.from({ length: 5_000 }, (_, i) => ({ id: `row-${i}`, body: 'b'.repeat(40) }))
    const out = capToolModelOutput(toolOutput.json({ rows }))
    expect(out.type).toBe('text')
    expect((out as { value: string }).value.startsWith('{"rows":[{"id":"row-0"')).toBe(true)
  })

  it('never splits a surrogate pair at either cut', () => {
    const emoji = '\u{1F600}'
    const big = 'a'.repeat(TOOL_RESULT_MODEL_HEAD_CHARS - 1) + emoji.repeat(100_000)
    const value = (capToolModelOutput(toolOutput.text(big)) as { value: string }).value
    expect(value).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(value).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('leaves an image (content) result alone', () => {
    const image = toolOutput.content([toolOutputPart.text('x'.repeat(TOOL_RESULT_MODEL_MAX_CHARS + 1))])
    expect(capToolModelOutput(image)).toBe(image)
  })

  it('applies to every workspace tool through expertiseModelOutput', () => {
    const out = expertiseModelOutput({ page: 'p'.repeat(TOOL_RESULT_MODEL_MAX_CHARS + 10) })
    expect(out.type).toBe('text')
    expect((out as { value: string }).value).toContain('Native Intelligence cut this result')
  })
})
