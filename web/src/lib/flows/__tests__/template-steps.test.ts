/**
 * F4 data passing in the template: {{steps.<id>.output}} and
 * {{trigger.capture.title}} resolve from the fire; a strict render fails
 * loudly on a missing reference; no code ever runs.
 */
import { describe, expect, it } from 'vitest'
import {
  buildTemplateContext,
  isKnownTemplatePath,
  missingStepReference,
  renderInputStrict,
  renderStrict,
  renderTemplate,
  stepReferences,
  templateReferences,
} from '../template'
import type { TriggerContext } from '../types'

const trigger: TriggerContext = { type: 'capture_processed', entity_type: null, from_status_id: null, to_status_id: null, fired_at: '2026-10-20T10:00:00Z' }
const ctx = buildTemplateContext(null, trigger, 'https://nativeintelligence.dev', {
  workspaceId: 'ws-1',
  capture: { id: 'cap-1', title: 'Acme renewal call' },
  steps: { summarise: { output: 'They want SSO.' }, 'a1b2-c3': { output: 'uuid-ish id' } },
})

describe('the template context (F4)', () => {
  it('carries the capture under the trigger and the earlier steps by id', () => {
    expect(renderTemplate('{{trigger.capture.title}}: {{steps.summarise.output}}', ctx)).toBe('Acme renewal call: They want SSO.')
    // A step id may hold dashes (a uuid).
    expect(renderTemplate('{{steps.a1b2-c3.output}}', ctx)).toBe('uuid-ish id')
  })

  it('never reaches a prototype member', () => {
    expect(renderTemplate('{{steps.constructor}}|{{trigger.__proto__}}', ctx)).toBe('|')
    expect(renderStrict('{{steps.toString}}', ctx).ok).toBe(false)
  })
})

describe('renderStrict', () => {
  it('a whole-token string keeps the value; text around a token interpolates', () => {
    expect(renderStrict('{{steps.summarise.output}}', ctx)).toEqual({ ok: true, value: 'They want SSO.' })
    expect(renderStrict('Call: {{trigger.capture.title}}', ctx)).toEqual({ ok: true, value: 'Call: Acme renewal call' })
  })

  it('fails loudly on a step that left no output, naming it', () => {
    const r = renderStrict('Post: {{steps.draft.output}}', ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reference).toBe('{{steps.draft.output}}')
      expect(r.error).toContain('step "draft" did not run before this one')
    }
  })

  it('a null namespace is missing too (no capture on a schedule fire)', () => {
    const noCapture = buildTemplateContext(null, { ...trigger, type: 'schedule' }, 'https://nativeintelligence.dev', { workspaceId: 'ws-1' })
    expect(renderStrict('{{trigger.capture.title}}', noCapture).ok).toBe(false)
    // The lenient renderer keeps its old behaviour (empty), for http bodies and instructions.
    expect(renderTemplate('[{{capture.title}}]', noCapture)).toBe('[]')
  })

  it('transformValue sees each value (a model step fences it), never the template text', () => {
    const r = renderStrict('A {{steps.summarise.output}} B', ctx, { transformValue: (v) => `<${v}>` })
    expect(r).toEqual({ ok: true, value: 'A <They want SSO.> B' })
  })
})

describe('renderInputStrict', () => {
  it('renders every string of a JSON input, keys untouched, other values as they are', () => {
    const r = renderInputStrict({ text: '{{steps.summarise.output}}', meta: { '{{x}}': 1, n: 2, on: true, list: ['{{trigger.capture.id}}'] } }, ctx)
    expect(r).toEqual({ ok: true, value: { text: 'They want SSO.', meta: { '{{x}}': 1, n: 2, on: true, list: ['cap-1'] } } })
  })

  it('stops at the first missing reference', () => {
    const r = renderInputStrict({ a: 'fine', b: { c: '{{steps.nope.output}}' } }, ctx)
    expect(r.ok).toBe(false)
  })
})

describe('references', () => {
  it('finds every token path, and the step ids', () => {
    expect(templateReferences({ a: 'x {{steps.s1.output}}', b: ['{{entity.name}}'] })).toEqual([['steps', 's1', 'output'], ['entity', 'name']])
    expect(stepReferences({ a: '{{steps.s1.output}} {{steps.s1.output}} {{steps.s2.output}}' })).toEqual(['s1', 's2'])
  })

  it('knows the vocabulary: listed tokens, namespaces, steps.<id>.output only', () => {
    expect(isKnownTemplatePath(['steps', 'x', 'output'])).toBe(true)
    expect(isKnownTemplatePath(['steps', 'x'])).toBe(false)
    expect(isKnownTemplatePath(['steps', 'x', 'status'])).toBe(false)
    expect(isKnownTemplatePath(['trigger', 'capture', 'title'])).toBe(true)
    expect(isKnownTemplatePath(['capture', 'title'])).toBe(true)
    expect(isKnownTemplatePath(['action', 'assignees'])).toBe(true)
    expect(isKnownTemplatePath(['secrets', 'key'])).toBe(false)
  })

  it('missingStepReference flags only step references a lenient template names', () => {
    expect(missingStepReference('{{project.name}} {{steps.summarise.output}}', ctx)).toBeNull()
    expect(missingStepReference('{{steps.later.output}}', ctx)?.reference).toBe('{{steps.later.output}}')
  })
})
