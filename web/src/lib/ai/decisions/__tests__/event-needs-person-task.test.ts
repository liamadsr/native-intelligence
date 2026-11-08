import { describe, expect, it } from 'vitest'
import type { Evaluation } from '../contracts'
import { decisionTasks } from '../registry'
import { EVENT_KIND_DESCRIPTIONS, EVENT_NEEDS_PERSON_INSTRUCTIONS, eventNeedsPerson, eventNeedsPersonSchema } from '../tasks/event-needs-person'
import { AGENT_EVENT_KINDS } from '@/lib/agent-events/types'
import { EVENT_NEEDS_PERSON_VERSION } from '@/lib/agent-events/router'
import { eventNeedsPersonFixtures } from './event-needs-person-fixtures'

/** A pick-one answer for `needs`, with the provider's confidence. */
const answer = (choice: string, probability: number, confidence = 0.9) =>
  ({
    answers: { needs: { type: 'choice', choice, probabilities: { [choice]: probability } } },
    providerMetadata: { typesafe: { confidence: { needs: confidence } } },
  }) as unknown as Evaluation

const byName = (name: string) => eventNeedsPersonFixtures.find((f) => f.name === name)!

describe('event.needs_person decision policy', () => {
  it('is registered as a decision task, at the version the router stores', () => {
    expect(decisionTasks['event.needs_person']).toBe(eventNeedsPerson)
    expect(eventNeedsPerson.version).toBe(EVENT_NEEDS_PERSON_VERSION)
  })

  it('every labelled fixture parses and fits the state budget; the set covers each pick', () => {
    expect(eventNeedsPersonFixtures.length).toBeGreaterThanOrEqual(10)
    for (const f of eventNeedsPersonFixtures) {
      expect(eventNeedsPersonSchema.safeParse(f.input).success, f.name).toBe(true)
      expect(eventNeedsPerson.prepare(f.input)!.state.length, f.name).toBeLessThanOrEqual(eventNeedsPerson.maxStateChars)
    }
    expect(new Set(eventNeedsPersonFixtures.map((f) => f.expected))).toEqual(new Set(['now', 'digest', 'ignore']))
    // Every kind has Native Intelligence's own description.
    for (const kind of AGENT_EVENT_KINDS) expect(EVENT_KIND_DESCRIPTIONS[kind]).toBeTruthy()
  })

  it('one pick-one question: now, digest or ignore', () => {
    const prepared = eventNeedsPerson.prepare(byName('unknown_sender_drafted').input)!
    expect(Object.keys(prepared.questions)).toEqual(['needs'])
    const q = prepared.questions.needs as { type: string; criteria: Record<string, string> }
    expect(q.type).toBe('choice')
    expect(Object.keys(q.criteria)).toEqual(['now', 'digest', 'ignore'])
    const state = JSON.parse(prepared.state)
    expect(state.event).toMatchObject({ kind: 'email.drafted', description: EVENT_KIND_DESCRIPTIONS['email.drafted'] })
  })

  it('v2 hands Jev the facts the rules turn on (known sender, open asks, staged proposals, the approval door)', () => {
    expect(eventNeedsPerson.version).toBe('event-needs-person-v2')
    const facts = (name: string) => JSON.parse(eventNeedsPerson.prepare(byName(name).input)!.state).facts
    expect(facts('known_sender_drafted')).toMatchObject({ from: 'dana@acme.com', known: true })
    expect(facts('meeting_left_open_asks')).toMatchObject({ openAsks: 2, pendingProposals: 0 })
    expect(facts('approval_unattended_run')).toMatchObject({ door: 'loop' })
    expect(EVENT_NEEDS_PERSON_INSTRUCTIONS).toMatch(/known true/)
    expect(EVENT_NEEDS_PERSON_INSTRUCTIONS).toMatch(/openAsks or pendingProposals above 0/)
    // Out-of-range counts are refused at the boundary, never clipped silently by Jev.
    expect(eventNeedsPersonSchema.safeParse({ kind: 'capture.processed', priority: 1, startsInMinutes: null, facts: { openAsks: 500 } }).success).toBe(false)
  })

  it('labels outside text untrusted and keeps injected text in the state, out of the question', () => {
    const prepared = eventNeedsPerson.prepare(byName('injection_in_subject_ignored').input)!
    expect(JSON.parse(prepared.state).note).toMatch(/untrusted/)
    expect(EVENT_NEEDS_PERSON_INSTRUCTIONS).toMatch(/untrusted text from outside Native Intelligence/)
    expect(JSON.stringify(prepared.questions)).not.toContain('IGNORE ALL PREVIOUS INSTRUCTIONS')
    expect(prepared.state).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS')
    expect(prepared.questions.needs.instructions).toBe(eventNeedsPerson.prepare(byName('question_blocks_work').input)!.questions.needs.instructions)
  })

  it('accepts a trusted pick; an untrusted one waits for the digest; a malformed answer escalates', () => {
    const input = byName('meeting_soon_prep_ready').input
    expect(eventNeedsPerson.accept(answer('now', 0.95), input)).toEqual({ pick: 'now', probability: 0.95, trusted: true })
    expect(eventNeedsPerson.accept(answer('ignore', 0.6), input)).toEqual({ pick: 'digest', probability: 0.6, trusted: false })
    expect(eventNeedsPerson.accept(answer('now', 0.95, 0.5), input)).toEqual({ pick: 'digest', probability: 0.95, trusted: false })
    expect(eventNeedsPerson.accept(answer('urgent', 0.99), input)).toBeNull()
    expect(eventNeedsPerson.accept({ answers: {} } as unknown as Evaluation, input)).toBeNull()
  })
})
