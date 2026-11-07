/**
 * The verdict triage POLICY ("default to dismiss", work_proposal over
 * action_card) must reach the model. With the gateway's createVerdictTool gone,
 * eve's only carrier is the outputSchema's top-level description — which eve
 * lowers into its `final_output` tool's input schema (the tool's own
 * description is fixed by eve).
 */
import { describe, it, expect } from 'vitest'
import { VERDICT_POLICY_GUIDANCE, verdictOutputSchema } from '../verdict-schema'

describe('verdictOutputSchema carries the triage policy', () => {
  it('the policy text holds the load-bearing rules', () => {
    expect(VERDICT_POLICY_GUIDANCE).toContain('Default to dismiss')
    expect(VERDICT_POLICY_GUIDANCE).toContain('explicitly the user’s')
    expect(VERDICT_POLICY_GUIDANCE).toContain('"work_proposal" with a SELF-CONTAINED payload.task')
    expect(VERDICT_POLICY_GUIDANCE).toContain('Reserve action_card for work only the human can do')
    expect(VERDICT_POLICY_GUIDANCE).toContain('An action_card or draft_email must name the pending proposal it is about')
  })

  it('is the schema’s own description', () => {
    expect(verdictOutputSchema.description).toBe(VERDICT_POLICY_GUIDANCE)
  })

  it('survives the draft-07 lowering eve applies to the create outputSchema', () => {
    // The same transform task-session.ts normalizeOutputSchema runs.
    const lowered = verdictOutputSchema['~standard'].jsonSchema.output({ target: 'draft-07' }) as {
      description?: string
      properties?: Record<string, unknown>
    }
    expect(lowered.description).toBe(VERDICT_POLICY_GUIDANCE)
    expect(Object.keys(lowered.properties ?? {})).toEqual(['decisions', 'needs_user', 'summary'])
  })

  it('tells the model an action or email card needs its proposal_id (one without it is dropped)', () => {
    const lowered = verdictOutputSchema['~standard'].jsonSchema.output({ target: 'draft-07' }) as {
      properties: { needs_user: { items: { properties: { proposal_id: { description?: string } } } } }
    }
    const said = lowered.properties.needs_user.items.properties.proposal_id.description ?? ''
    expect(said).toContain('REQUIRED for action_card and draft_email')
    expect(said).toContain('dropped')
  })
})
