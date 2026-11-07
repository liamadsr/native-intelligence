import { describe, it, expect } from 'vitest'
import requestUserInput from '../../tools/request_user_input'

/**
 * The work-agent's mid-run clarifying-question tool (Loops v3 Phase 3;
 * docs/loop-engine/INTERACTIVE-WORK-RUNS-DESIGN.md). Invariants:
 *   1. it gates on `approval` so every call PAUSES the turn (input.requested) —
 *      that IS the park mechanism the dispatcher keys on;
 *   2. the rich schema (1–4 questions, 2–4 options, header, multiSelect) mirrors
 *      ask_user so QuestionPicker renders it unchanged;
 *   3. (F2 fix) blank question text / blank option labels are REJECTED — a
 *      degenerate empty ask would otherwise park the run with an unanswerable,
 *      pickerless "needs your input" state.
 */
describe('work-agent request_user_input — schema + HITL gate', () => {
  const schema = (
    requestUserInput as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }
  ).inputSchema

  it('gates on approval (pauses the turn → input.requested → the picker)', () => {
    expect((requestUserInput as { approval?: unknown }).approval).toBeDefined()
  })

  it('accepts a well-formed batched question', () => {
    const ok = schema.safeParse({
      questions: [
        {
          question: 'Which environment?',
          header: 'Env',
          options: [
            { label: 'Staging', description: 'safe' },
            { label: 'Prod', description: 'careful' },
          ],
          multiSelect: false,
        },
      ],
    })
    expect(ok.success).toBe(true)
  })

  it('rejects a BLANK question string (F2: no empty ask can park the run)', () => {
    const blank = schema.safeParse({
      questions: [
        {
          question: '   ',
          header: 'x',
          options: [{ label: 'A' }, { label: 'B' }],
          multiSelect: false,
        },
      ],
    })
    expect(blank.success).toBe(false)
  })

  it('rejects a BLANK option label (F2: choice-less questions are unanswerable)', () => {
    const blankLabel = schema.safeParse({
      questions: [
        {
          question: 'Pick one',
          header: 'x',
          options: [{ label: '' }, { label: 'B' }],
          multiSelect: false,
        },
      ],
    })
    expect(blankLabel.success).toBe(false)
  })

  it('still enforces the rich shape (≥2 options, ≥1 question)', () => {
    expect(
      schema.safeParse({
        questions: [{ question: 'Q', header: 'H', options: [{ label: 'only-one' }], multiSelect: false }],
      }).success,
    ).toBe(false)
    expect(schema.safeParse({ questions: [] }).success).toBe(false)
  })
})
