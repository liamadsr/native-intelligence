/**
 * The live agent's per-turn budgets and the rules around them (turn-budget.ts),
 * plus readLiveTurn enforcing them on a stream (the output caps and the
 * deadline, with fake timers) and the usage merge for a retried turn.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LIVE_TURN_BUDGETS,
  LIVE_TURN_WRITE_TOOLS,
  MIN_TICK_SPEECH_LETTERS,
  OUTPUT_CHARS_PER_TOKEN,
  RETRY_WINDOW_CHARS,
  liveTurnFailureCode,
  liveTurnKind,
  outputCharLimits,
  reducedRetryChunks,
  shouldRetryLiveTurn,
  speechLetters,
  tickHasNothingNew,
} from '../turn-budget'
import { CEILING_WIND_DOWN_MS, readLiveTurn, toGenResult, withFailedAttemptUsage } from '../eve-turn'
import { liveTurnBudgetPrompt } from '../prompts'
import { ev, fakeTaskResponse } from './helpers/fake-eve-turn'

afterEach(() => {
  vi.useRealTimers()
})

describe('the budgets per turn kind', () => {
  it('maps the route flags to a kind', () => {
    expect(liveTurnKind({ isBatch: true, recordOnly: true })).toBe('batch')
    expect(liveTurnKind({ isBatch: false, recordOnly: true })).toBe('record')
    expect(liveTurnKind({ isBatch: false, recordOnly: false })).toBe('tick')
  })

  it('gives a person’s record turn the smallest budget, a tick a small one, the batch room for the whole meeting', () => {
    const { tick, record, batch } = LIVE_TURN_BUDGETS
    expect(record.maxSteps).toBeLessThanOrEqual(4)
    expect(record.maxStepOutputTokens).toBeLessThan(tick.maxStepOutputTokens)
    expect(record.deadlineMs).not.toBeNull()
    expect(tick.maxSteps).toBeLessThan(20) // was 20, p50 is 3
    expect(tick.maxStepOutputTokens).toBeLessThanOrEqual(5_000) // the runaways were 11K-53K
    expect(tick.maxTurnOutputTokens).toBeGreaterThanOrEqual(tick.maxStepOutputTokens)
    // Every turn thinks: room for a hard step's reasoning, still well under the
    // minutes-long freezes the budgets were added for.
    expect(tick.deadlineMs).toBeLessThanOrEqual(120_000)
    expect(record.maxStepReasoningTokens).toBeLessThan(tick.maxStepReasoningTokens)
    for (const b of Object.values(LIVE_TURN_BUDGETS)) expect(b.maxStepReasoningTokens).toBeGreaterThanOrEqual(4_000)
    expect(batch.maxSteps).toBe(50)
    expect(batch.deadlineMs).toBeNull()
    for (const b of Object.values(LIVE_TURN_BUDGETS)) {
      expect(outputCharLimits(b)).toEqual({
        maxStepOutputChars: b.maxStepOutputTokens * OUTPUT_CHARS_PER_TOKEN,
        maxTurnOutputChars: b.maxTurnOutputTokens * OUTPUT_CHARS_PER_TOKEN,
        maxStepReasoningChars: b.maxStepReasoningTokens * OUTPUT_CHARS_PER_TOKEN,
      })
    }
  })

  it('the live prompt rider states the tick budget the route enforces (and only writers hear about the summary)', () => {
    const writer = liveTurnBudgetPrompt(false)
    const assist = liveTurnBudgetPrompt(true)
    expect(writer).toContain(`at most ${LIVE_TURN_BUDGETS.tick.maxSteps} model steps`)
    expect(writer).toContain(`about ${LIVE_TURN_BUDGETS.tick.maxStepOutputTokens.toLocaleString('en-US')} tokens`)
    expect(writer).toContain('TOGETHER in one step')
    expect(writer).toContain('update_summary')
    expect(assist).not.toContain('update_summary')
    expect(assist).not.toContain('write_summary')
  })
})

describe('skipping a tick with nothing new', () => {
  it('counts the letters of real speech, without speaker labels or back-channel words', () => {
    expect(speechLetters('[local_1]: Yeah. Okay.\n[remote_1]: Mm-hmm, right.')).toBe(0)
    expect(speechLetters('Speaker 1: ship Friday')).toBe('shipfriday'.length)
    expect(speechLetters('[local_1]: Can you send the deck?')).toBeGreaterThanOrEqual(MIN_TICK_SPEECH_LETTERS)
  })

  it('skips a tick whose NEWEST chunk is back-channel only; never a record turn, the batch, a directive or a prime', () => {
    const filler = ['Speaker 1: we ship on Friday', '[local_1]: Okay, yeah.']
    expect(tickHasNothingNew({ kind: 'tick', recentChunks: filler, directiveCount: 0, priorTranscript: undefined })).toBe(true)
    expect(tickHasNothingNew({ kind: 'record', recentChunks: filler, directiveCount: 0, priorTranscript: undefined })).toBe(false)
    expect(tickHasNothingNew({ kind: 'batch', recentChunks: filler, directiveCount: 0, priorTranscript: undefined })).toBe(false)
    expect(tickHasNothingNew({ kind: 'tick', recentChunks: filler, directiveCount: 1, priorTranscript: undefined })).toBe(false)
    expect(tickHasNothingNew({ kind: 'tick', recentChunks: filler, directiveCount: 0, priorTranscript: 'earlier' })).toBe(false)
    expect(
      tickHasNothingNew({ kind: 'tick', recentChunks: [...filler, '[remote_1]: The budget is 40K.'], directiveCount: 0, priorTranscript: undefined }),
    ).toBe(false)
    expect(tickHasNothingNew({ kind: 'tick', recentChunks: [], directiveCount: 0, priorTranscript: undefined })).toBe(false)
  })
})

describe('the one retry', () => {
  const rejected = ev.sessionFailed('MODEL_CALL_FAILED', 'The model request was rejected.')

  it('reads the failure code', () => {
    expect(liveTurnFailureCode([ev.stepStarted(0), rejected])).toBe('MODEL_CALL_FAILED')
    expect(liveTurnFailureCode([ev.stepStarted(0)])).toBeNull()
  })

  it('retries a rejected model call that wrote nothing (reads are fine)', () => {
    expect(shouldRetryLiveTurn([ev.stepStarted(0), rejected])).toBe(true)
    expect(shouldRetryLiveTurn([ev.toolCall(0, 'c1', 'search_projects', { query: 'Atlas' }), ev.stepCompleted(0, 'tool-calls'), rejected])).toBe(true)
    expect(shouldRetryLiveTurn([ev.toolCall(0, 'c1', 'find', { query: 'Atlas' }), rejected])).toBe(true)
    // load_skill only records the playbook name on the capture: running it twice is harmless.
    expect(LIVE_TURN_WRITE_TOOLS.has('load_skill')).toBe(false)
    expect(shouldRetryLiveTurn([ev.toolCall(0, 'c1', 'load_skill', { skill: 'investor-pitch' }), rejected])).toBe(true)
  })

  it('never retries after a write or a heads-up, nor a fail-closed refusal', () => {
    for (const tool of ['propose_change', 'update_summary', 'say_to_user', 'record_commitment', 'direct_notes']) {
      expect(LIVE_TURN_WRITE_TOOLS.has(tool), tool).toBe(true)
      expect(shouldRetryLiveTurn([ev.toolCall(0, 'c1', tool, {}), rejected]), tool).toBe(false)
    }
    expect(shouldRetryLiveTurn([ev.sessionFailed('MODEL_SELECTION_FAILED', 'no spec')])).toBe(false)
    expect(shouldRetryLiveTurn([ev.sessionFailed('SPEC_UNAVAILABLE', 'no spec')])).toBe(false)
  })

  it('reduces the window to the newest chunk’s tail', () => {
    expect(reducedRetryChunks(['old', 'new'])).toEqual(['new'])
    expect(reducedRetryChunks([])).toEqual([])
    const long = Array.from({ length: 400 }, (_, i) => `[local_1]: line ${i} of the window`).join('\n')
    const [kept] = reducedRetryChunks([long])
    expect(kept.length).toBeLessThanOrEqual(RETRY_WINDOW_CHARS)
    expect(kept.startsWith('[local_1]: line')).toBe(true) // cut at a line start
    expect(long.endsWith(kept)).toBe(true)
  })

  it('folds a failed attempt’s spend into the retried turn’s usage', () => {
    const failed = [ev.stepStarted(0), ev.stepCompleted(0, 'tool-calls', { inputTokens: 50, outputTokens: 900 }, 'gen-fail'), rejected]
    const retried = toGenResult([ev.stepStarted(0), ev.stepCompleted(0, 'stop', { inputTokens: 40, outputTokens: 30 }, 'gen-ok')])
    const merged = withFailedAttemptUsage(retried, failed)
    expect(merged.usage).toMatchObject({ inputTokens: 90, outputTokens: 930 })
    expect(merged.generationIds).toEqual(['gen-fail', 'gen-ok'])
    expect(merged.maxStepOutputTokens).toBe(900)
    expect(merged.steps).toHaveLength(1)
    expect(withFailedAttemptUsage(retried, [rejected])).toBe(retried)
  })
})

describe('readLiveTurn enforces the output budget and the deadline', () => {
  it('cancels when one step’s streamed output passes its cap (text, reasoning and tool input all count)', async () => {
    const res = fakeTaskResponse(
      [
        ev.stepStarted(0),
        ev.inputDelta(0, 'c1', 'update_summary', 'x'.repeat(40)),
        ev.stepCompleted(0, 'tool-calls'),
        ev.stepStarted(1),
        ev.text(1, 'y'.repeat(60)),
        ev.inputDelta(1, 'c2', 'write_summary', 'z'.repeat(60)),
      ],
      { hangAfter: 6, afterCancel: [ev.turnCancelled()] },
    )
    const turn = await readLiveTurn(res, { stepCeiling: 8, cancel: res.cancel, budget: { maxStepOutputChars: 100 } })
    expect(res.cancelled()).toBe(1)
    expect(turn).toMatchObject({ outcome: 'ceiling', budgetHit: 'step-output', stepsCompleted: 1, terminal: true, outputChars: 160 })
  })

  it('cancels when the turn’s total output passes its cap, even with every step under its own', async () => {
    const steps = []
    for (let i = 0; i < 4; i++) steps.push(ev.stepStarted(i), ev.text(i, 'w'.repeat(40)), ev.stepCompleted(i, 'tool-calls'))
    const res = fakeTaskResponse(steps, { hangAfter: steps.length, afterCancel: [ev.turnCancelled()] })
    const turn = await readLiveTurn(res, { stepCeiling: 8, cancel: res.cancel, budget: { maxStepOutputChars: 100, maxTurnOutputChars: 100 } })
    expect(turn).toMatchObject({ outcome: 'ceiling', budgetHit: 'turn-output' })
  })

  it('counts reasoning against its own allowance, never the output budget', async () => {
    const reasoning = (stepIndex: number, reasoningDelta: string) =>
      ({ type: 'reasoning.appended', data: { reasoningDelta, sequence: 0, stepIndex, turnId: 'turn-1' }, meta: { at: new Date(0).toISOString(), id: 'r' } }) as never
    const over = fakeTaskResponse([ev.stepStarted(0), reasoning(0, 'r'.repeat(150))], { hangAfter: 2, afterCancel: [ev.turnCancelled()] })
    const stopped = await readLiveTurn(over, { stepCeiling: 8, cancel: over.cancel, budget: { maxStepOutputChars: 100, maxStepReasoningChars: 120 } })
    expect(stopped.budgetHit).toBe('step-reasoning')
    expect(stopped.reasoningChars).toBe(150)
    expect(stopped.outputChars).toBe(0)

    const under = fakeTaskResponse([ev.sessionStarted(), ev.turnStarted(), ev.stepStarted(0), reasoning(0, 'r'.repeat(150)), ev.stepCompleted(0, 'stop'), ev.turnCompleted(), ev.sessionCompleted()])
    const thought = await readLiveTurn(under, { stepCeiling: 8, cancel: under.cancel, budget: { maxStepOutputChars: 100, maxStepReasoningChars: 1_000 } })
    expect(thought.budgetHit).toBeUndefined()
    expect(thought.outcome).toBe('completed')
  })

  it('cancels a turn that outlives its deadline, keeping what completed (fake timers)', async () => {
    vi.useFakeTimers()
    const res = fakeTaskResponse([ev.stepStarted(0), ev.stepCompleted(0, 'tool-calls'), ev.stepStarted(1)], {
      hangAfter: 3,
      afterCancel: [ev.turnCancelled()],
    })
    const read = readLiveTurn(res, { stepCeiling: 8, cancel: res.cancel, budget: { deadlineMs: 75_000 } })
    await vi.advanceTimersByTimeAsync(74_000)
    expect(res.cancelled()).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    const turn = await read
    expect(res.cancelled()).toBe(1)
    expect(turn).toMatchObject({ outcome: 'ceiling', budgetHit: 'deadline', stepsCompleted: 1, terminal: true })
  })

  it('a deadline cancel eve never confirms ends after the wind-down, non-terminal (the caller cancels the session)', async () => {
    vi.useFakeTimers()
    const res = fakeTaskResponse([ev.stepStarted(0)], { hangAfter: 1 })
    const read = readLiveTurn(res, { stepCeiling: 8, cancel: async () => ({ status: 'cancelled' }), budget: { deadlineMs: 1_000 } })
    await vi.advanceTimersByTimeAsync(1_000 + CEILING_WIND_DOWN_MS + 10)
    const turn = await read
    expect(turn).toMatchObject({ outcome: 'ceiling', budgetHit: 'deadline', terminal: false })
  })

  it('a turn inside its budget completes as before (no budgetHit)', async () => {
    const res = fakeTaskResponse([ev.sessionStarted(), ev.turnStarted(), ev.stepStarted(0), ev.text(0, 'ok'), ev.stepCompleted(0, 'stop'), ev.turnCompleted(), ev.sessionCompleted()])
    const turn = await readLiveTurn(res, {
      stepCeiling: 8,
      cancel: res.cancel,
      budget: { maxStepOutputChars: 100, maxTurnOutputChars: 100, deadlineMs: 75_000 },
    })
    expect(turn.outcome).toBe('completed')
    expect(turn).not.toHaveProperty('budgetHit')
    expect(res.cancelled()).toBe(0)
  })
})
