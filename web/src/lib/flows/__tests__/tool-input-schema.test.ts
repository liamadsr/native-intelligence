/**
 * A call_tool input against the app's own schema: at save time (a template,
 * whole-token values pass any type) and at run time (the rendered input, in
 * full). Never throws.
 */
import { describe, expect, it } from 'vitest'
import { checkToolInputAtRun, checkToolInputAtSave } from '../tool-input-schema'

const schema = {
  type: 'object',
  properties: {
    page_id: { type: 'string' },
    text: { type: 'string' },
    position: { type: 'integer' },
    kind: { type: 'string', enum: ['paragraph', 'bullet'] },
  },
  required: ['page_id', 'text'],
  additionalProperties: false,
}

describe('at save time', () => {
  it('passes a templated input; a whole token passes any type', () => {
    expect(checkToolInputAtSave({ page_id: 'p1', text: 'Objections: {{steps.lens.output}}', position: '{{steps.count.output}}' }, schema)).toEqual({ ok: true })
  })

  it('refuses a missing required field, an unknown field, a wrong literal type and an off-enum literal', () => {
    expect(checkToolInputAtSave({ text: 'x' }, schema)).toMatchObject({ ok: false, error: 'page_id is required' })
    expect(checkToolInputAtSave({ page_id: 'p', text: 'x', extra: 1 }, schema)).toMatchObject({ ok: false })
    expect(checkToolInputAtSave({ page_id: 'p', text: 'x', position: 'top' }, schema)).toMatchObject({ ok: false, error: 'position must be integer' })
    expect(checkToolInputAtSave({ page_id: 'p', text: 'x', kind: 'heading' }, schema)).toMatchObject({ ok: false })
  })

  it('a tool with no schema takes any object, never a non-object', () => {
    expect(checkToolInputAtSave({ anything: 1 }, undefined)).toEqual({ ok: true })
    expect(checkToolInputAtSave([], undefined)).toMatchObject({ ok: false })
  })
})

describe('at run time', () => {
  it('the rendered input in full', () => {
    expect(checkToolInputAtRun({ page_id: 'p1', text: 'They want SSO', position: 2 }, schema)).toEqual({ ok: true })
    expect(checkToolInputAtRun({ page_id: 'p1', text: 'x', position: 'two' }, schema).ok).toBe(false)
    // A whole token that rendered to text is now just text: a wrong type fails.
    expect(checkToolInputAtRun({ page_id: 'p1', text: 'x', position: '{{steps.count.output}}' }, schema).ok).toBe(false)
  })

  it('a schema zod cannot read falls back to the subset checks, never throws', () => {
    const odd = { type: 'object', properties: { a: { $ref: '#/definitions/missing' } }, required: ['a'] }
    expect(checkToolInputAtRun({}, odd)).toMatchObject({ ok: false, error: 'a is required' })
    expect(checkToolInputAtRun({ a: 'x' }, odd)).toEqual({ ok: true })
  })
})
