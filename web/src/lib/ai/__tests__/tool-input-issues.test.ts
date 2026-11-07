import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { toolInputIssues } from '@/lib/ai/tool-input-issues'

const issuesOf = (schema: z.ZodType, input: unknown) => {
  const parsed = schema.safeParse(input)
  if (parsed.success) throw new Error('expected a refusal')
  return toolInputIssues(parsed.error)
}

describe('toolInputIssues', () => {
  it('a uuid field reads as its field and message, without zod’s pattern regex (PROD, 2026-10-08)', () => {
    const text = issuesOf(z.object({ bot_id: z.string().uuid('must be a uuid') }), { bot_id: 'db584d82-0000-0000-0000-000000000000' })
    expect(text).toBe('bot_id: must be a uuid')
    expect(text).not.toMatch(/pattern|\[0-9a-fA-F\]/)
  })

  it('every issue, with nested paths and array indexes, joined on one line', () => {
    const schema = z.object({ brief: z.object({ task: z.string() }), ids: z.array(z.string().min(2)) })
    expect(issuesOf(schema, { brief: {}, ids: ['ok', 'x'] })).toBe(
      'brief.task: Invalid input: expected string, received undefined; ids.1: Too small: expected string to have >=2 characters',
    )
  })

  it('an issue on the input itself is named input', () => {
    expect(issuesOf(z.object({ a: z.string() }), 'not an object')).toBe('input: Invalid input: expected object, received string')
  })

  it('anything that is not a zod error falls back to its string', () => {
    expect(toolInputIssues('action: Required')).toBe('action: Required')
    expect(toolInputIssues(new Error('boom'))).toBe('Error: boom')
    expect(toolInputIssues(undefined)).toBe('undefined')
  })
})
